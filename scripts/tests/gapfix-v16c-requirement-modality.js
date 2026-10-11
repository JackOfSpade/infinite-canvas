// The modality guard reads the whole paragraph, not only the relevance span the review happens to record.
//
// The failure this test pins. A posting asks for the USE of a tool ("Use the <name> every morning"), and
// a letter must not turn that into building or integrating it ("I could build the <name> for you"). The
// guard that enforces it (requirementModalityObservation) read only the recorded relevance span. The
// budgets now let a later proof-bearing paragraph leave its claim and its relevance out, so a sentence of
// that paragraph that promotes the use of a tool into building it was read by nobody unless the writer
// happened to record it; the sibling guard for tool-assisted practice already reads every sentence of the
// paragraph (evidenceScopeObservation). The modality guard now reads the recorded relevance span first
// (its message is unchanged), then the claim, the proof span and every sentence of the paragraph, against
// the paragraph's own jobNeedQuote.
//
// What each group below proves, over five invented postings in unrelated fields (ferry berth planning,
// veterinary intake, bridge inspection, retail replenishment, seed bank curation):
//   recorded   a recorded relevance span that promotes use into building is rejected with the message it
//              always had
//   unrecorded the same promotion in a sentence no span records, in a claim span, and inside a
//              first-person proof sentence is rejected with a message that quotes the sentence
//   admitted   the candidate's completed work (past tense), using the tool, and building something other
//              than what the posting asks to use all pass
//   mutation   one changed word flips each verdict: the posting's need gains a construction verb, or the
//              sentence's verb changes from build to use
//
// Nothing in production names any of the fixtures.
import { assert } from './testHelpers.js';
import { checkParagraphArgumentLinks } from '../../electron/ipc/coverLetterChecks.js';

// need: the posting sentence that asks for USE; object: what it asks to use (the words the guard learns from it); first: the paragraph that owes claim, proof and relevance
// (bound to the first posting sentence); second: the later paragraph under test (bound to the need).
const DOMAINS = Object.freeze([
  {
    key: 'ferry berth planning', object: 'berth planning software', other: 'roster printer',
    posting: ['Plan daily berth schedules for the harbour terminals.', 'Use the berth planning software every morning.'],
    opening: 'A ferry leaves on time only when someone planned its berth the night before, and this role plans it.',
    first: ['My berth scheduling experience began on a regional ferry line.', 'I built an allocation sheet that terminal crews read before every sailing.', 'Daily berth schedules for the harbour terminals depend on one sheet that every crew reads the same way.'],
    second: 'I wrote the roster checklist that deck supervisors signed before each departure.', ending: 'Disputed shifts fell to a handful by the end of the season.',
  },
  {
    key: 'veterinary intake', object: 'appointment reminder platform', other: 'kennel label printer',
    posting: ['Greet arriving owners and record each animal at the front desk.', 'Work with the appointment reminder platform each day.'],
    opening: 'An anxious owner judges a clinic by its first minute, and this role owns that minute.',
    first: ['My intake coordination practice began in a busy animal hospital.', 'I built a check-in form that front desk staff completed for every animal.', 'Arriving owners are recorded at the front desk smoothly when every animal starts from one form.'],
    second: 'I wrote the kennel handover note that night technicians read each morning.', ending: 'Boarding questions at pickup dropped sharply.',
  },
  {
    key: 'bridge inspection', object: 'inspection logging software', other: 'access permit tracker',
    posting: ['Inspect highway bridges on a decade long cycle.', 'Use the inspection logging software on every site visit.'],
    opening: 'A bridge stays open because somebody read its bearings before the crack mattered, and this role reads them.',
    first: ['My structural inspection background comes from a state transport office.', 'I designed a condition form that field crews filled in on every deck.', 'Highway bridges inspected on a decade long cycle need one form that every crew fills in the same way.'],
    second: 'I created the repair ranking sheet that the county board reviewed each spring.', ending: 'Funding went first to the spans with the highest structural risk.',
  },
  {
    key: 'retail replenishment', object: 'demand planning platform', other: 'shelf label printer',
    posting: ['Forecast weekly demand for fresh departments.', 'Leverage the demand planning platform to set weekly orders.'],
    opening: 'Fresh shelves stay full when someone forecast the week before it started, and this role forecasts it.',
    first: ['My demand forecasting approach began with a regional grocery chain.', 'I developed a weekly demand sheet that produce managers used in every store.', 'Weekly demand for fresh departments is forecast best from one sheet that every manager reads the same way.'],
    second: 'I maintained the reorder point table that buyers checked before each order.', ending: 'Spoiled stock fell steadily through the second half of the year.',
  },
  {
    key: 'seed bank curation', object: 'seed accession workflow', other: 'packet sealing station',
    posting: ['Catalogue incoming seed accessions to international standards.', 'Use the seed accession workflow when cataloguing donations.'],
    opening: 'A seed is only useful if someone can find it again, and this role makes sure they can.',
    first: ['My seed cataloguing background comes from a university collection.', 'I created an accession ledger that curators used for every donation.', 'Incoming seed accessions reach international standards only when every record starts from one ledger.'],
    second: 'I wrote the germination protocol that volunteers followed for each test batch.', ending: 'Failed batches were traced to the shelf within a day.',
  },
]);

const detailOf = check => `${check.id}: ${check.detail}`;
const closing = 'I welcome a conversation about your work.';

// The paragraph under test is the second proof-bearing one, bound to the posting's need. `mapping` adds spans to its record; `postingOverride` changes the posting (and the quote with it).
function gate(domain, { body, mapping = {}, posting = domain.posting } = {}) {
  const [claim, proof, relevance] = domain.first;
  const later = body ?? `${domain.second} ${domain.ending}`;
  return checkParagraphArgumentLinks({
    plan: { paragraphs: [null, { claim, proof, relevance, jobNeedQuote: posting[0] }, { proof: domain.second, jobNeedQuote: posting[1], ...mapping }, null].map(value => ({ argumentMapping: value })) },
    paragraphs: [domain.opening, domain.first.join(' '), later, closing], jobText: posting.join(' '),
  });
}
const REPAIR = 'preserve the posting’s modality unless its own quoted need separately asks for construction or integration';

export default [
  {
    name: 'Modality, baseline: a later paragraph bound to a use-only need passes, so every rejection below is the guard\'s (5 domains)',
    run() {
      for (const domain of DOMAINS) {
        const base = gate(domain);
        assert(base.passed, `${domain.key}: the base letter passes (${detailOf(base)})`);
        const using = gate(domain, { body: `${domain.second} I used the ${domain.object} on every shift. ${domain.ending}` });
        assert(using.passed, `${domain.key}: using the tool passes (${detailOf(using)})`);
      }
    },
  },
  {
    name: 'Modality, recorded relevance: a relevance span that turns the use of a tool into building it is rejected with the message it always had (5 domains, A/B)',
    run() {
      for (const domain of DOMAINS) {
        const promoted = `I could build the ${domain.object} for your team.`;
        const recorded = gate(domain, { body: `${domain.second} ${promoted} ${domain.ending}`, mapping: { relevance: promoted } });
        assert(!recorded.passed && recorded.detail.includes('argumentMapping.relevance turns a use/workflow requirement into building or integrating it'), `${domain.key}/A: the recorded relevance is read (${detailOf(recorded)})`);
        assert(recorded.detail.includes(REPAIR), `${domain.key}/A: and the repair is the one it always named`);
        // B: the same sentence with its verb changed to use is the posting's own modality and passes with the span recorded.
        const faithful = `I could use the ${domain.object} for your team.`;
        const passing = gate(domain, { body: `${domain.second} ${faithful} ${domain.ending}`, mapping: { relevance: faithful } });
        assert(!passing.detail.includes('turns a use/workflow requirement'), `${domain.key}/B: build → use clears the guard (${detailOf(passing)})`);
      }
    },
  },
  {
    name: 'Modality, unrecorded: a sentence that turns the use of a tool into building it is rejected wherever it stands in the paragraph, recorded or not, in a claim span or a first-person proof sentence (4 places, 5 domains, A/B/C/D)',
    run() {
      for (const domain of DOMAINS) {
        const object = domain.object;
        // A: a capability sentence no span records (the budgets let a later paragraph leave its relevance out).
        for (const [place, sentence] of [
          ['a prospective sentence', `I could build the ${object} for your team.`],
          ['a capability sentence', `My experience integrating the ${object} runs deep.`],
          ['a gerund inside a clause', `I would be glad of the chance to start implementing the ${object} here.`],
        ]) {
          for (const body of [`${domain.second} ${sentence} ${domain.ending}`, `${sentence} ${domain.second} ${domain.ending}`, `${domain.second} ${domain.ending} ${sentence}`]) {
            const unrecorded = gate(domain, { body });
            assert(!unrecorded.passed && unrecorded.detail.includes('paragraph 3 says “') && unrecorded.detail.includes('which turns a use/workflow requirement into building or integrating it'),
              `${domain.key}/A: ${place} is read wherever it stands (${detailOf(unrecorded)})`);
            assert(unrecorded.detail.includes(REPAIR) && unrecorded.detail.includes(sentence.replace(/[.]$/u, '').slice(0, 24)), `${domain.key}/A: and the message quotes the sentence and names the repair`);
          }
        }
        // B: a claim span that does it is read too.
        const claim = `My experience integrating the ${object} runs deep.`;
        const claimed = gate(domain, { body: `${claim} ${domain.second} ${domain.ending}`, mapping: { claim } });
        assert(!claimed.passed && claimed.detail.includes('which turns a use/workflow requirement'), `${domain.key}/B: a claim span is read (${detailOf(claimed)})`);
        // C: and so is a first-person proof sentence that builds the thing in the present or as a gerund.
        const proof = `I led the crew building the ${object} for the sites.`;
        const proven = gate(domain, { body: `${proof} ${domain.ending}`, mapping: { proof } });
        assert(!proven.passed && proven.detail.includes('which turns a use/workflow requirement'), `${domain.key}/C: a first-person proof sentence is read (${detailOf(proven)})`);
        // D: only the paragraph's own jobNeedQuote counts. The same sentence in a paragraph bound to a posting sentence that asks for no use passes.
        const first = gate(domain, { body: `${domain.second} I could build the ${object} for your team. ${domain.ending}`, mapping: { jobNeedQuote: domain.posting[0] } });
        assert(!first.detail.includes('turns a use/workflow requirement'), `${domain.key}/D: bound to a requirement that does not ask for use, the sentence is not this guard's (${detailOf(first)})`);
      }
    },
  },
  {
    name: 'Modality, admitted and mutated: completed work, using the tool and building a different thing all pass, and one changed word flips each verdict (5 domains, A/B/C)',
    run() {
      for (const domain of DOMAINS) {
        const object = domain.object;
        // A: admitted.
        for (const [why, sentence] of [
          ['completed work, in the past tense', `I built the ${object} for the previous team.`],
          ['using the tool', `I used the ${object} on every shift.`],
          ['building something else', `I could build the ${domain.other} for your team.`],
          ['the thing the posting names, without a construction verb', `My experience with the ${object} runs deep.`],
        ]) {
          const admitted = gate(domain, { body: `${domain.second} ${sentence} ${domain.ending}` });
          assert(!admitted.detail.includes('turns a use/workflow requirement'), `${domain.key}/A: ${why} is admitted (${detailOf(admitted)})`);
        }
        // B: mutation of the sentence. One verb flips the verdict, both ways.
        const build = `I could build the ${object} for your team.`;
        assert(!gate(domain, { body: `${domain.second} ${build} ${domain.ending}` }).passed && !gate(domain, { body: `${domain.second} ${build.replace('build', 'use')} ${domain.ending}` }).detail.includes('turns a use/workflow requirement'), `${domain.key}/B: build → use flips it`);
        // C: mutation of the posting. If the need also asks for construction, the same sentence is the posting's own modality; restoring the need restores the verdict.
        const constructed = [domain.posting[0], domain.posting[1].replace(/^(\w+)/u, 'Build and $1').replace(/^Build and (\w)/u, (_match, letter) => `Build and ${letter.toLowerCase()}`)];
        const asked = gate(domain, { body: `${domain.second} ${build} ${domain.ending}`, posting: constructed });
        assert(constructed[1] !== domain.posting[1] && !asked.detail.includes('turns a use/workflow requirement'), `${domain.key}/C: when the posting itself asks to build, the sentence passes (${constructed[1]}) (${detailOf(asked)})`);
        assert(!gate(domain, { body: `${domain.second} ${build} ${domain.ending}` }).passed, `${domain.key}/C: and with the original need it fails again`);
      }
    },
  },
];
