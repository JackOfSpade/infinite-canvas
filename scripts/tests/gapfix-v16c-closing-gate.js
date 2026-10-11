// The closing gate and the closing guidance: what the gate licenses, and what a writer is told.
//
// The failures these tests pin (round-2 convergence review of the v16 work).
//
//   1  “I built that <noun> ...” licensed no noun. The authorship form “the <noun> I built” is
//      accepted when the noun is one the letter already used for the candidate's own work, and the
//      noun is read as the head of the object of an earlier first-person sentence with an authorship
//      verb. The reader stopped at “that” because it is also a relative pronoun, so a demonstrative
//      object (“I built that hub ...”, the natural way to refer back to what a claim phrase named)
//      licensed nothing and the closing was rejected with “missing its asset half”. The same reader
//      split the clause on every “and”, “or” and comma and took every chunk for an object, so the
//      subject of a second clause (“..., and the drivers loved the result”) and the words that follow
//      the verb of a relative clause (“the planner I built reduced empty trips”) became nouns the
//      candidate had “built”.
//   2  The closing guidance omitted what the gate does: an authorship clause is a first-person past
//      action, so a closing that holds one is a proof-bearing paragraph that owes the review an
//      argumentMapping (a proof span and a jobNeedQuote); a closing opened by a modal is rejected in
//      favour of the direct present; and the action half is a closed list of verbs.
//
// What each group below proves, over five invented careers in unrelated fields (ferry berth
// planning, veterinary intake, bridge inspection, retail replenishment, seed bank curation):
//   determiners   a, the, that, this, my, our (and the plural these / those) each license the noun
//                 they introduce (30 closings); the same sentence with a relative “that” does not,
//                 and one word flips it back
//   objects       coordinated objects of one verb, coordinated verbs and a verb chain license each
//                 noun; the subject of a second clause, a relative clause, the words after a
//                 preposition and the object of a different verb license nothing
//   relative      a noun a relative clause modifies is the thing built; a time or place phrase in
//                 front of “I built” does not make it one
//   action        the verbs the guidance prints are exactly the verbs the gate accepts
//   proof         the authorship verbs the guidance names make the closing proof-bearing under the
//                 gate, the others do not, and the review is rejected without the mapping
//   invitation    the direct present, the modal, the deferential and the choice forms behave as the
//                 guidance says
//   documents     the routine, the skill file, the style guide and the written protocol state the closed
//                 verb list and the proof-bearing closing, from the same constants
//
// Nothing in production names any of the fixtures.
import { assert } from './testHelpers.js';
import {
  CANDIDATE_AUTHORSHIP_VERBS, CLOSING_ACTION_MODALS, CLOSING_ACTION_MODAL_VERBS, CLOSING_ACTION_OPEN_PARTICIPLES, PAST_PROOF_VERBS,
  checkDirectWelcomeClosing,
} from '../../electron/ipc/coverLetterChecks.js';

// a / b / c: three artifacts no fixed noun list knows (head noun last); crew: who uses them; outcome: what the work did (an object the closing must not claim to have built).
const DOMAINS = Object.freeze([
  {
    key: 'ferry berth planning', a: 'allocation sheet', b: 'roster checklist', c: 'boarding card', crew: 'deckhands', side: 'your terminal schedules', outcome: 'turnaround delays', place: 'the terminal',
    posting: 'Plan daily berth schedules for the harbour terminals. Reconcile crew rosters against sailing timetables. Reduce turnaround delays through staged boarding.',
    opening: 'A ferry leaves on time only when someone planned its berth the night before, and this role plans it.',
    claim: 'My berth scheduling experience began on a regional ferry line.',
    natural: 'Daily berth schedules for the harbour terminals depend on one sheet that every crew reads the same way.',
  },
  {
    key: 'veterinary intake', a: 'intake form', b: 'boarding chart', c: 'discharge folder', crew: 'technicians', side: 'your front desk', outcome: 'waiting room queues', place: 'the clinic',
    posting: 'Greet arriving owners and record each animal at the front desk. Keep boarding records current for every kennel. Shorten waiting room queues at peak hours.',
    opening: 'An anxious owner judges a clinic by its first minute, and this role owns that minute.',
    claim: 'My intake coordination practice began in a busy animal hospital.',
    natural: 'Arriving owners are recorded at the front desk smoothly when every intake starts from one form.',
  },
  {
    key: 'bridge inspection', a: 'condition rubric', b: 'ranking sheet', c: 'access permit', crew: 'inspectors', side: 'your bridge program', outcome: 'repair backlogs', place: 'the county',
    posting: 'Inspect highway bridges on a decade long cycle. Rate deck and bearing condition against county standards. Prioritize repair funding by structural risk.',
    opening: 'A bridge stays open because somebody read its bearings before the crack mattered, and this role reads them.',
    claim: 'My structural inspection background comes from a state transport office.',
    natural: 'Highway bridges on a decade long cycle need one rubric that every inspector fills in the same way.',
  },
  {
    key: 'retail replenishment', a: 'demand grid', b: 'reorder table', c: 'delivery calendar', crew: 'buyers', side: 'your fresh departments', outcome: 'spoiled stock', place: 'the region',
    posting: 'Forecast weekly demand for fresh departments. Set reorder points for perishable lines. Cut spoilage through tighter delivery windows.',
    opening: 'Fresh shelves stay full when someone forecast the week before it started, and this role forecasts it.',
    claim: 'My demand forecasting approach began with a regional grocery chain.',
    natural: 'Weekly demand for fresh departments is forecast best from one grid that every buyer reads the same way.',
  },
  {
    key: 'seed bank curation', a: 'accession ledger', b: 'germination log', c: 'storage label', crew: 'curators', side: 'your seed vault', outcome: 'lost accessions', place: 'the collection',
    posting: 'Catalogue incoming seed accessions to international standards. Test germination on a rolling schedule. Reduce lost accessions through label audits.',
    opening: 'A seed is only useful if someone can find it again, and this role makes sure they can.',
    claim: 'My seed cataloguing background comes from a university collection.',
    natural: 'Incoming seed accessions reach international standards only when every record starts from one ledger.',
  },
]);

const head = noun => noun.split(' ').at(-1);
const closingFor = (noun, side) => `I welcome a conversation about how the ${noun} I built could support ${side}.`;
// Does the closing on `noun` pass when the letter holds `earlier` before it? The verdict is the whole check's.
const verdictOf = (earlier, noun, side, options) => checkDirectWelcomeClosing([...[].concat(earlier), closingFor(noun, side)], '', options);
const accepted = (domain, earlier, noun) => verdictOf(earlier, noun, domain.side).passed;
const assetHalfMissing = (domain, earlier, noun) => {
  const verdict = verdictOf(earlier, noun, domain.side);
  return !verdict.passed && verdict.detail.includes('missing its asset half');
};
const detailOf = check => `${check.id}: ${check.detail}`;

export default [
  {
    name: 'Closing determiners: “I built <a / the / that / this / my / our> <noun> ...” licenses the noun it introduces (and these / those the plural), so the closing “the <noun> I built” passes; a relative “that” licenses nothing, and one word flips it (30 closings, 5 domains, A/B/C)',
    run() {
      for (const domain of DOMAINS) {
        const noun = domain.a;
        // The premise: no fixed list knows the noun, so a letter that never used it rejects the closing.
        assert(assetHalfMissing(domain, 'I kept the incoming records current for the whole team.', noun), `${domain.key}/premise: ${noun} is on no fixed list`);
        // A: every determiner introduces the noun and licenses it (a mutation of the determiner alone never changes the verdict).
        for (const determiner of ['a', 'the', 'that', 'this', 'my', 'our']) {
          const sentence = `I built ${determiner} ${noun} with ${domain.crew} in mind.`;
          const verdict = verdictOf(sentence, noun, domain.side);
          assert(verdict.passed, `${domain.key}/A: “${sentence}” licenses “the ${head(noun)} I built” (${detailOf(verdict)})`);
        }
        for (const determiner of ['these', 'those']) {
          const sentence = `I built ${determiner} ${noun}s for ${domain.crew}.`;
          assert(accepted(domain, sentence, noun), `${domain.key}/A: “${sentence}” licenses the singular (${sentence})`);
        }
        // B: a relative or complementizer “that” introduces no noun: the verb after it begins the clause, so the noun after the verb is not what “I built”.
        const relative = `I built that replaced the old ${noun} for ${domain.crew}.`;
        assert(assetHalfMissing(domain, relative, noun), `${domain.key}/B: “${relative}” has no object (“that” is a relative pronoun) and so licenses nothing`);
        for (const bare of [`I built that.`, `I built that in a week.`, `I wrote that the ${noun} was sound.`, `I built that and shipped it to ${domain.crew}.`]) {
          assert(assetHalfMissing(domain, bare, noun) && assetHalfMissing(domain, bare, domain.b), `${domain.key}/B: “${bare}” names no noun the candidate made`);
        }
        // C: one word flips it. Remove “replaced the old” from the relative sentence and “that” becomes a demonstrative; put it back and it is a relative again.
        const demonstrative = relative.replace(' replaced the old', '');
        assert(demonstrative !== relative && accepted(domain, demonstrative, noun), `${domain.key}/C: without the verb, “${demonstrative}” licenses the noun`);
        assert(assetHalfMissing(domain, demonstrative.replace(`that ${noun}`, `that replaced the old ${noun}`), noun), `${domain.key}/C: and with the verb put back it does not`);
        // The renamed artifact is never licensed by any of these sentences.
        assert(assetHalfMissing(domain, `I built that ${noun} with ${domain.crew} in mind.`, 'visitor map'), `${domain.key}/C: a noun the letter never used is still rejected`);
      }
    },
  },
  {
    name: 'Closing objects: the direct object phrases of the authorship verb license their nouns; the subject of a second clause, the object of a different verb, a relative clause and the words after a preposition license none (13 shapes, 5 domains, A/B/C)',
    run() {
      for (const domain of DOMAINS) {
        const { a, b, c, crew, outcome } = domain;
        const heads = { a: head(a), b: head(b), c: head(c) };
        // A: coordinated objects of one verb, coordinated verbs, and a chain of verbs sharing one object each license every noun the clause makes.
        const licensed = [
          [`I built a ${a} and a ${b}.`, [a, b]],
          [`I built the ${a}, the ${b} and a ${c}.`, [a, b, c]],
          [`I built the ${a} or the ${b} for ${crew}.`, [a]],
          [`I designed, built and shipped the ${a}.`, [a]],
          [`I built, tested and deployed the ${a}.`, [a]],
          [`I designed the ${b} and built the ${a}.`, [a, b]],
          [`I developed ${a}s and ${b}s for ${crew}.`, [a, b]],
        ];
        for (const [sentence, nouns] of licensed) {
          for (const noun of nouns) assert(accepted(domain, sentence, noun), `${domain.key}/A: “${sentence}” licenses “the ${head(noun)} I built”`);
        }
        // B: what is NOT a direct object of the verb licenses nothing, and what precedes it still does.
        const notObjects = [
          [`I built the ${a}, and the ${crew} loved the ${c}.`, [a], [c, crew]],
          [`I built the ${a}, and ${crew} reviewed every weekly ${c}.`, [a], [c, crew]],
          [`I built the ${a}, and the ${crew} were pleased.`, [a], [crew]],
          [`I built the ${a} for ${crew} and ${c}.`, [a], [c]],
          [`I built the ${a}, which cut ${outcome}.`, [a], [outcome]],
          [`I built the ${a} and tested the ${c}.`, [a], [c]],
          [`I built the ${a}, tested the ${c} and shipped the ${b}.`, [a, b], [c]],
          [`I led the ${b}, and the team shipped the ${c}.`, [b], [c]],
          [`I built the ${a} the ${crew} used and the ${c}.`, [a], [c]],
        ];
        for (const [sentence, yes, no] of notObjects) {
          for (const noun of yes) assert(accepted(domain, sentence, noun), `${domain.key}/B: “${sentence}” still licenses “the ${head(noun)} I built”`);
          for (const noun of no) assert(assetHalfMissing(domain, sentence, noun), `${domain.key}/B: “${sentence}” does not license “${noun}” (${detailOf(verdictOf(sentence, noun, domain.side))})`);
        }
        // C: mutation. Take the clause out, or turn the second clause into a coordinated object, and the noun is licensed; put the subject back and it is not.
        const clause = `I built the ${a}, and the ${crew} loved the ${c}.`;
        const coordinated = `I built the ${a}, and the ${c}.`;
        assert(assetHalfMissing(domain, clause, c) && accepted(domain, coordinated, c), `${domain.key}/C: dropping “the ${crew} loved” makes “${c}” a coordinated object`);
        assert(assetHalfMissing(domain, `I built the ${a}, and the ${crew} loved the ${c}.`, heads.c), `${domain.key}/C: and putting it back removes the license`);
        // The first object of a clause whose verb is not an authorship verb is not authored at all.
        assert(assetHalfMissing(domain, `I reviewed the ${a} for ${crew}.`, a) && assetHalfMissing(domain, `I tested the ${a}, and shipped nothing else.`, a), `${domain.key}/C: a verb outside the authorship list licenses nothing`);
      }
    },
  },
  {
    name: 'Closing relative clauses: the noun a relative clause modifies is the thing built, the words after the verb are not, and a time or place phrase before “I built” does not make a relative clause (9 shapes, 5 domains, A/B/C)',
    run() {
      for (const domain of DOMAINS) {
        const { a, b, c, crew, outcome, place } = domain;
        const relatives = [
          `The ${a} I built reduced ${outcome}.`,
          `The ${a} that I built reduced ${outcome}.`,
          `My ${a}, which I built, reduced ${outcome}.`,
          `${a[0].toUpperCase()}${a.slice(1)}s that I built reduced ${outcome}.`,
          `Last quarter the ${a} I built cut ${outcome} across ${place}.`,
        ];
        for (const sentence of relatives) {
          assert(accepted(domain, sentence, a), `${domain.key}/A: “${sentence}” says the candidate built the ${head(a)}`);
          assert(assetHalfMissing(domain, sentence, outcome), `${domain.key}/A: and not “${outcome}”, which the ${head(a)} acted on (${sentence})`);
        }
        // B: a phrase in front of the clause that is a preposition's object or a time phrase leaves the object where it was.
        const directs = [
          `At ${place} I built ${a}s for ${crew}.`,
          `This summer I built ${a}s for ${crew}.`,
          `Using the old ${b} I built ${c}s for ${crew}.`,
          `In the first year I built a ${a} for ${crew}.`,
        ];
        const nouns = [a, a, c, a];
        directs.forEach((sentence, index) => assert(accepted(domain, sentence, nouns[index]), `${domain.key}/B: “${sentence}” is a main clause whose object is “${nouns[index]}”`));
        // The noun that sat in the preposition's object is not licensed.
        assert(assetHalfMissing(domain, directs[2], b), `${domain.key}/B: “${directs[2]}” does not say the candidate built the ${head(b)}`);
        // C: a relative clause whose antecedent is someone else's work does not license the closing, and a clause that merely mentions the noun does not either.
        for (const sentence of [`The ${a} I inherited reduced ${outcome}.`, `The ${a} I used reduced ${outcome}.`, `The ${a} the ${crew} built reduced ${outcome}.`]) {
          assert(assetHalfMissing(domain, sentence, a), `${domain.key}/C: “${sentence}” is not authorship`);
        }
        // Flip one word: the verb of the relative clause decides.
        assert(accepted(domain, `The ${a} I built reduced ${outcome}.`, a) && assetHalfMissing(domain, `The ${a} I used reduced ${outcome}.`, a), `${domain.key}/C: built → used flips the verdict`);
      }
    },
  },{
    name: 'Closing unchanged: twenty shapes the reader already read, in every domain, license exactly the nouns the earlier reader licensed (golden recorded from the build before this change, 5 domains)',
    run() {
      // Recorded by running the reader this change replaced on each template over the five domains: the nouns (a, b, c: the three artifacts; crew: who used them) whose closing it accepted.
      const GOLDEN = [
        ['I built a {a} and a {b}.', 'a+b'], ['I built the {a}, the {b} and a {c}.', 'a+b+c'], ['I designed the {b} and built the {a}.', 'a+b'], ['I built the {a} for {crew}.', 'a'],
        ['I built a {a} that replaced the old {b}.', 'a'], ['I built a {a} archive for {crew}.', ''], ['I used the {a} that the previous team left.', ''],
        ['The previous team built a {a} that I inherited.', ''], ['The {a} builds itself each night.', ''], ['I built the schedule for the {a}.', ''], ['I kept a {a} that {crew} followed.', ''],
        ['I built something for the whole team.', ''], ['I wrote the {a}.', 'a'], ['I built the {a} used by every crew.', 'a'], ['I created our {a} and our {b}.', 'a+b'],
        ['We built the {a}, which {crew} trusted.', 'a'], ['I led the {a} and owned the {b}.', 'a+b'], ['I maintained the {a}; {crew} loved the {b}.', 'a'],
        ['I built a {a} using the {b}.', 'a'], ['I shipped the {a} to {crew}.', 'a'],
      ];
      for (const domain of DOMAINS) {
        const nouns = [['a', domain.a], ['b', domain.b], ['c', domain.c], ['crew', domain.crew]];
        for (const [template, expected] of GOLDEN) {
          const sentence = template.replaceAll('{a}', domain.a).replaceAll('{b}', domain.b).replaceAll('{c}', domain.c).replaceAll('{crew}', domain.crew);
          const licensed = nouns.filter(([, noun]) => accepted(domain, sentence, noun)).map(([key]) => key).join('+');
          assert(licensed === expected, `${domain.key}: “${sentence}” licenses [${licensed}], as it always did [${expected}]`);
        }
      }
    },
  },];
