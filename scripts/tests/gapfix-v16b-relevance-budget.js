// The relevance span: which paragraph owes one, what a later paragraph owes instead,
// and the reviewer's natural remedy that used to be host-illegal.
//
// The failure these tests pin. The claim budget (gapfix-v16-claim-budget) lifted the
// claim obligation of every proof-bearing paragraph after the first, and left the
// other half of the same deadlock in place: each later paragraph still had to record
// a relevance span carrying at least two content words (or one of nine letters) of
// its jobNeedQuote. A later paragraph's proof sentence usually shares at most one
// word with the posting requirement it answers, so the span had to come from a
// sentence written for it: an echo of the posting's vocabulary. Independent reviewers
// flagged exactly that sentence ("echoes the posting", "abstract filler"), their
// natural remedy was to delete it, and the host refused the deletion because the
// paragraph would then have no legal relevance span. The writer could only reword the
// sentence, and the next reviewer flagged the new wording.
//
// What changed, and what each group below proves:
//   owed       only the FIRST proof-bearing paragraph owes a relevance span, counted
//              by the same helper (and so the same boundary) as the claim and the
//              transfer sentence; the number is derived from the transfer budget, so
//              a paragraph that owes the sentence can never be one that owes no span
//              to carry it
//   gate       the reviewer's remedy is legal: deleting the echo sentence of a later
//              paragraph and recording no relevance passes; the first paragraph
//              without a relevance span still fails; a relevance span a later
//              paragraph DOES record is held to the same shape as ever; its proof,
//              its jobNeedQuote and the grading of that quote against the posting
//              are unchanged
//   trap       with the old obligation (the budget rewritten to cover every paragraph
//              in a temporary copy of the module) the same trimmed paragraph is
//              rejected, and an exhaustive search of its word runs finds no span the
//              gate would have accepted: the deletion was not merely discouraged, it
//              was unanswerable
//   reporter   paragraphArgumentSpanGaps never reports a relevance gap the gate
//              would not report, and reports none for a paragraph that owes none
//   mutation   the constant, rewritten in a temporary copy, moves the gate, the
//              reporter and the printed rule together, and the transfer budget stays
//   rules      the printed budget sentences are built from the constants, say the
//              same thing as one another, and no function recounts the paragraphs
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields (parcel routing,
// clinic scheduling, library cataloguing, greenhouse growing). Nothing in production
// names any of them. Each rule is proved by flipping ONE input in a temporary
// fixture and expecting the verdict to flip, then flipping it back (A / B / C).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './testHelpers.js';
import {
  ARGUMENT_LATER_RELEVANCE_SPAN_RULE, ARGUMENT_RELEVANCE_SPAN_RULE, ARGUMENT_SPAN_BUDGET_RULES, EXPLICIT_CLAIM_BUDGET_RULE, EXPLICIT_RELEVANCE_BUDGET_RULE,
  EXPLICIT_TRANSFER_BUDGET_RULE, MAX_EXPLICIT_RELEVANCE_PARAGRAPHS, MAX_EXPLICIT_TRANSFER_PARAGRAPHS, OWING_RELEVANCE_PARAGRAPHS, checkParagraphArgumentLinks,
  explicitClaimOwed, explicitRelevanceOwed, explicitTransferOwed, paragraphArgumentSpanGaps,
} from '../../electron/ipc/coverLetterChecks.js';

// ---------------------------------------------------------------------------
// Fixtures. Each domain has an opening, three proofs and a closing. A proof offers:
//   claim    a sentence stating the capability (only the first paragraph owes one)
//   proof    a completed action from the closed proof-verb list that shares AT MOST
//            ONE content word with the posting requirement it answers
//   natural  a sentence about the target that names the requirement (the first
//            proof-bearing paragraph owes one)
//   echo     a sentence that repeats the requirement's vocabulary: the filler
//            reviewers ask to have deleted
//   ending   what the work did, sharing no content word with the requirement
//   quote    a verbatim span of the posting the proof answers
// ---------------------------------------------------------------------------
const DOMAINS = Object.freeze([
  {
    key: 'parcel routing',
    posting: 'Plan daily parcel routes for regional depots. Reconcile driver manifests against delivery scans. Reduce missed deliveries through cutoff scheduling. Coach new dispatchers on exception handling.',
    opening: 'Parcels reach a doorstep only when someone planned the route the night before, and this role plans it.',
    proofs: [
      {
        claim: 'My route planning experience began at a regional parcel depot.',
        proof: 'I built a dispatch board that depot crews used at every shift.',
        natural: 'Daily parcel routes for regional depots depend on one board that every crew reads the same way.',
        echo: 'Daily parcel routes for regional depots are what this role is built around.',
        ending: 'Crews stopped keeping side notes about late trucks.',
        quote: 'Plan daily parcel routes for regional depots.',
      },
      {
        claim: 'My manifest checking approach rests on one scan per parcel.',
        proof: 'I wrote the sign-off sheet that drivers carried on every route.',
        natural: 'Reconciling driver manifests against delivery scans is the habit this position builds.',
        echo: 'Driver manifests against delivery scans are the daily check this kind of work rests on.',
        ending: 'Disputed stops fell to a handful by the end of the quarter.',
        quote: 'Reconcile driver manifests against delivery scans.',
      },
      {
        claim: 'My scheduling practice starts from the latest pickup.',
        proof: 'I reworked the cutoff table so late pickups moved to the next window.',
        natural: 'Fewer missed deliveries through cutoff scheduling is the result this role is measured by.',
        echo: 'Missed deliveries and cutoff scheduling are what this role answers for each week.',
        ending: 'The evening trucks left with full manifests more often.',
        quote: 'Reduce missed deliveries through cutoff scheduling.',
      },
    ],
    closing: 'I welcome a conversation about your routing work.',
  },
  {
    key: 'clinic scheduling',
    posting: 'Book follow-up visits within two weeks of discharge. Maintain waiting room signage in plain language. Cut no-show rates through reminder calls. Train front desk staff on triage questions.',
    opening: 'A clinic runs on the calendar behind its front desk, and this role keeps that calendar honest.',
    proofs: [
      {
        claim: 'My discharge scheduling experience began in a hospital outpatient office.',
        proof: 'I created a recall list that nurses worked through each morning.',
        natural: 'Follow-up visits within two weeks of discharge depend on one recall list that every nurse trusts.',
        echo: 'Follow-up visits within two weeks of discharge are what this position exists to secure.',
        ending: 'Nurses stopped chasing patients from memory.',
        quote: 'Book follow-up visits within two weeks of discharge.',
      },
      {
        claim: 'My patient communication approach starts from the question people actually ask.',
        proof: 'I developed the sign set that patients read before check-in.',
        natural: 'Waiting room signage in plain language is the first thing a worried patient reads.',
        echo: 'Plain language on waiting room signage is the standard this role holds.',
        ending: 'Visitors asked for directions far less often.',
        quote: 'Maintain waiting room signage in plain language.',
      },
      {
        claim: 'My reminder practice rests on a call the day before.',
        proof: 'I reworked the call script so patients confirmed or cancelled in one minute.',
        natural: 'Lower no-show rates through reminder calls is the measure this role answers for.',
        echo: 'No-show rates and reminder calls are the weekly figures this role reviews.',
        ending: 'Open slots were refilled within the hour.',
        quote: 'Cut no-show rates through reminder calls.',
      },
    ],
    closing: 'I welcome a conversation about your scheduling work.',
  },
  {
    key: 'library cataloguing',
    posting: 'Catalogue donated collections to national standards. Digitize fragile maps with calibrated scanners. Shorten patron wait times through hold queue review. Mentor student assistants on shelving accuracy.',
    opening: 'A donated box is worth nothing to a reader until someone describes it, and this role describes it.',
    proofs: [
      {
        claim: 'My cataloguing background comes from a university special collection.',
        proof: 'I developed a record template that volunteers filled in for every box.',
        natural: 'Donated collections reach national standards only when every record starts from one template.',
        echo: 'Cataloguing donated collections to national standards is the core of this position.',
        ending: 'Volunteers needed far fewer corrections each week.',
        quote: 'Catalogue donated collections to national standards.',
      },
      {
        claim: 'My imaging practice begins with a test scan of the worst page.',
        proof: 'I configured the flatbed station that staff used for oversized sheets.',
        natural: 'Fragile maps scanned with calibrated scanners come out the same on every shift.',
        echo: 'Calibrated scanners and fragile maps are the daily concern this role carries.',
        ending: 'The backlog of folded sheets shrank steadily through spring.',
        quote: 'Digitize fragile maps with calibrated scanners.',
      },
      {
        claim: 'My circulation approach looks first at the longest wait.',
        proof: 'I reduced the hold list by retiring duplicate requests each Friday.',
        natural: 'Shorter patron wait times through hold queue review is what this job is judged on.',
        echo: 'Patron wait times and hold queue review are what this role owns.',
        ending: 'Readers received popular titles sooner.',
        quote: 'Shorten patron wait times through hold queue review.',
      },
    ],
    closing: 'I welcome a conversation about your library work.',
  },
  {
    key: 'greenhouse growing',
    posting: 'Schedule irrigation cycles for tomato houses. Log pest scouting results each week. Lower energy use through vent control. Supervise seasonal pickers during harvest.',
    opening: 'A tomato crop is decided in the hours nobody is watching, and this role watches them.',
    proofs: [
      {
        claim: 'My irrigation scheduling experience began in a commercial glasshouse.',
        proof: 'I built a watering chart that growers followed at dawn.',
        natural: 'Irrigation cycles for tomato houses run well when every grower follows one chart.',
        echo: 'Scheduling irrigation cycles for tomato houses is the heart of this position.',
        ending: 'Growers stopped overwatering the north bays.',
        quote: 'Schedule irrigation cycles for tomato houses.',
      },
      {
        claim: 'My crop monitoring approach rests on one walk per row.',
        proof: 'I wrote the scouting card that pickers filled in at the end of a row.',
        natural: 'Pest scouting results logged each week tell a grower where to look next.',
        echo: 'Each week, pest scouting results are the record this role keeps.',
        ending: 'Aphid hot spots were caught before they spread.',
        quote: 'Log pest scouting results each week.',
      },
      {
        claim: 'My climate control practice starts with the coldest hour.',
        proof: 'I reworked the vent schedule so the houses held their temperature overnight.',
        natural: 'Lower energy use through vent control is the saving this role is expected to find.',
        echo: 'Energy use and vent control are what this role answers for.',
        ending: 'The gas bill for the winter quarter came in under budget.',
        quote: 'Lower energy use through vent control.',
      },
    ],
    closing: 'I welcome a conversation about your growing work.',
  },
]);

// The shapes a proof paragraph can take.
//   first    the paragraph that owes everything: claim, proof, and a sentence about the target
//   echo     a later paragraph in the shape the old contract forced: proof, a sentence that echoes the posting, what the work did
//   trimmed  the same paragraph after a reviewer's remedy: the echo sentence deleted
function paragraphOf(proof, kind) {
  if (kind === 'first') return `${proof.claim} ${proof.proof} ${proof.natural}`;
  if (kind === 'echo') return `${proof.proof} ${proof.echo} ${proof.ending}`;
  if (kind === 'trimmed') return `${proof.proof} ${proof.ending}`;
  throw new Error(`unknown paragraph kind ${kind}`);
}

// The audit's mapping for that paragraph. A trimmed paragraph records no relevance: it has no sentence that could carry one.
function mappingOf(proof, kind) {
  if (kind === 'first') return { claim: proof.claim, proof: proof.proof, relevance: proof.natural, jobNeedQuote: proof.quote };
  if (kind === 'echo') return { proof: proof.proof, relevance: proof.echo, jobNeedQuote: proof.quote };
  if (kind === 'trimmed') return { proof: proof.proof, jobNeedQuote: proof.quote };
  throw new Error(`unknown paragraph kind ${kind}`);
}

// Opening, the three proofs in the kinds asked for, closing; and the plan the audit would record for it.
function letterOf(domain, kinds = ['first', 'trimmed', 'trimmed'], edit = () => {}) {
  const mappings = domain.proofs.map((proof, index) => ({ ...mappingOf(proof, kinds[index]) }));
  mappings.forEach((mapping, index) => edit(mapping, index));
  return {
    paragraphs: [domain.opening, ...domain.proofs.map((proof, index) => paragraphOf(proof, kinds[index])), domain.closing],
    plan: { paragraphs: [null, ...mappings, null].map(mapping => ({ argumentMapping: mapping })) },
  };
}

const gate = (domain, letter, options = {}) => checkParagraphArgumentLinks({ plan: letter.plan, paragraphs: letter.paragraphs, jobText: domain.posting, ...options });
const detailOf = check => `${check.id}: ${check.detail}`;
// The paragraph number the gate prints for proof `index` of a letter that opens on an opening.
const labelOf = index => `paragraph ${index + 2}`;
const wordRuns = paragraph => {
  const words = paragraph.split(/\s+/u).filter(Boolean);
  const runs = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= words.length; end += 1) runs.push(words.slice(start, end).join(' '));
  }
  return runs;
};

// Would the checker accept `run` as the relevance span of the SECOND proof-bearing paragraph (a later one) of a letter whose first paragraph and third are in order,
// with `quote` (by default the posting itself, the strongest quote there is: every content word of it is eligible) as the jobNeedQuote? A single-paragraph plan
// would not do: that paragraph would be the first, and owe a claim and a sentence apart from its proof, so every verdict would be a rejection for the wrong reason.
function laterSpanAccepted(checker, domain, shape, run, quote = domain.posting) {
  const letter = letterOf(domain, ['first', shape, 'echo'], (mapping, index) => { if (index === 1) { mapping.relevance = run; mapping.jobNeedQuote = quote; } });
  return checker.checkParagraphArgumentLinks({ plan: letter.plan, paragraphs: letter.paragraphs, jobText: domain.posting });
}

export default [
  {
    name: 'Relevance owed: only the first proof-bearing paragraph owes a relevance span, counted by the helper the claim and the transfer share, and the count flips with the letter (A/B/C, four domains)',
    run() {
      assert(MAX_EXPLICIT_RELEVANCE_PARAGRAPHS === 1, `the design names one paragraph (got ${MAX_EXPLICIT_RELEVANCE_PARAGRAPHS})`);
      assert(MAX_EXPLICIT_RELEVANCE_PARAGRAPHS === MAX_EXPLICIT_TRANSFER_PARAGRAPHS, 'the relevance span is the carrier of the transfer sentence, so its number is derived from that budget');
      for (const domain of DOMAINS) {
        const { paragraphs } = letterOf(domain);
        // A: the opening and the closing state no action of their own; the first proof owes it, the next two do not.
        const owed = explicitRelevanceOwed(paragraphs);
        assert(owed.join() === 'false,true,false,false,false', `${domain.key}/A: only the first proof-bearing paragraph owes a relevance span (${owed})`);
        // The three budgets read one boundary: wherever the transfer sentence is owed, a span to carry it is owed too.
        assert(explicitTransferOwed(paragraphs).join() === owed.join() && explicitClaimOwed(paragraphs).join() === owed.join(), `${domain.key}/A: the three counts agree`);
        // B: make the opening proof-bearing and the obligation moves onto it.
        const withProofOpening = [`${domain.proofs[0].proof} ${domain.opening}`, ...paragraphs.slice(1)];
        assert(explicitRelevanceOwed(withProofOpening).join() === 'true,false,false,false,false', `${domain.key}/B: a proof-bearing opening takes the slot (${explicitRelevanceOwed(withProofOpening)})`);
        assert(explicitTransferOwed(withProofOpening).join() === explicitRelevanceOwed(withProofOpening).join(), `${domain.key}/B: and the transfer sentence moves with it`);
        // C: take the proof out of the first proof paragraph (its verb leaves the closed list) and the obligation moves one paragraph later.
        const verbOutside = paragraphs.map((paragraph, index) => (index === 1 ? paragraph.replace(/\bI (built|wrote|created|developed|designed|reworked|configured|reduced)\b/u, 'I kept') : paragraph));
        assert(verbOutside[1] !== paragraphs[1] && explicitRelevanceOwed(verbOutside).join() === 'false,false,true,false,false',
          `${domain.key}/C: a paragraph whose action is outside the closed list is not counted, so the next one owes (${explicitRelevanceOwed(verbOutside)})`);
        assert(explicitRelevanceOwed([]).length === 0 && explicitRelevanceOwed(null).length === 0 && explicitRelevanceOwed(undefined).length === 0, `${domain.key}: a missing letter owes nothing`);
      }
    },
  },
  {
    name: 'Relevance gate: deleting the echo sentence of a later paragraph and recording no relevance passes, the first paragraph still owes its span, and a span a later paragraph records is held to the same shape (A/B/C/D/E, four domains)',
    run() {
      for (const domain of DOMAINS) {
        // A: the letter the old contract forced (every later paragraph records the echo as its relevance) still passes, and so does the trimmed one.
        const echoed = letterOf(domain, ['first', 'echo', 'echo']);
        assert(gate(domain, echoed).passed, `${domain.key}/A: a letter whose later paragraphs record their echo sentence passes (${detailOf(gate(domain, echoed))})`);
        const trimmed = letterOf(domain);
        assert(gate(domain, trimmed).passed, `${domain.key}/A: the same letter with the echo sentences deleted and no relevance recorded passes (${detailOf(gate(domain, trimmed))})`);
        // The deleted sentences really were the only thing that named the requirement: the trimmed paragraphs share at most one content word with their quote.
        for (const [index, proof] of domain.proofs.entries()) {
          if (index === 0) continue;
          const paragraph = paragraphOf(proof, 'trimmed');
          const probe = checkParagraphArgumentLinks({
            plan: { paragraphs: [{ argumentMapping: { proof: proof.proof, relevance: paragraph, jobNeedQuote: proof.quote } }] }, paragraphs: [paragraph], jobText: domain.posting,
          });
          assert(!probe.passed && probe.detail.includes('does not name a concrete responsibility from its jobNeedQuote'),
            `${domain.key}/A: the trimmed paragraph ${index + 1} names no responsibility of its quote, so recording its whole text would not rescue it (${detailOf(probe)})`);
        }

        // B: the first proof paragraph still owes a relevance span, and only it is named.
        const noFirst = letterOf(domain, ['first', 'trimmed', 'trimmed'], (mapping, index) => { if (index === 0) delete mapping.relevance; });
        const missing = gate(domain, noFirst);
        assert(!missing.passed && missing.detail.includes(`${labelOf(0)} argumentMapping.relevance is missing`) && !missing.detail.includes(`${labelOf(1)} argumentMapping.relevance`)
          && !missing.detail.includes(`${labelOf(2)} argumentMapping.relevance`), `${domain.key}/B: the first proof paragraph owes its relevance and only it (${detailOf(missing)})`);
        for (const blank of ['', '   ', null, undefined]) {
          const blanked = letterOf(domain, ['first', 'trimmed', 'trimmed'], (mapping, index) => { if (index === 0) mapping.relevance = blank; });
          assert(!gate(domain, blanked).passed, `${domain.key}/B: a blank relevance (${JSON.stringify(blank)}) is a missing relevance in the paragraph that owes one`);
        }
        assert(gate(domain, letterOf(domain)).passed, `${domain.key}/B: restoring the relevance passes again`);

        // C: a later paragraph leaves its relevance out in every way a response can: absent, empty, blank, null.
        for (const blank of ['absent', '', '   ', null]) {
          const omitted = letterOf(domain, ['first', 'echo', 'echo'], (mapping, index) => {
            if (index === 0) return;
            if (blank === 'absent') delete mapping.relevance; else mapping.relevance = blank;
          });
          assert(gate(domain, omitted).passed, `${domain.key}/C: later paragraphs that omit the relevance (${blank === 'absent' ? 'field absent' : JSON.stringify(blank)}) pass (${detailOf(gate(domain, omitted))})`);
        }
        // ... and the claim and the relevance may both go: the later paragraph owes its proof and its quote.
        const proofOnly = letterOf(domain, ['first', 'trimmed', 'trimmed'], (mapping, index) => { if (index > 0) { delete mapping.claim; delete mapping.relevance; } });
        assert(gate(domain, proofOnly).passed && Object.keys(proofOnly.plan.paragraphs[2].argumentMapping).sort().join() === 'jobNeedQuote,proof', `${domain.key}/C: a later paragraph records only proof and jobNeedQuote`);

        // D: a relevance span a later paragraph DOES record is held to the same shape as before.
        const second = domain.proofs[1];
        const withRelevance = relevance => letterOf(domain, ['first', 'echo', 'trimmed'], (mapping, index) => { if (index === 1) mapping.relevance = relevance; });
        const rejections = [
          ['a span the paragraph does not contain', 'Quarterly sunsets inspire nobody on the pavement.', `${labelOf(1)} argumentMapping.relevance is not an exact normalized span`],
          ['a span that names no responsibility of the quote', second.ending, `${labelOf(1)} argumentMapping.relevance does not name a concrete responsibility from its jobNeedQuote`],
          ['a generic relevance label', 'This experience is highly relevant and valuable to the role.', `${labelOf(1)} argumentMapping.relevance`],
        ];
        for (const [what, relevance, expected] of rejections) {
          const verdict = gate(domain, withRelevance(relevance));
          assert(!verdict.passed && verdict.detail.includes(expected), `${domain.key}/D: ${what} is still rejected in a later paragraph (${detailOf(verdict)})`);
        }
        const cutInside = gate(domain, withRelevance(second.echo.slice(0, -2)));
        assert(!cutInside.passed && cutInside.detail.includes(`${labelOf(1)} argumentMapping.relevance begins or ends inside a word`), `${domain.key}/D: a span cut inside a word is still rejected (${detailOf(cutInside)})`);
        // The flipped control: the echo, recorded whole, passes; so does any span that carries two terms of the quote.
        assert(gate(domain, withRelevance(second.echo)).passed, `${domain.key}/D: the well-formed echo passes`);
        // A span in a later paragraph needs no sentence apart from the proof: the proof sentence plus the echo, as one span, passes too.
        assert(gate(domain, withRelevance(`${second.proof} ${second.echo}`)).passed, `${domain.key}/D: a later span may reach back into the proof sentence`);

        // E: the other obligations of a later paragraph are untouched: its proof, its jobNeedQuote, and the quote's occurrence in the posting.
        const noQuote = gate(domain, letterOf(domain, ['first', 'trimmed', 'trimmed'], (mapping, index) => { if (index === 1) delete mapping.jobNeedQuote; }));
        assert(!noQuote.passed && noQuote.detail.includes(`${labelOf(1)} argumentMapping.jobNeedQuote is missing`), `${domain.key}/E: a later paragraph still owes its jobNeedQuote (${detailOf(noQuote)})`);
        const foreignQuote = gate(domain, letterOf(domain, ['first', 'trimmed', 'trimmed'], (mapping, index) => { if (index === 1) mapping.jobNeedQuote = 'Water the ficus on Thursdays.'; }));
        assert(!foreignQuote.passed && foreignQuote.detail.includes(`${labelOf(1)} argumentMapping.jobNeedQuote does not occur`), `${domain.key}/E: and it is still graded against the posting (${detailOf(foreignQuote)})`);
        const noProof = gate(domain, letterOf(domain, ['first', 'trimmed', 'trimmed'], (mapping, index) => { if (index === 2) delete mapping.proof; }));
        assert(!noProof.passed && noProof.detail.includes(`${labelOf(2)} argumentMapping.proof is missing`), `${domain.key}/E: and it still owes its proof (${detailOf(noProof)})`);
        const noMapping = letterOf(domain);
        noMapping.plan.paragraphs[2].argumentMapping = null;
        assert(!gate(domain, noMapping).passed && gate(domain, noMapping).detail.includes('paragraph 3 contains a candidate past action but has no argumentMapping'), `${domain.key}/E: a proof-bearing paragraph with no mapping at all still fails`);

        // F: the obligation follows position, not identity. Put the paragraph with no relevance FIRST and it owes one.
        const swapped = {
          paragraphs: [domain.opening, paragraphOf(domain.proofs[1], 'trimmed'), paragraphOf(domain.proofs[0], 'first'), domain.closing],
          plan: { paragraphs: [null, { ...mappingOf(domain.proofs[1], 'trimmed') }, { ...mappingOf(domain.proofs[0], 'first') }, null].map(mapping => ({ argumentMapping: mapping })) },
        };
        const swappedVerdict = gate(domain, swapped);
        assert(!swappedVerdict.passed && swappedVerdict.detail.includes('paragraph 2 argumentMapping.relevance is missing') && !swappedVerdict.detail.includes('paragraph 3 argumentMapping.relevance is missing'),
          `${domain.key}/F: the relevance obligation moves with the position (${detailOf(swappedVerdict)})`);
      }
    },
  },
  {
    name: 'Relevance trap: with the old obligation (the budget covering every paragraph, in a temporary copy of the module) the trimmed letter is rejected and no span of the trimmed paragraph could have rescued it (A/B/C, four domains)',
    async run() {
      const source = fs.readFileSync(path.resolve('electron/ipc/coverLetterChecks.js'), 'utf8');
      const declaration = 'export const MAX_EXPLICIT_RELEVANCE_PARAGRAPHS = MAX_EXPLICIT_TRANSFER_PARAGRAPHS;';
      assert(source.split(declaration).length === 2, 'the relevance number is declared once, so the mutation changes the one declaration');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-trap-'));
      try {
        const toAbsolute = text => text.replace(/from '(\.\/[^']+)'/gu, (_, relative) => `from '${pathToFileURL(path.resolve('electron/ipc', relative)).href}'`);
        const file = path.join(dir, 'old.mjs');
        fs.writeFileSync(file, toAbsolute(source.replace(declaration, 'export const MAX_EXPLICIT_RELEVANCE_PARAGRAPHS = 99;')), 'utf8');
        const old = await import(`${pathToFileURL(file).href}?v=old`);
        for (const domain of DOMAINS) {
          const trimmed = letterOf(domain);
          // A: the old obligation rejects the trimmed letter, naming both later paragraphs, and the real gate accepts it.
          const rejected = old.checkParagraphArgumentLinks({ plan: trimmed.plan, paragraphs: trimmed.paragraphs, jobText: domain.posting });
          assert(!rejected.passed && rejected.detail.includes(`${labelOf(1)} argumentMapping.relevance is missing`) && rejected.detail.includes(`${labelOf(2)} argumentMapping.relevance is missing`),
            `${domain.key}/A: under the old obligation the trimmed letter is rejected for both later paragraphs (${detailOf(rejected)})`);
          assert(gate(domain, trimmed).passed, `${domain.key}/A: and the real gate accepts it`);
          // B: the old trap was closed: no word run of a trimmed later paragraph is a relevance span the old gate would accept, with the posting itself as the quote.
          // Every posting requirement as the quote, every word run as the span: the exhaustive search a reviewer ran on a live letter.
          const requirements = domain.posting.split(/(?<=\.)\s+/u);
          const trimmedParagraph = paragraphOf(domain.proofs[1], 'trimmed');
          const runs = wordRuns(trimmedParagraph);
          for (const requirement of requirements) {
            for (const run of runs) {
              const verdict = laterSpanAccepted(old, domain, 'trimmed', run, requirement);
              assert(!verdict.passed, `${domain.key}/B: under the old obligation no span of the trimmed paragraph was a legal relevance to “${requirement}” (“${run}”): ${detailOf(verdict)}`);
            }
          }
          // The search is not vacuous: the same search on the paragraph that carries the echo sentence finds the span the old contract forced.
          const echoParagraph = paragraphOf(domain.proofs[1], 'echo');
          assert(wordRuns(echoParagraph).some(run => laterSpanAccepted(old, domain, 'echo', run, domain.proofs[1].quote).passed), `${domain.key}/B: the same search finds a legal span once the echo sentence is back`);
          assert(requirements.length === 4 && runs.length > 10, `${domain.key}/B: the search covered ${requirements.length} requirements and ${runs.length} spans`);
          // C: put the echo sentence back and the old obligation is met, which is the only way it ever was.
          const echoed = letterOf(domain, ['first', 'echo', 'echo']);
          assert(old.checkParagraphArgumentLinks({ plan: echoed.plan, paragraphs: echoed.paragraphs, jobText: domain.posting }).passed, `${domain.key}/C: with the echo sentences the old obligation is met`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Relevance reporter: the drafting-stage reporter reports no relevance gap for a paragraph that owes none, and every gap it reports is one no relevance span could close (subset, brute force over every word run, four domains)',
    run() {
      for (const domain of DOMAINS) {
        const proof = domain.proofs[1];
        const trimmed = paragraphOf(proof, 'trimmed');
        const echoed = paragraphOf(proof, 'echo');
        const relevanceGap = (paragraph, options) => paragraphArgumentSpanGaps(paragraph, domain.posting, options).some(gap => gap.field === 'relevance');
        // A: a later paragraph owes nothing, whatever it offers: neither shape is reported when the count says it owes none.
        const owed = { owesTransfer: false, owesClaim: false, owesRelevance: false };
        assert(!relevanceGap(trimmed, owed) && !relevanceGap(echoed, owed), `${domain.key}/A: a paragraph that owes no relevance span is never reported for one`);
        assert(paragraphArgumentSpanGaps(trimmed, domain.posting, owed).length === 0, `${domain.key}/A: and has no gap of any field`);
        // B: the default is the old behaviour, so a caller that does not pass the count is never more lenient than the gate; only an explicit false relaxes it.
        const posting = 'Water the ficus on Thursdays. Polish the brass handles.';
        assert(paragraphArgumentSpanGaps(trimmed, posting, { owesTransfer: false, owesClaim: false }).some(gap => gap.field === 'relevance'), `${domain.key}/B: without the count the reporter still asks a later paragraph for a span that names something`);
        assert(paragraphArgumentSpanGaps(trimmed, posting).some(gap => gap.field === 'relevance'), `${domain.key}/B: with no options at all it still asks`);
        assert(!paragraphArgumentSpanGaps(trimmed, posting, { owesTransfer: false, owesClaim: false, owesRelevance: false }).some(gap => gap.field === 'relevance'), `${domain.key}/B: only an explicit false relaxes it`);
        // C: the subset relation. Whenever the reporter, asked as the gate would ask (the paragraph owes a span), reports a gap, the gate rejects EVERY relevance span
        // the paragraph could offer with the posting itself as the quote (the strongest quote there is); and when it reports none, one of them passes.
        for (const [shape, paragraph] of [['trimmed', trimmed], ['echo', echoed]]) {
          const gaps = paragraphArgumentSpanGaps(paragraph, domain.posting, { owesTransfer: false, owesClaim: false, owesRelevance: true }).filter(gap => gap.field === 'relevance');
          const accepted = wordRuns(paragraph).filter(run => laterSpanAccepted({ checkParagraphArgumentLinks }, domain, shape, run).passed);
          assert((gaps.length > 0) === (accepted.length === 0), `${domain.key}/C/${shape}: the reporter's verdict (${gaps.length} gap) matches the gate's search (${accepted.length} legal spans)`);
          if (gaps.length) assert(gaps[0].rule === ARGUMENT_LATER_RELEVANCE_SPAN_RULE, `${domain.key}/C/${shape}: a gap in a paragraph that owes a span but not the sentence carries the later rule`);
        }
        // D: a paragraph that owes the sentence apart from its proof is held to the stricter rule, whatever the span budget says.
        const owing = paragraphArgumentSpanGaps(proof.proof, domain.posting, { owesTransfer: true, owesClaim: false, owesRelevance: true }).filter(gap => gap.field === 'relevance');
        assert(owing.length === 1 && owing[0].rule === ARGUMENT_RELEVANCE_SPAN_RULE, `${domain.key}/D: a lone proof sentence owes the sentence apart from itself (${JSON.stringify(owing.map(gap => gap.field))})`);
        // An opening and a closing owe nothing, whatever the flags say.
        assert(paragraphArgumentSpanGaps(domain.opening, domain.posting, { owesRelevance: true }).length === 0 && paragraphArgumentSpanGaps(domain.closing, domain.posting, { owesRelevance: true }).length === 0, `${domain.key}: an opening and a closing owe nothing`);
      }
    },
  },
  {
    name: 'Relevance mutation: rewriting the constant to two in a temporary copy of the module moves the gate, the reporter and the printed rule together, and the transfer budget and the real module stay (A/B/C)',
    async run() {
      const source = fs.readFileSync(path.resolve('electron/ipc/coverLetterChecks.js'), 'utf8');
      const declaration = 'export const MAX_EXPLICIT_RELEVANCE_PARAGRAPHS = MAX_EXPLICIT_TRANSFER_PARAGRAPHS;';
      assert(source.split(declaration).length === 2, 'the constant is declared once, so the mutation changes the one number');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-budget-mutation-'));
      try {
        const toAbsolute = text => text.replace(/from '(\.\/[^']+)'/gu, (_, relative) => `from '${pathToFileURL(path.resolve('electron/ipc', relative)).href}'`);
        const load = async (name, mutate) => {
          const file = path.join(dir, `${name}.mjs`);
          fs.writeFileSync(file, toAbsolute(mutate(source)), 'utf8');
          return import(`${pathToFileURL(file).href}?v=${name}`);
        };
        const control = await load('control', text => text);
        const two = await load('two', text => text.replace(declaration, 'export const MAX_EXPLICIT_RELEVANCE_PARAGRAPHS = 2;'));
        assert(control.MAX_EXPLICIT_RELEVANCE_PARAGRAPHS === 1 && two.MAX_EXPLICIT_RELEVANCE_PARAGRAPHS === 2, 'the copy really carries the other number');
        for (const domain of DOMAINS) {
          const letter = letterOf(domain);
          // A: the count follows the number.
          assert(control.explicitRelevanceOwed(letter.paragraphs).join() === 'false,true,false,false,false', `${domain.key}/A: the unmutated copy owes one`);
          assert(two.explicitRelevanceOwed(letter.paragraphs).join() === 'false,true,true,false,false', `${domain.key}/A: the mutated copy owes two (${two.explicitRelevanceOwed(letter.paragraphs)})`);
          // B: the gate follows the count. The trimmed letter passes at one and fails at two (naming only the second paragraph); recording the span passes at two.
          const verdictOne = control.checkParagraphArgumentLinks({ plan: letter.plan, paragraphs: letter.paragraphs, jobText: domain.posting });
          const verdictTwo = two.checkParagraphArgumentLinks({ plan: letter.plan, paragraphs: letter.paragraphs, jobText: domain.posting });
          assert(verdictOne.passed && !verdictTwo.passed && verdictTwo.detail.includes(`${labelOf(1)} argumentMapping.relevance is missing`) && !verdictTwo.detail.includes(`${labelOf(2)} argumentMapping.relevance`),
            `${domain.key}/B: the second paragraph's relevance is owed at two and not at one (${detailOf(verdictTwo)})`);
          const supplied = letterOf(domain, ['first', 'echo', 'trimmed']);
          assert(two.checkParagraphArgumentLinks({ plan: supplied.plan, paragraphs: supplied.paragraphs, jobText: domain.posting }).passed, `${domain.key}/B: supplying the second relevance passes at two`);
          // C: the reporter follows the count the caller reads from the same module.
          const bare = letter.paragraphs[2];
          const unrelated = 'Water the ficus on Thursdays. Polish the brass handles.';
          const reportedOne = control.paragraphArgumentSpanGaps(bare, unrelated, { owesTransfer: false, owesClaim: false, owesRelevance: control.explicitRelevanceOwed(letter.paragraphs)[2] });
          const reportedTwo = two.paragraphArgumentSpanGaps(bare, unrelated, { owesTransfer: false, owesClaim: false, owesRelevance: two.explicitRelevanceOwed(letter.paragraphs)[2] });
          assert(!reportedOne.some(gap => gap.field === 'relevance') && reportedTwo.some(gap => gap.field === 'relevance'), `${domain.key}/C: the reporter reports the second paragraph at two and not at one`);
        }
        assert(control.OWING_RELEVANCE_PARAGRAPHS === 'the first proof-bearing paragraph of the letter' && control.EXPLICIT_RELEVANCE_BUDGET_RULE.startsWith('only the first proof-bearing paragraph of the letter owes a relevance span'),
          `the real number prints as one paragraph (${control.EXPLICIT_RELEVANCE_BUDGET_RULE})`);
        assert(two.OWING_RELEVANCE_PARAGRAPHS === 'each of the first 2 proof-bearing paragraphs of the letter' && two.EXPLICIT_RELEVANCE_BUDGET_RULE.includes('each of the first 2 proof-bearing paragraphs of the letter')
          && two.EXPLICIT_RELEVANCE_BUDGET_RULE !== control.EXPLICIT_RELEVANCE_BUDGET_RULE && two.ARGUMENT_SPAN_BUDGET_RULES.includes(two.EXPLICIT_RELEVANCE_BUDGET_RULE),
        `the printed rule follows the number (${two.EXPLICIT_RELEVANCE_BUDGET_RULE})`);
        // The relevance number is its own: moving it leaves the transfer budget, the claim budget and their printed rules where they were.
        assert(two.MAX_EXPLICIT_TRANSFER_PARAGRAPHS === 1 && two.EXPLICIT_TRANSFER_BUDGET_RULE === EXPLICIT_TRANSFER_BUDGET_RULE && two.EXPLICIT_CLAIM_BUDGET_RULE === EXPLICIT_CLAIM_BUDGET_RULE
          && two.explicitTransferOwed(letterOf(DOMAINS[0]).paragraphs).join() === 'false,true,false,false,false' && two.ARGUMENT_RELEVANCE_SPAN_RULE === ARGUMENT_RELEVANCE_SPAN_RULE,
        'the transfer and claim budgets do not move with the relevance budget');
        // The module under test is untouched.
        assert(MAX_EXPLICIT_RELEVANCE_PARAGRAPHS === 1 && OWING_RELEVANCE_PARAGRAPHS === 'the first proof-bearing paragraph of the letter' && EXPLICIT_RELEVANCE_BUDGET_RULE === control.EXPLICIT_RELEVANCE_BUDGET_RULE,
          'the real module is unchanged by the temporary copies');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },];
