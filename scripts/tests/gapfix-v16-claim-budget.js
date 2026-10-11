// The claim span: which paragraph owes one, what a writer is told one is, and
// the introduction of a prior employer by role.
//
// The failure these tests pin: the argument gate demanded a claim span (the
// candidate capability, in a closed grammar) in EVERY proof-bearing paragraph.
// A claim is the most abstract span a paragraph carries, so a letter of three
// proofs held three abstractions about the candidate on top of the three things
// the candidate did. The host would not let a writer delete one (a paragraph
// without a claim span was a claim gap), so the only repair open to a writer
// told that an abstract sentence is unexplained was to reword it, and the next
// reviewer flagged the new wording. The transfer sentence had a budget
// (MAX_EXPLICIT_TRANSFER_PARAGRAPHS); the claim had none.
//
// What changed, and what each group below proves:
//   owed       only the FIRST proof-bearing paragraph owes a claim span
//              (MAX_EXPLICIT_CLAIM_PARAGRAPHS is one), counted by one function
//              the gate and the drafting-stage reporter both read
//   gate       a first proof paragraph without a claim fails; a later one
//              without a claim passes; a later claim that is malformed still
//              fails; a later claim that is well formed (standalone or inline in
//              the proof sentence) passes
//   reporter   paragraphArgumentSpanGaps never reports a claim gap the gate
//              would accept, and reports every one the gate cannot accept
//   mutation   the constant, rewritten to two in a temporary copy of the
//              module, moves the gate, the reporter and the printed rule
//   rule       the printed claim rule says a claim may be a short inline phrase
//              naming the capability with the nouns of the cited evidence, the
//              grammar it closes over is unchanged, and vacuous text still has
//              no claim span (the cue was NOT widened)
//   employer   a prior employer introduced by a role noun ("<modifiers> role at
//              X") is accepted, a bare "At X, I ..." is still rejected, and
//              removing the role noun brings the rejection back
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields (county road
// inspection, grocery demand analytics, municipal water testing, school bus
// operations). Nothing in production names any of them. Each rule is proved by
// flipping ONE input in a temporary fixture and expecting the verdict to flip,
// then flipping it back (A / B / C).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './testHelpers.js';
import {
  ARGUMENT_CLAIM_SPAN_RULE, EXPLICIT_CLAIM_BUDGET_RULE, EXPLICIT_TRANSFER_BUDGET_RULE, MAX_EXPLICIT_CLAIM_PARAGRAPHS, MAX_EXPLICIT_TRANSFER_PARAGRAPHS,
  OWING_CLAIM_PARAGRAPHS, checkParagraphArgumentLinks, checkPriorEmployerOpening, explicitClaimOwed, explicitTransferOwed, paragraphArgumentSpanGaps,
} from '../../electron/ipc/coverLetterChecks.js';

// ---------------------------------------------------------------------------
// Fixtures. Each domain has an opening that makes no claim of its own, three
// proofs, and a closing. A proof offers:
//   claim       a standalone sentence stating the capability
//   proof       a completed action from the closed proof-verb list
//   natural     a sentence about the target in natural wording (the FIRST
//               proof-bearing paragraph owes one)
//   ending      what the work did (every later paragraph ends on this)
//   inline      one sentence that carries a claim phrase INSIDE the proof
//               sentence: { sentence, claim, proof } where claim and proof are
//               exact spans of the sentence
//   quote       a verbatim span of the posting the proof answers
// ---------------------------------------------------------------------------
const DOMAINS = Object.freeze([
  {
    key: 'county road inspection',
    posting: 'Inspect culvert crossings on county roads each spring. Score pavement condition with consistent survey sheets. Reduce flood closures through drainage maintenance planning. Brief the commissioners on repair priorities.',
    opening: 'County roads depend on culverts that drain before the spring melt, and this role keeps that work on schedule.',
    proofs: [
      {
        claim: 'My culvert inspection practice began on a county road crew.',
        proof: 'I built a crossing checklist that crews used at every culvert.',
        natural: 'Inspecting culvert crossings on county roads each spring depends on one checklist that every crew follows the same way.',
        ending: 'Crews finished a crossing in half the time once the checklist was printed.',
        inline: {
          sentence: 'Drawing on my culvert inspection experience, I built a crossing checklist that crews used at every culvert.',
          claim: 'my culvert inspection experience', proof: 'I built a crossing checklist that crews used at every culvert',
        },
        quote: 'Inspect culvert crossings on county roads each spring.',
      },
      {
        claim: 'My survey scoring approach rests on one sheet per road segment.',
        proof: 'I wrote the survey sheet that inspectors used to score pavement condition on every segment.',
        natural: 'Scoring pavement condition with consistent survey sheets is the habit this position builds.',
        ending: 'Scores from different inspectors began to match within a week.',
        inline: {
          sentence: 'With my pavement scoring experience, I wrote the survey sheet that inspectors used to score pavement condition on every segment.',
          claim: 'my pavement scoring experience', proof: 'I wrote the survey sheet that inspectors used to score pavement condition on every segment',
        },
        quote: 'Score pavement condition with consistent survey sheets.',
      },
      {
        claim: 'My drainage planning practice starts from last year’s closures.',
        proof: 'I reworked the drainage maintenance plan so flood closures fell after heavy storms.',
        natural: 'Fewer flood closures through drainage maintenance planning is the result this role is measured by.',
        ending: 'The county reopened two crossings sooner than the year before.',
        inline: {
          sentence: 'Using my drainage planning skill, I reworked the drainage maintenance plan so flood closures fell after heavy storms.',
          claim: 'my drainage planning skill', proof: 'I reworked the drainage maintenance plan so flood closures fell after heavy storms',
        },
        quote: 'Reduce flood closures through drainage maintenance planning.',
      },
    ],
    closing: 'I welcome a conversation about your road inspection work.',
  },
  {
    key: 'grocery demand analytics',
    posting: 'Forecast weekly demand for grocery departments. Maintain dashboards with accurate sales figures. Reduce stockouts through reorder planning. Present findings to store managers.',
    opening: 'Grocery departments live on forecasts that arrive before the truck does, and this role owns those forecasts.',
    proofs: [
      {
        claim: 'My demand forecasting experience started in a grocery back office.',
        proof: 'I built a weekly forecast workbook that covered every grocery department.',
        natural: 'Weekly demand for grocery departments is forecast well only when every department feeds one workbook.',
        ending: 'Department leads stopped keeping their own side spreadsheets.',
        inline: {
          sentence: 'Drawing on my demand forecasting background, I built a weekly forecast workbook that covered every grocery department.',
          claim: 'my demand forecasting background', proof: 'I built a weekly forecast workbook that covered every grocery department',
        },
        quote: 'Forecast weekly demand for grocery departments.',
      },
      {
        claim: 'My dashboard approach keeps one source for every figure.',
        proof: 'I created a sales dashboard with accurate figures that store managers opened each morning.',
        natural: 'Dashboards with accurate sales figures are the first thing a store manager reads.',
        ending: 'Managers quoted the same sales figures in every meeting.',
        inline: {
          sentence: 'Using my dashboard design skill, I created a sales dashboard with accurate figures that store managers opened each morning.',
          claim: 'my dashboard design skill', proof: 'I created a sales dashboard with accurate figures that store managers opened each morning',
        },
        quote: 'Maintain dashboards with accurate sales figures.',
      },
      {
        claim: 'My replenishment practice begins with the emptiest shelf.',
        proof: 'I reworked the reorder plan so stockouts fell in the produce aisle.',
        natural: 'Reorder planning that reduces stockouts is the lever a department lead controls.',
        ending: 'Produce shelves stayed full through the holiday week.',
        inline: {
          sentence: 'With my replenishment judgment, I reworked the reorder plan so stockouts fell in the produce aisle.',
          claim: 'my replenishment judgment', proof: 'I reworked the reorder plan so stockouts fell in the produce aisle',
        },
        quote: 'Reduce stockouts through reorder planning.',
      },
    ],
    closing: 'I welcome a conversation about your analytics work.',
  },
  {
    key: 'municipal water testing',
    posting: 'Test municipal water samples against state limits. Maintain lab instrument calibration logs. Reduce reporting delays through batch scheduling. Train new technicians on sampling procedures.',
    opening: 'Safe tap water is a record before it is a result, and this role keeps the record complete.',
    proofs: [
      {
        claim: 'My sample testing background comes from a county water lab.',
        proof: 'I developed a sample intake routine that logged every municipal water sample on arrival.',
        natural: 'Testing municipal water samples against state limits starts with an intake log that nobody skips.',
        ending: 'No sample waited overnight without a recorded owner.',
        inline: {
          sentence: 'Drawing on my sample testing background, I developed a sample intake routine that logged every municipal water sample on arrival.',
          claim: 'my sample testing background', proof: 'I developed a sample intake routine that logged every municipal water sample on arrival',
        },
        quote: 'Test municipal water samples against state limits.',
      },
      {
        claim: 'My calibration practice treats every log as evidence.',
        proof: 'I wrote the calibration log template that technicians completed for each lab instrument.',
        natural: 'Calibration logs for every lab instrument are what an auditor asks to see first.',
        ending: 'An audit that once took a day closed in an hour.',
        inline: {
          sentence: 'Applying my instrument calibration skill, I wrote the calibration log template that technicians completed for each lab instrument.',
          claim: 'my instrument calibration skill', proof: 'I wrote the calibration log template that technicians completed for each lab instrument',
        },
        quote: 'Maintain lab instrument calibration logs.',
      },
      {
        claim: 'My scheduling approach groups samples by test type.',
        proof: 'I reworked the batch schedule so reporting delays shrank during the summer rush.',
        natural: 'Shorter reporting delays through batch scheduling is what the utility asks of this role.',
        ending: 'Results reached the utility a day earlier on heavy weeks.',
        inline: {
          sentence: 'Using my batch scheduling experience, I reworked the batch schedule so reporting delays shrank during the summer rush.',
          claim: 'my batch scheduling experience', proof: 'I reworked the batch schedule so reporting delays shrank during the summer rush',
        },
        quote: 'Reduce reporting delays through batch scheduling.',
      },
    ],
    closing: 'I welcome a conversation about your laboratory work.',
  },
  {
    key: 'school bus operations',
    posting: 'Plan morning bus routes for rural school districts. Track driver certifications with accurate renewal dates. Reduce late arrivals through depot staging. Brief substitute drivers before each shift.',
    opening: 'A school day starts at the depot long before the first bell, and this role plans that start.',
    proofs: [
      {
        claim: 'My route planning experience grew out of a rural bus depot.',
        proof: 'I designed a morning route map that grouped stops by hollow and by bell time.',
        natural: 'Planning morning bus routes for rural school districts starts from where the children actually wait.',
        ending: 'Drivers stopped doubling back on the longest hollow.',
        inline: {
          sentence: 'Drawing on my route planning experience, I designed a morning route map that grouped stops by hollow and by bell time.',
          claim: 'my route planning experience', proof: 'I designed a morning route map that grouped stops by hollow and by bell time',
        },
        quote: 'Plan morning bus routes for rural school districts.',
      },
      {
        claim: 'My records approach keeps every renewal date in one place.',
        proof: 'I created a certification tracker that listed accurate renewal dates for each driver.',
        natural: 'Tracking driver certifications with accurate renewal dates keeps a route from losing its driver.',
        ending: 'No driver reached a renewal date unnoticed.',
        inline: {
          sentence: 'With my certification tracking skill, I created a certification tracker that listed accurate renewal dates for each driver.',
          claim: 'my certification tracking skill', proof: 'I created a certification tracker that listed accurate renewal dates for each driver',
        },
        quote: 'Track driver certifications with accurate renewal dates.',
      },
      {
        claim: 'My staging practice starts with the first bus out.',
        proof: 'I reworked the depot staging plan so late arrivals dropped on icy mornings.',
        natural: 'Fewer late arrivals through depot staging is the result the district reads each week.',
        ending: 'The first bell found every route staffed and rolling.',
        inline: {
          sentence: 'Using my depot staging judgment, I reworked the depot staging plan so late arrivals dropped on icy mornings.',
          claim: 'my depot staging judgment', proof: 'I reworked the depot staging plan so late arrivals dropped on icy mornings',
        },
        quote: 'Reduce late arrivals through depot staging.',
      },
    ],
    closing: 'I welcome a conversation about your transportation work.',
  },
]);

// The shapes a proof paragraph can take.
//   first      the paragraph that owes everything: claim sentence, proof, a sentence about the target
//   bare       a later paragraph with no claim at all: proof, then what the work did
//   inline     a later paragraph whose claim is a phrase INSIDE the proof sentence
//   standalone a later paragraph that still states its claim as its own sentence (the old shape)
function paragraphOf(proof, kind) {
  if (kind === 'first') return `${proof.claim} ${proof.proof} ${proof.natural}`;
  if (kind === 'bare') return `${proof.proof} ${proof.ending}`;
  if (kind === 'inline') return `${proof.inline.sentence} ${proof.ending}`;
  if (kind === 'standalone') return `${proof.claim} ${proof.proof} ${proof.ending}`;
  throw new Error(`unknown paragraph kind ${kind}`);
}

// The audit's mapping for that paragraph. A later paragraph's relevance is its
// proof sentence, which names the responsibility and needs no sentence about the
// target.
function mappingOf(proof, kind) {
  if (kind === 'first') return { claim: proof.claim, proof: proof.proof, relevance: proof.natural, jobNeedQuote: proof.quote };
  if (kind === 'bare') return { proof: proof.proof, relevance: proof.proof, jobNeedQuote: proof.quote };
  if (kind === 'inline') return { claim: proof.inline.claim, proof: proof.inline.proof, relevance: proof.inline.proof, jobNeedQuote: proof.quote };
  if (kind === 'standalone') return { claim: proof.claim, proof: proof.proof, relevance: proof.proof, jobNeedQuote: proof.quote };
  throw new Error(`unknown paragraph kind ${kind}`);
}

// Opening, the three proofs in the kinds asked for, closing; and the plan the audit would record for it.
function letterOf(domain, kinds = ['first', 'bare', 'bare'], edit = () => {}) {
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

export default [
  {
    name: 'Claim owed: only the first proof-bearing paragraph owes a claim span, counted by one function over the letter in order, and the count flips with the letter (A/B/C, four domains)',
    run() {
      assert(MAX_EXPLICIT_CLAIM_PARAGRAPHS === 1, `the design names one paragraph (got ${MAX_EXPLICIT_CLAIM_PARAGRAPHS})`);
      for (const domain of DOMAINS) {
        const { paragraphs } = letterOf(domain);
        // A: the opening and the closing state no action of their own; the first proof owes it, the next two do not.
        const owed = explicitClaimOwed(paragraphs);
        assert(owed.join() === 'false,true,false,false,false', `${domain.key}/A: only the first proof-bearing paragraph owes a claim (${owed})`);
        // The claim count and the transfer count are two numbers that happen to be equal; they read the same boundary.
        assert(MAX_EXPLICIT_TRANSFER_PARAGRAPHS === MAX_EXPLICIT_CLAIM_PARAGRAPHS && explicitTransferOwed(paragraphs).join() === owed.join(), `${domain.key}/A: both budgets count the same paragraph`);
        // B: make the opening proof-bearing and the obligation moves onto it.
        const withProofOpening = [`${domain.proofs[0].proof} ${domain.opening}`, ...paragraphs.slice(1)];
        assert(explicitClaimOwed(withProofOpening).join() === 'true,false,false,false,false', `${domain.key}/B: a proof-bearing opening takes the slot (${explicitClaimOwed(withProofOpening)})`);
        // C: take the proof out of the first proof paragraph (its verb leaves the closed list) and the obligation moves one paragraph later.
        const verbOutside = paragraphs.map((paragraph, index) => (index === 1 ? paragraph.replace(/\bI (built|wrote|created|developed|designed|reworked)\b/u, 'I kept') : paragraph));
        assert(verbOutside[1] !== paragraphs[1] && explicitClaimOwed(verbOutside).join() === 'false,false,true,false,false',
          `${domain.key}/C: a paragraph whose action is outside the closed list is not counted, so the next one owes (${explicitClaimOwed(verbOutside)})`);
        assert(explicitClaimOwed([]).length === 0 && explicitClaimOwed(null).length === 0 && explicitClaimOwed(undefined).length === 0, `${domain.key}: a missing letter owes nothing`);
      }
    },
  },
  {
    name: 'Claim gate: a first proof paragraph without a claim fails, a later one without a claim passes, a later malformed claim still fails, and a later well-formed claim passes in either form (A/B/C/D, four domains)',
    run() {
      for (const domain of DOMAINS) {
        // A: the letter the new contract asks for passes, and so does the letter the old contract asked for (every paragraph claims).
        const base = letterOf(domain);
        assert(gate(domain, base).passed, `${domain.key}/A: a claim in the first proof paragraph only passes (${detailOf(gate(domain, base))})`);
        const old = letterOf(domain, ['first', 'standalone', 'standalone']);
        assert(gate(domain, old).passed, `${domain.key}/A: a letter that still claims in every paragraph passes (${detailOf(gate(domain, old))})`);

        // B: drop the claim from the paragraph that owes it and the gate says so, naming the paragraph; put it back and it passes.
        const noFirstClaim = letterOf(domain, ['first', 'bare', 'bare'], (mapping, index) => { if (index === 0) delete mapping.claim; });
        const missing = gate(domain, noFirstClaim);
        assert(!missing.passed && missing.detail.includes(`${labelOf(0)} argumentMapping.claim is missing`) && !missing.detail.includes(`${labelOf(1)} argumentMapping.claim`),
          `${domain.key}/B: the first proof paragraph owes its claim and only it (${detailOf(missing)})`);
        for (const blank of ['', '   ', null, undefined]) {
          const blanked = letterOf(domain, ['first', 'bare', 'bare'], (mapping, index) => { if (index === 0) mapping.claim = blank; });
          assert(!gate(domain, blanked).passed, `${domain.key}/B: a blank claim (${JSON.stringify(blank)}) is a missing claim in the paragraph that owes one`);
        }
        assert(gate(domain, letterOf(domain)).passed, `${domain.key}/B: restoring the claim passes again`);

        // C: a later paragraph leaves its claim out in every way a response can: absent, empty, blank, null.
        for (const blank of ['absent', '', '   ', null]) {
          const omitted = letterOf(domain, ['first', 'bare', 'bare'], (mapping, index) => {
            if (index === 0) return;
            if (blank === 'absent') delete mapping.claim; else mapping.claim = blank;
          });
          assert(gate(domain, omitted).passed, `${domain.key}/C: later paragraphs that omit the claim (${blank === 'absent' ? 'field absent' : JSON.stringify(blank)}) pass (${detailOf(gate(domain, omitted))})`);
        }

        // D: a later paragraph that DOES record a claim is held to the same shape as before.
        const withLaterClaim = (claimOf) => letterOf(domain, ['first', 'bare', 'bare'], (mapping, index) => { if (index === 1) mapping.claim = claimOf(domain.proofs[1]); });
        const rejections = [
          ['a span the paragraph does not contain', () => 'My unrelated hobby experience is pottery.', `${labelOf(1)} argumentMapping.claim is not an exact normalized span`],
          ['a span of the paragraph that states no capability', proof => proof.ending, `${labelOf(1)} argumentMapping.claim must state a general candidate capability`],
          ['the past action itself', proof => proof.proof, `${labelOf(1)} argumentMapping.claim`],
        ];
        // The inline sentence is not in a bare paragraph, so the next two need a paragraph that contains it.
        const inlineWith = claimText => letterOf(domain, ['first', 'inline', 'bare'], (mapping, index) => { if (index === 1) mapping.claim = claimText; });
        for (const [what, claimOf, expected] of rejections) {
          const verdict = gate(domain, withLaterClaim(claimOf));
          assert(!verdict.passed && verdict.detail.includes(expected), `${domain.key}/D: ${what} is still rejected in a later paragraph (${detailOf(verdict)})`);
        }
        const cutInside = gate(domain, inlineWith(domain.proofs[1].inline.claim.slice(0, -1)));
        assert(!cutInside.passed && cutInside.detail.includes(`${labelOf(1)} argumentMapping.claim begins or ends inside a word`), `${domain.key}/D: a claim cut inside a word is still rejected in a later paragraph (${detailOf(cutInside)})`);
        const equalsProof = gate(domain, inlineWith(domain.proofs[1].inline.proof));
        assert(!equalsProof.passed && equalsProof.detail.includes(`${labelOf(1)} argumentMapping.claim duplicates its proof`), `${domain.key}/D: a claim equal to its proof is still rejected in a later paragraph (${detailOf(equalsProof)})`);
        // A flipped control: the same inline paragraph with the well-formed claim passes.
        const wellFormed = gate(domain, inlineWith(domain.proofs[1].inline.claim));
        assert(wellFormed.passed, `${domain.key}/D: the same paragraph with its well-formed inline claim passes (${detailOf(wellFormed)})`);

        // E: an inline claim phrase is legal in every proof-bearing paragraph, the first included, and in the proof sentence.
        const allInline = letterOf(domain, ['inline', 'inline', 'inline'], (mapping, index) => {
          if (index === 0) mapping.relevance = domain.proofs[0].natural;
        });
        // The first paragraph also owes a sentence about the target; give it one beside its inline sentence.
        allInline.paragraphs[1] = `${domain.proofs[0].inline.sentence} ${domain.proofs[0].natural}`;
        const inlineVerdict = gate(domain, allInline);
        assert(inlineVerdict.passed, `${domain.key}/E: a claim that sits inside the proof sentence is a legal claim span (${detailOf(inlineVerdict)})`);

        // F: the obligation follows position, not identity. Put the paragraph with no claim FIRST and it owes one.
        const swapped = {
          paragraphs: [domain.opening, paragraphOf(domain.proofs[1], 'bare'), paragraphOf(domain.proofs[0], 'first'), domain.closing],
          plan: { paragraphs: [null, { ...mappingOf(domain.proofs[1], 'bare') }, { ...mappingOf(domain.proofs[0], 'first') }, null].map(mapping => ({ argumentMapping: mapping })) },
        };
        const swappedVerdict = gate(domain, swapped);
        assert(!swappedVerdict.passed && swappedVerdict.detail.includes('paragraph 2 argumentMapping.claim is missing') && !swappedVerdict.detail.includes('paragraph 3 argumentMapping.claim'),
          `${domain.key}/F: the claim moves with the position: the paragraph that now comes first owes it (${detailOf(swappedVerdict)})`);
      }
    },
  },
  {
    name: 'Claim reporter: the drafting-stage reporter never reports a claim gap the gate would accept, and every gap it reports is one no claim span could close (subset, brute force over every word run, four domains)',
    run() {
      // Every contiguous run of words of a paragraph, as a candidate claim.
      const wordRuns = paragraph => {
        const words = paragraph.split(/\s+/u).filter(Boolean);
        const runs = [];
        for (let start = 0; start < words.length; start += 1) {
          for (let end = start + 1; end <= words.length; end += 1) runs.push(words.slice(start, end).join(' '));
        }
        return runs;
      };
      const claimObservation = verdict => /argumentMapping\.claim\b/u.test(verdict.detail);
      for (const domain of DOMAINS) {
        const proof = domain.proofs[1];
        const variants = { noCue: paragraphOf(proof, 'bare'), standalone: paragraphOf(proof, 'standalone'), inline: paragraphOf(proof, 'inline') };
        // Where the variant stands decides whether it owes a claim: after the paragraph that owes it, or first.
        const lettersFor = variant => ({
          later: [domain.opening, paragraphOf(domain.proofs[0], 'first'), variant, domain.closing],
          first: [domain.opening, variant, domain.closing],
        });
        for (const [shape, variant] of Object.entries(variants)) {
          for (const [where, paragraphs] of Object.entries(lettersFor(variant))) {
            const at = paragraphs.indexOf(variant);
            const owes = explicitClaimOwed(paragraphs)[at];
            assert(owes === (where === 'first'), `${domain.key}/${shape}/${where}: the count puts the obligation where the variant stands (${owes})`);
            const gaps = paragraphArgumentSpanGaps(variant, domain.posting, { owesTransfer: false, owesClaim: owes });
            const claimGap = gaps.some(gap => gap.field === 'claim');
            // The reporter speaks only for a paragraph with no capability phrase at all, and only when that paragraph owes a claim.
            assert(claimGap === (owes && shape === 'noCue'), `${domain.key}/${shape}/${where}: the reporter reports a claim gap exactly when the paragraph owes one and offers none (${JSON.stringify(gaps.map(gap => gap.field))})`);
            if (claimGap) assert(gaps.find(gap => gap.field === 'claim').rule === ARGUMENT_CLAIM_SPAN_RULE, `${domain.key}: the claim gap carries the printed claim rule`);
            // Subset: whenever the reporter reports it, the gate rejects EVERY claim a response could record, and the absent one.
            const mappingFor = claim => {
              const mapping = { proof: proof.proof, relevance: proof.proof, jobNeedQuote: proof.quote };
              if (claim !== undefined) mapping.claim = claim;
              const plan = { paragraphs: paragraphs.map((_, index) => ({ argumentMapping: index === at ? mapping : (paragraphs[index] === paragraphOf(domain.proofs[0], 'first') ? mappingOf(domain.proofs[0], 'first') : null) })) };
              return checkParagraphArgumentLinks({ plan, paragraphs, jobText: domain.posting });
            };
            if (claimGap) {
              assert(/argumentMapping\.claim is missing/u.test(mappingFor(undefined).detail), `${domain.key}/${shape}/${where}: with the gap reported, an absent claim is rejected by the gate`);
              for (const run of wordRuns(variant)) {
                assert(claimObservation(mappingFor(run)), `${domain.key}/${shape}/${where}: with the gap reported, the gate rejects the claim “${run}”`);
              }
            } else if (!owes) {
              // And the converse that makes the budget real: nothing is asked of a later paragraph, whatever it offers.
              assert(!claimObservation(mappingFor(undefined)), `${domain.key}/${shape}/${where}: the gate asks nothing of a later paragraph's claim (${mappingFor(undefined).detail})`);
            }
          }
        }
        // The default of the reporter is the OLD behaviour (every paragraph owes one), so a caller that does not pass the count is never
        // more lenient than the gate; passing false is the only way to ask less.
        const noCue = variants.noCue;
        assert(paragraphArgumentSpanGaps(noCue, domain.posting, { owesTransfer: false }).some(gap => gap.field === 'claim'), `${domain.key}: without the count the reporter still asks for a claim`);
        assert(paragraphArgumentSpanGaps(noCue, domain.posting).some(gap => gap.field === 'claim'), `${domain.key}: with no options at all the reporter still asks for a claim`);
        assert(!paragraphArgumentSpanGaps(noCue, domain.posting, { owesTransfer: false, owesClaim: false }).some(gap => gap.field === 'claim'), `${domain.key}: only an explicit false relaxes it`);
        // A paragraph with no proof of its own owes no mapping at all, whatever the flags say.
        assert(paragraphArgumentSpanGaps(domain.opening, domain.posting, { owesClaim: true }).length === 0 && paragraphArgumentSpanGaps(domain.closing, domain.posting, { owesClaim: true }).length === 0, `${domain.key}: an opening and a closing owe nothing`);
      }
    },
  },
  {
    name: 'Claim mutation: rewriting the constant to two in a temporary copy of the module moves the gate, the reporter and the printed rule together, and the real module is unchanged (A/B/C)',
    async run() {
      const source = fs.readFileSync(path.resolve('electron/ipc/coverLetterChecks.js'), 'utf8');
      const declaration = 'export const MAX_EXPLICIT_CLAIM_PARAGRAPHS = 1;';
      assert(source.split(declaration).length === 2, 'the constant is declared once, so the mutation changes the one number');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-budget-mutation-'));
      try {
        // Sibling imports are rewritten to absolute URLs so the copy can live outside the repository.
        const toAbsolute = text => text.replace(/from '(\.\/[^']+)'/gu, (_, relative) => `from '${pathToFileURL(path.resolve('electron/ipc', relative)).href}'`);
        const load = async (name, mutate) => {
          const file = path.join(dir, `${name}.mjs`);
          fs.writeFileSync(file, toAbsolute(mutate(source)), 'utf8');
          return import(`${pathToFileURL(file).href}?v=${name}`);
        };
        const control = await load('control', text => text);
        const two = await load('two', text => text.replace(declaration, 'export const MAX_EXPLICIT_CLAIM_PARAGRAPHS = 2;'));
        assert(control.MAX_EXPLICIT_CLAIM_PARAGRAPHS === 1 && two.MAX_EXPLICIT_CLAIM_PARAGRAPHS === 2, 'the copy really carries the other number');
        for (const domain of DOMAINS) {
          const letter = letterOf(domain);
          // A: the count follows the number.
          assert(control.explicitClaimOwed(letter.paragraphs).join() === 'false,true,false,false,false', `${domain.key}/A: the unmutated copy owes one`);
          assert(two.explicitClaimOwed(letter.paragraphs).join() === 'false,true,true,false,false', `${domain.key}/A: the mutated copy owes two (${two.explicitClaimOwed(letter.paragraphs)})`);
          // B: the gate follows the count. The letter that omits the second claim passes at one and fails at two; supplying it passes at two.
          const verdictOne = control.checkParagraphArgumentLinks({ plan: letter.plan, paragraphs: letter.paragraphs, jobText: domain.posting });
          const verdictTwo = two.checkParagraphArgumentLinks({ plan: letter.plan, paragraphs: letter.paragraphs, jobText: domain.posting });
          assert(verdictOne.passed && !verdictTwo.passed && verdictTwo.detail.includes(`${labelOf(1)} argumentMapping.claim is missing`) && !verdictTwo.detail.includes(`${labelOf(2)} argumentMapping.claim`),
            `${domain.key}/B: the second paragraph's claim is owed at two and not at one (${detailOf(verdictTwo)})`);
          const supplied = letterOf(domain, ['first', 'standalone', 'bare']);
          assert(two.checkParagraphArgumentLinks({ plan: supplied.plan, paragraphs: supplied.paragraphs, jobText: domain.posting }).passed, `${domain.key}/B: supplying the second claim passes at two`);
          // C: the reporter follows the count the caller reads from the same module, and the printed rule follows the number.
          const bare = letter.paragraphs[2];
          const reportedOne = control.paragraphArgumentSpanGaps(bare, domain.posting, { owesTransfer: false, owesClaim: control.explicitClaimOwed(letter.paragraphs)[2] });
          const reportedTwo = two.paragraphArgumentSpanGaps(bare, domain.posting, { owesTransfer: false, owesClaim: two.explicitClaimOwed(letter.paragraphs)[2] });
          assert(!reportedOne.some(gap => gap.field === 'claim') && reportedTwo.some(gap => gap.field === 'claim'), `${domain.key}/C: the reporter reports the second paragraph at two and not at one`);
        }
        assert(control.OWING_CLAIM_PARAGRAPHS === 'the first proof-bearing paragraph of the letter' && control.EXPLICIT_CLAIM_BUDGET_RULE.startsWith('only the first proof-bearing paragraph of the letter owes a claim span'),
          `the real number prints as one paragraph (${control.EXPLICIT_CLAIM_BUDGET_RULE})`);
        assert(two.OWING_CLAIM_PARAGRAPHS === 'each of the first 2 proof-bearing paragraphs of the letter' && two.EXPLICIT_CLAIM_BUDGET_RULE.includes('each of the first 2 proof-bearing paragraphs of the letter')
          && two.EXPLICIT_CLAIM_BUDGET_RULE !== control.EXPLICIT_CLAIM_BUDGET_RULE, `the printed rule follows the number (${two.EXPLICIT_CLAIM_BUDGET_RULE})`);
        // The claim number is its own: moving it leaves the transfer budget and its printed rule where they were.
        assert(two.MAX_EXPLICIT_TRANSFER_PARAGRAPHS === 1 && two.EXPLICIT_TRANSFER_BUDGET_RULE === EXPLICIT_TRANSFER_BUDGET_RULE && two.explicitTransferOwed(letterOf(DOMAINS[0]).paragraphs).join() === 'false,true,false,false,false',
          'the transfer budget does not move with the claim budget');
        // The module under test is untouched.
        assert(MAX_EXPLICIT_CLAIM_PARAGRAPHS === 1 && OWING_CLAIM_PARAGRAPHS === 'the first proof-bearing paragraph of the letter' && EXPLICIT_CLAIM_BUDGET_RULE === control.EXPLICIT_CLAIM_BUDGET_RULE,
          'the real module is unchanged by the temporary copies');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Claim rule: the printed rule says a claim may be a short inline phrase that names the capability with the cited evidence’s own nouns, keeps the closed grammar, gives no string to copy, and the cue was not widened (A/B/C)',
    run() {
      const rule = ARGUMENT_CLAIM_SPAN_RULE;
      // A: the guidance a writer needs.
      for (const [clause, pattern] of [
        ['it is a short phrase', /\ba claim span is a short phrase\b/u],
        ['it can sit inline in any sentence, the proof sentence included', /\binline in any sentence of the paragraph, the proof sentence included\b/u],
        ['it needs no sentence of its own', /\bneeds no sentence of its own\b/u],
        ['it names the capability with the nouns of the cited evidence', /\bnouns of the evidence this paragraph cites\b/u],
        ['and not with an abstraction about how the candidate works', /\bnot an abstraction about how the candidate works or thinks\b/u],
        ['it asserts no more than the evidence shows', /\basserts no more than that evidence shows\b/u],
      ]) {
        assert(pattern.test(rule), `the claim rule says ${clause}`);
      }
      // The closed grammar the gate matches is still printed, so the guidance did not displace it.
      for (const shape of [/\bmy, I am,/u, /\bfollowed within the span by experience, background, skill, capability, practice, approach, judgment or foundation\b/u,
        /\bI build, design, implement, maintain, improve, secure or worked on\b/u, /\bwork spans\b/u, /\bis, has been or remains a capability, skill, foundation or strength\b/u,
        /\bwhere that gerund is followed by its own object\b/u, /\bnever the transfer\b/u]) {
        assert(shape.test(rule), `the claim rule still prints the grammar ${shape}`);
      }
      // No string to copy: no quotation, and none of the fixtures' words, which would mean an example crept in.
      assert(!/["“”]/u.test(rule), 'the claim rule quotes no example wording');
      for (const domain of DOMAINS) {
        for (const proof of domain.proofs) assert(!rule.toLowerCase().includes(proof.inline.claim.toLowerCase()), `${domain.key}: the rule carries no fixture claim`);
      }
      // The budget rule is built from the constant and says what a later paragraph keeps.
      assert(EXPLICIT_CLAIM_BUDGET_RULE === `only ${OWING_CLAIM_PARAGRAPHS} owes a claim span; a later proof-bearing paragraph owes only its proof span and its jobNeedQuote, may leave the claim out, and is held to the same shape for a claim span it records`,
        `the budget rule is the constant's phrase around the fixed clauses (${EXPLICIT_CLAIM_BUDGET_RULE})`);

      // B: the cue was NOT widened. A paragraph whose only candidate-facing sentences are vacuous has no claim span, whatever its length.
      const posting = DOMAINS[0].posting;
      const proofSentence = `${DOMAINS[0].proofs[0].proof} ${DOMAINS[0].proofs[0].natural}`;
      for (const vacuous of ['I am a dedicated team player.', 'I bring energy and enthusiasm to everything I touch.', 'Quality matters deeply to me.', 'I thrive in fast-paced settings and enjoy hard problems.',
        'I am passionate about public infrastructure and about the people who rely on it.', 'I have always cared about doing the job right.']) {
        const gaps = paragraphArgumentSpanGaps(`${vacuous} ${proofSentence}`, posting, { owesClaim: true });
        assert(gaps.some(gap => gap.field === 'claim'), `a vacuous sentence is no claim span (${vacuous})`);
      }
      // C: and a concrete one is, flipping only that sentence.
      for (const concrete of ['My culvert inspection practice began on a county road crew.', 'I have hands-on experience with drainage inspections.', 'My crossing checklist work spans three counties.']) {
        const gaps = paragraphArgumentSpanGaps(`${concrete} ${proofSentence}`, posting, { owesClaim: true });
        assert(!gaps.some(gap => gap.field === 'claim'), `a concrete capability sentence is a claim span (${concrete})`);
      }
    },
  },
  {
    name: 'Prior employer opening: a role noun that governs the preposition introduces the employer, a bare opener still does not, and removing the role noun brings the rejection back (A/B/C, four employers)',
    run() {
      // Four invented employers, each with a different role noun and preposition.
      const CASES = [
        { employer: 'Harbor Light Freight', framed: 'In an earlier logistics planning role at Harbor Light Freight, I built the dock schedule.', noun: 'role', preposition: 'at' },
        { employer: 'Quillon Municipal Utilities', framed: 'A seasonal inspection internship with Quillon Municipal Utilities taught me the sampling routine, and I wrote the intake log there.', noun: 'internship', preposition: 'with' },
        { employer: 'Brightfield Orthodontics', framed: 'During a two-year front-desk position for Brightfield Orthodontics, I wrote the intake checklist.', noun: 'position', preposition: 'for' },
        { employer: 'Tamarack Valley Co-op', framed: 'A short consulting engagement with Tamarack Valley Co-op let me rework the reorder plan.', noun: 'engagement', preposition: 'with' },
        { employer: 'Ostrander Library', framed: 'My first job at Ostrander Library was shelving, and I created the hold list.', noun: 'job', preposition: 'at' },
        { employer: 'Pinecrest Transit', framed: 'The tenure at Pinecrest Transit gave me the depot, where I developed the staging plan.', noun: 'tenure', preposition: 'at' },
      ];
      const verdict = (paragraph, employer) => checkPriorEmployerOpening([paragraph], [employer]);
      for (const { employer, framed, noun, preposition } of CASES) {
        // A: the role-framed introduction is accepted.
        const accepted = verdict(framed, employer);
        assert(accepted.passed, `${employer}/A: a ${noun} ${preposition} the employer introduces it (${detailOf(accepted)})`);
        // B: the same sentence with the role noun taken out is rejected, with the check's own observation.
        const withoutNoun = framed.replace(new RegExp(`\\b${noun}s? (?=${preposition} )`, 'u'), '');
        assert(withoutNoun !== framed, `${employer}: the mutation removed the role noun`);
        const rejected = verdict(withoutNoun, employer);
        assert(!rejected.passed && rejected.detail.includes(`first names “${employer}” without the candidate's role or relationship`), `${employer}/B: without the role noun the rejection returns (${detailOf(rejected)})`);
        // C: and putting the noun back flips it again.
        assert(verdict(framed, employer).passed, `${employer}/C: restoring the role noun accepts it again`);
        // The bare opener is what it always was.
        const bare = verdict(`At ${employer}, I built the incident workflow.`, employer);
        assert(!bare.passed, `${employer}: a bare opener is still rejected (${detailOf(bare)})`);
        // A role noun that does not govern the preposition does not introduce the employer.
        const detached = verdict(`The ${noun} I liked best was elsewhere, and ${preposition === 'at' ? 'at' : 'with'} ${employer} I built the incident workflow.`, employer);
        assert(!detached.passed, `${employer}: a role noun that is not directly in front of the preposition does not count (${detailOf(detached)})`);
        // Another preposition does not make the employer one the role belongs to.
        const wrongPreposition = verdict(framed.replace(new RegExp(` ${preposition} ${employer}`, 'u'), ` near ${employer}`), employer);
        assert(!wrongPreposition.passed, `${employer}: a role noun in front of an unrelated preposition does not count (${detailOf(wrongPreposition)})`);
      }
      // The role noun list is the one named: a neighbouring noun that only names a place of work does not introduce the employer.
      assert(!verdict('Earlier work at Harbor Light Freight taught me the dock schedule, and I built it.', 'Harbor Light Freight').passed, 'a bare "work at" names a place, not a relationship');
      assert(!verdict('In an earlier logistics planning setting at Harbor Light Freight, I built the dock schedule.', 'Harbor Light Freight').passed, 'a setting at an employer is not a role');
      // The first sentence that names the employer decides: a bare opener cannot be repaired by a later role-framed mention.
      const laterFramed = checkPriorEmployerOpening(['At Harbor Light Freight, I built the dock schedule.', 'My role at Harbor Light Freight covered the evening shift.'], ['Harbor Light Freight']);
      assert(!laterFramed.passed, 'only the sentence that first names the employer is read');
      // Several employers are read independently, each by its own first mention.
      const two = checkPriorEmployerOpening(['In an earlier logistics planning role at Harbor Light Freight, I built the dock schedule. At Pinecrest Transit, I developed the staging plan.'], ['Harbor Light Freight', 'Pinecrest Transit']);
      assert(!two.passed && two.detail.includes('“Pinecrest Transit”') && !two.detail.includes('“Harbor Light Freight”'), `one framed and one bare employer: only the bare one is reported (${detailOf(two)})`);
      // The old frames are untouched.
      for (const old of ['As a planner at Harbor Light Freight, I built the dock schedule.', 'My planning role at Harbor Light Freight covered the dock schedule, which I built.', 'I worked at Harbor Light Freight, where I built the dock schedule.']) {
        assert(verdict(old, 'Harbor Light Freight').passed, `an existing frame still passes (${old})`);
      }
    },
  },
  {
    name: 'Claim contract documents: the Local AI routine says only the first proof-bearing paragraph owes a claim and no longer says every later paragraph keeps one (A/B)',
    run() {
      const routine = fs.readFileSync(path.resolve('local_ai/LOCAL_AI_APPLICATION_ROUTINE.md'), 'utf8').replace(/\s+/gu, ' ');
      assert(/Only the first proof-bearing paragraph of the letter owes a `claim` or a `relevance`/u.test(routine) && /may omit either one/u.test(routine) && /may leave the claim out/u.test(routine), 'the routine states the claim budget');
      assert(/may sit inline in any sentence of the paragraph, the proof sentence included, so it needs no sentence of its own/u.test(routine), 'the routine says a claim may be inline');
      assert(!/Every later proof-bearing paragraph keeps its claim, proof and `jobNeedQuote`/u.test(routine), 'the routine no longer says every later paragraph keeps a claim');
    },
  },
];
