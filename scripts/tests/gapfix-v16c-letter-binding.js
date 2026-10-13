// What the host lets a correction do, what the posting span means, and one posting requirement answered twice.
//
// The failures these tests pin (round-2 review of the v16 work).
//
//   1  The signed reviewer clause listed "merge it into the proof sentence" as a legal correction of the
//      required phrase OR sentence. That is legal for the claim phrase and host-illegal for the relevance
//      sentence, which must be a sentence (or part of one) apart from the proof sentence: five of the
//      eleven paragraph-1 findings of the live run were about that sentence, and a merge costs one host
//      rejection and one fresh re-flag. The clause now states what is legal for each required function.
//   2  The clause called the jobNeedQuote something a sentence can be "grounded in", beside the cited
//      career quotes. The quote is posting text the writer chose to bind the paragraph to, not evidence
//      about the candidate: a first-person capability sentence that only echoes it must not read as
//      grounded. The clause now labels it as such and exempts only sentences grounded in a cited career
//      quote.
//   3  With the relevance span optional, a later paragraph's jobNeedQuote was graded only as a verbatim
//      span of the posting, so any posting sentence could be bound to any paragraph and two paragraphs
//      could be bound to the same one. The writer guidance says not to; the review now rejects it. No
//      lexical overlap is demanded (a proof that shares no word with any posting sentence stays
//      writable), and the drafting stage, which cannot see a quote the review has not chosen, is told
//      nothing new.
//
// What each group below proves, over four invented careers in unrelated fields (ferry berth planning,
// bridge inspection, retail replenishment, seed bank curation):
//   host        each correction the clause allows is accepted by the audit gate and each it forbids is
//               rejected, so the clause says what the host does
//   clause      the wording: legal corrections per function, the label of the posting span, the narrowed
//               exemption, no waiver, and the clause still reaches exactly the letter-reading scopes
//   binding     two proof-bearing paragraphs bound to one posting span are rejected at the review with
//               the paragraphs named, nothing else about the quote is demanded, and a mutation of one
//               quote flips the verdict
//
// Nothing in production names any of the fixtures.
import { assert } from './testHelpers.js';
import { checkParagraphArgumentLinks, paragraphArgumentSpanGaps } from '../../electron/ipc/coverLetterChecks.js';

const DOMAINS = Object.freeze([
  {
    key: 'ferry berth planning',
    posting: ['Plan daily berth schedules for the harbour terminals.', 'Reconcile crew rosters against sailing timetables.', 'Coach new deck supervisors on mooring procedures.'],
    opening: 'A ferry leaves on time only when someone planned its berth the night before, and this role plans it.',
    claim: 'My berth scheduling experience began on a regional ferry line.',
    claimReworded: 'My terminal planning background comes from a regional ferry line.',
    claimShort: 'My scheduling experience began on a ferry line.',
    claimPhrase: 'My berth scheduling experience',
    proof: 'I built an allocation sheet that terminal crews read before every sailing.',
    natural: 'Daily berth schedules for the harbour terminals depend on one sheet that every crew reads the same way.',
    naturalReworded: 'The harbour terminals keep daily berth schedules reliable only when every crew reads one sheet the same way.',
    naturalShort: 'Daily berth schedules for the harbour terminals depend on one sheet.',
    second: 'I wrote the roster checklist that deck supervisors signed before each departure.',
    ending: 'Disputed shifts fell to a handful by the end of the season.',
  },
  {
    key: 'bridge inspection',
    posting: ['Inspect highway bridges on a decade long cycle.', 'Rate deck and bearing condition against county standards.', 'Train new field technicians on safe access.'],
    opening: 'A bridge stays open because somebody read its bearings before the crack mattered, and this role reads them.',
    claim: 'My structural inspection background comes from a state transport office.',
    claimReworded: 'My bridge condition experience comes from a state transport office.',
    claimShort: 'My inspection background comes from a state office.',
    claimPhrase: 'My structural inspection background',
    proof: 'I designed a condition form that field crews filled in on every deck.',
    natural: 'Highway bridges inspected on a decade long cycle need one form that every crew fills in the same way.',
    naturalReworded: 'A decade long cycle of highway bridge inspections stays comparable only when every crew fills in one form.',
    naturalShort: 'Highway bridges on a decade long cycle need one form.',
    second: 'I created the repair ranking sheet that the county board reviewed each spring.',
    ending: 'Funding went first to the spans with the highest structural risk.',
  },
  {
    key: 'retail replenishment',
    posting: ['Forecast weekly demand for fresh departments.', 'Set reorder points for perishable lines.', 'Mentor store managers on ordering discipline.'],
    opening: 'Fresh shelves stay full when someone forecast the week before it started, and this role forecasts it.',
    claim: 'My demand forecasting approach began with a regional grocery chain.',
    claimReworded: 'My replenishment planning practice grew out of a regional grocery chain.',
    claimShort: 'My forecasting approach began with a grocery chain.',
    claimPhrase: 'My demand forecasting approach',
    proof: 'I developed a weekly demand sheet that produce managers used in every store.',
    natural: 'Weekly demand for fresh departments is forecast best from one sheet that every manager reads the same way.',
    naturalReworded: 'Fresh departments get their weekly demand forecast right only when every manager reads one sheet the same way.',
    naturalShort: 'Weekly demand for fresh departments is forecast from one sheet.',
    second: 'I maintained the reorder point table that buyers checked before each order.',
    ending: 'Spoiled stock fell steadily through the second half of the year.',
  },
  {
    key: 'seed bank curation',
    posting: ['Catalogue incoming seed accessions to international standards.', 'Test germination on a rolling schedule.', 'Supervise volunteer sorters during intake season.'],
    opening: 'A seed is only useful if someone can find it again, and this role makes sure they can.',
    claim: 'My seed cataloguing background comes from a university collection.',
    claimReworded: 'My accession records experience comes from a university collection.',
    claimShort: 'My cataloguing background comes from a university.',
    claimPhrase: 'My seed cataloguing background',
    proof: 'I created an accession ledger that curators used for every donation.',
    natural: 'Incoming seed accessions reach international standards only when every record starts from one ledger.',
    naturalReworded: 'International standards for incoming seed accessions are met only when every record starts from one ledger.',
    naturalShort: 'Incoming seed accessions reach international standards from one ledger.',
    second: 'I wrote the germination protocol that volunteers followed for each test batch.',
    ending: 'Failed batches were traced to the shelf within a day.',
  },
]);

const closing = 'I welcome a conversation about your work.';
// The content words (four letters or more, plural -s dropped) two texts share.
const contentWords = value => new Set((String(value).toLowerCase().match(/[a-z]{4,}/gu) || []).map(word => word.replace(/s$/u, '')));
const sharedWords = (left, right) => { const other = contentWords(right); return [...contentWords(left)].filter(word => other.has(word)); };
const lowerFirst = value => `${value[0].toLowerCase()}${value.slice(1)}`;
const clause = sentence => sentence.replace(/\.$/u, '');
const detailOf = check => `${check.id}: ${check.detail}`;

// The first proof-bearing paragraph as the review would map it, with the pieces named: claim sentence, proof sentence, relevance sentence.
function firstParagraph(domain, { claim = domain.claim, relevance = domain.natural, text } = {}) {
  const body = text ?? [claim, domain.proof, relevance].filter(Boolean).join(' ');
  return { body, mapping: { claim, proof: domain.proof, relevance, jobNeedQuote: domain.posting[0] } };
}
function laterParagraph(domain, quote = domain.posting[1]) {
  return { body: `${domain.second} ${domain.ending}`, mapping: { proof: domain.second, jobNeedQuote: quote } };
}
function gate(domain, first, later = laterParagraph(domain), { mappings } = {}) {
  const paragraphs = [domain.opening, first.body, later.body, closing];
  const planned = mappings ?? [null, first.mapping, later.mapping, null];
  return checkParagraphArgumentLinks({ plan: { paragraphs: planned.map(mapping => ({ argumentMapping: mapping })) }, paragraphs, jobText: domain.posting.join(' ') });
}

export default [
  {
    name: 'Reviewer corrections, host side: each correction the v7 clause allows for the claim phrase and the relevance sentence is accepted by the audit gate, and each it forbids is rejected (8 corrections, 4 domains, A/B/C)',
    run() {
      for (const domain of DOMAINS) {
        const base = gate(domain, firstParagraph(domain));
        assert(base.passed, `${domain.key}/A: the base paragraph passes (${detailOf(base)})`);
        // A: the claim phrase may be reworded, shortened, or merged into the proof sentence.
        const claimReworded = gate(domain, firstParagraph(domain, { claim: domain.claimReworded }));
        assert(claimReworded.passed, `${domain.key}/A: a reworded claim phrase passes (${detailOf(claimReworded)})`);
        const claimShortened = gate(domain, firstParagraph(domain, { claim: domain.claimShort }));
        assert(claimShortened.passed, `${domain.key}/A: a shortened claim phrase passes (${detailOf(claimShortened)})`);
        const mergedSentence = `${domain.claimPhrase} began when ${lowerFirst(clause(domain.proof))}.`;
        const claimMerged = gate(domain, { body: `${mergedSentence} ${domain.natural}`, mapping: { claim: domain.claimPhrase, proof: clause(domain.proof), relevance: domain.natural, jobNeedQuote: domain.posting[0] } });
        assert(claimMerged.passed, `${domain.key}/A: a claim phrase merged into the proof sentence passes (${detailOf(claimMerged)})`);
        // B: the relevance sentence may be reworded or shortened, and must stay apart from the proof sentence.
        const relevanceReworded = gate(domain, firstParagraph(domain, { relevance: domain.naturalReworded }));
        assert(relevanceReworded.passed, `${domain.key}/B: a reworded relevance sentence passes (${detailOf(relevanceReworded)})`);
        const relevanceShortened = gate(domain, firstParagraph(domain, { relevance: domain.naturalShort }));
        assert(relevanceShortened.passed, `${domain.key}/B: a shortened relevance sentence passes (${detailOf(relevanceShortened)})`);
        const mergedRelevance = `${clause(domain.proof)}, so ${lowerFirst(clause(domain.natural))}.`;
        const relevanceMerged = gate(domain, { body: `${domain.claim} ${mergedRelevance}`, mapping: { claim: domain.claim, proof: clause(domain.proof), relevance: `so ${lowerFirst(clause(domain.natural))}`, jobNeedQuote: domain.posting[0] } });
        assert(!relevanceMerged.passed && relevanceMerged.detail.includes('sits inside the sentence its proof span comes from'),
          `${domain.key}/B: a relevance sentence merged into the proof sentence is refused, which is why the clause no longer offers it (${detailOf(relevanceMerged)})`);
        // C: deleting the only phrase or sentence that performs a required function is refused too.
        const relevanceDeleted = gate(domain, { body: `${domain.claim} ${domain.proof}`, mapping: { claim: domain.claim, proof: domain.proof, jobNeedQuote: domain.posting[0] } });
        assert(!relevanceDeleted.passed && relevanceDeleted.detail.includes('argumentMapping.relevance is missing'), `${domain.key}/C: deleting the relevance sentence is refused (${detailOf(relevanceDeleted)})`);
        const claimDeleted = gate(domain, { body: `${domain.proof} ${domain.natural}`, mapping: { proof: domain.proof, relevance: domain.natural, jobNeedQuote: domain.posting[0] } });
        assert(!claimDeleted.passed && claimDeleted.detail.includes('argumentMapping.claim is missing'), `${domain.key}/C: deleting the claim phrase is refused (${detailOf(claimDeleted)})`);
      }
    },
  },
  {
    name: 'Same posting span twice: two proof-bearing paragraphs bound to one jobNeedQuote are rejected at the review with the paragraphs named, nothing else about the quote is demanded, and one changed quote flips the verdict (4 domains, A/B/C/D)',
    run() {
      let disjoint = 0;
      for (const domain of DOMAINS) {
        const first = firstParagraph(domain);
        // A: the same span twice. The observation names both paragraphs and the repair, and prints none of the posting.
        const twice = gate(domain, first, laterParagraph(domain, domain.posting[0]));
        assert(!twice.passed && twice.detail.includes('paragraphs 2 and 3 bind the same argumentMapping.jobNeedQuote, so one posting requirement is answered more than once'), `${domain.key}/A: the duplicate is rejected (${detailOf(twice)})`);
        assert(twice.detail.includes('bind each proof-bearing paragraph to the requirement its own proof answers') && !twice.detail.includes(domain.posting[0]), `${domain.key}/A: and the message gives the repair without copying the posting`);
        // The same words in other letter case, spacing or punctuation are the same span.
        const respelled = gate(domain, first, laterParagraph(domain, `  ${domain.posting[0].toUpperCase().replace(/\.$/u, '')}  `));
        assert(!respelled.passed && respelled.detail.includes('bind the same'), `${domain.key}/A: a respelled copy of the span is the same span (${detailOf(respelled)})`);
        // B: three proof-bearing paragraphs, two of them sharing: only those two are named; all three sharing: all three.
        const third = { body: `${domain.proof} ${domain.ending}`, mapping: { proof: domain.proof, jobNeedQuote: domain.posting[1] } };
        const run = quotes => checkParagraphArgumentLinks({
          plan: { paragraphs: [null, { ...first.mapping, jobNeedQuote: quotes[0] }, { ...laterParagraph(domain).mapping, jobNeedQuote: quotes[1] }, { ...third.mapping, jobNeedQuote: quotes[2] }, null].map(mapping => ({ argumentMapping: mapping })) },
          paragraphs: [domain.opening, first.body, laterParagraph(domain).body, third.body, closing], jobText: domain.posting.join(' '),
        });
        const pair = run([domain.posting[0], domain.posting[1], domain.posting[1]]);
        assert(!pair.passed && pair.detail.includes('paragraphs 3 and 4 bind the same') && !pair.detail.includes('paragraphs 2'), `${domain.key}/B: only the two that share are named (${detailOf(pair)})`);
        const triple = run([domain.posting[0], domain.posting[0], domain.posting[0]]);
        assert(!triple.passed && triple.detail.includes('paragraphs 2, 3 and 4 bind the same'), `${domain.key}/B: all three are named when all three share (${detailOf(triple)})`);
        assert(run([domain.posting[0], domain.posting[1], domain.posting[2]]).passed, `${domain.key}/B: three different spans pass`);
        // C: mutation. One changed quote flips the verdict, and changing it back flips it again.
        const distinct = gate(domain, first, laterParagraph(domain, domain.posting[1]));
        assert(distinct.passed, `${domain.key}/C: bound to a different posting sentence the letter passes (${detailOf(distinct)})`);
        assert(!gate(domain, first, laterParagraph(domain, domain.posting[0])).passed, `${domain.key}/C: and bound to the first paragraph's span again it fails`);
        // D: only the degenerate case is read. A proof that shares no word with the sentence it is bound to stays writable, a paragraph that records no mapping is not counted, and the drafting stage, which cannot see a quote, is told nothing about it.
        const unrelated = gate(domain, first, laterParagraph(domain, domain.posting[2]));
        assert(unrelated.passed, `${domain.key}/D: a quote bound to a paragraph by the writer alone is not this gate's concern (${detailOf(unrelated)})`);
        if (sharedWords(laterParagraph(domain).body, domain.posting[2]).length === 0) disjoint += 1;
        const unmappedOpeningAndClosing = gate(domain, first, laterParagraph(domain, domain.posting[1]), { mappings: [null, first.mapping, { ...laterParagraph(domain, domain.posting[1]).mapping }, null] });
        assert(unmappedOpeningAndClosing.passed, `${domain.key}/D: paragraphs without a mapping are not counted (${detailOf(unmappedOpeningAndClosing)})`);
        const owes = [{ owesTransfer: true, owesClaim: true, owesRelevance: true }, { owesTransfer: false, owesClaim: false, owesRelevance: false }];
        const reported = [first.body, laterParagraph(domain).body].map((body, index) => paragraphArgumentSpanGaps(body, domain.posting.join(' '), owes[index]));
        assert(reported.every(gaps => gaps.length === 0), `${domain.key}/D: the drafting-stage reporter says nothing about a quote (${JSON.stringify(reported)})`);
      }
      assert(disjoint >= 2, `D: at least two domains bind a paragraph to a posting sentence it shares no content word with, and still pass (${disjoint})`);
    },
  },
];
