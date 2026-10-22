// The functions the host requires of a cover letter's sentences, held against the checks themselves.
//
// The failure these tests pin. The repair rule told a writer to answer a flagged sentence that reviewers
// raised twice by deleting or shortening it "unless a function the host requires ... would be lost", and
// then listed those functions as the claim phrase and the relevance sentence of the first proof-bearing
// paragraph, a proof sentence in every proof-bearing paragraph and the closing's three parts, "only"
// those (the written doc said "all of these"). The list left out functions the host also reads: the
// opening must lead with the target work before any prior-employer or named-project evidence, the
// sentence that first names an employer must carry the candidate's role, and a paragraph must stay long
// enough for the letter's proportion limits. Paragraph 1's opener was the sentence reviewers flagged
// most, so the rule sent the writer into a host rejection its brief gave no warning of.
//
// What each group below proves, over four invented careers (ferry berth planning, bridge inspection,
// retail replenishment, seed bank curation), each a letter that passes the whole battery:
//   deletion   delete each sentence of each letter in turn: every check that newly fails is a check the
//              exported map names, so a function the gates enforce cannot go unnamed, and the checks
//              the experiment reaches include the opening, the role context, the argument links, the
//              proportion limits and the closing
//   mutation   the test is sensitive: take one check out of the map and the same deletions name an
//              unnamed check
//   rule       the repair rule prints the list from the constant and no longer says it is the whole of
//              what the host requires, the written doc says the same thing, and every function name
//              the map points at has its phrase in the list
//
// Nothing in production names any of the fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from './testHelpers.js';
import {
  HOST_REQUIRED_LETTER_FUNCTIONS, HOST_REQUIRED_LETTER_FUNCTION_CHECKS, checkParagraphArgumentLinks, evaluateCoverLetterChecks, paragraphHasCandidatePastProof, sentences,
} from '../../electron/ipc/coverLetterChecks.js';
import { BLIND_REPAIR_RAISED_CYCLES_RULE } from '../../electron/ipc/applicationRepairConvergence.js';

// A letter is a list of paragraphs; a paragraph has its sentences and, when it states an action of the candidate, the mapping the review would record (exact
// spans of the paragraph). citations: whether the letter cites career quotes (they license a closing noun; without them only the letter's own sentences do).
const DOMAINS = Object.freeze([
  {
    key: 'ferry berth planning', company: 'Alderbank Ferries', employer: 'Tidewater Lines', citations: true,
    posting: 'Plan daily berth schedules for the harbour terminals. Reconcile crew rosters against sailing timetables. Reduce turnaround delays through staged boarding.',
    quotes: ['Built the berth allocation sheet used by terminal crews at every sailing.', 'Wrote the roster reconciliation checklist that deck supervisors signed before each departure.'],
    paragraphs: [
      { sentences: ['A ferry leaves on time only when someone planned its berth the night before, and this Berth Planner role at Alderbank Ferries plans it.'] },
      {
        sentences: [
          'In my earlier planning role at Tidewater Lines, my berth scheduling experience began with a berth allocation sheet that I built for terminal crews to read before every sailing.',
          'Daily berth schedules for the harbour terminals depend on one sheet that every crew reads the same way.',
        ],
        mapping: { claim: 'my berth scheduling experience', proof: 'I built for terminal crews to read before every sailing', relevance: 'Daily berth schedules for the harbour terminals depend on one sheet that every crew reads the same way.', jobNeedQuote: 'Plan daily berth schedules for the harbour terminals.' },
      },
      {
        sentences: ['I wrote the roster checklist at Tidewater Lines that deck supervisors signed before each departure.', 'Disputed shifts fell to a handful by the end of the season.'],
        mapping: { proof: 'I wrote the roster checklist that deck supervisors signed before each departure.', jobNeedQuote: 'Reconcile crew rosters against sailing timetables.' },
      },
      { sentences: ['I welcome a conversation about how the berth allocation sheet I built could support your terminal schedules.'], mapping: { proof: 'the berth allocation sheet I built', jobNeedQuote: 'Reduce turnaround delays through staged boarding.' } },
    ],
  },
  {
    key: 'bridge inspection', company: 'Northgate County', employer: 'Pierson Engineering', citations: true,
    posting: 'Inspect highway bridges on a decade long cycle. Rate deck and bearing condition against county standards. Prioritize repair funding by structural risk.',
    quotes: ['Designed the bearing condition form used by field crews on every inspection.', 'Created the repair ranking sheet that the county board reviewed each spring.'],
    paragraphs: [
      { sentences: ['A bridge stays open because somebody read its bearings before the crack mattered, and this Bridge Inspector role at Northgate County reads them.'] },
      {
        sentences: [
          'As an inspector at Pierson Engineering, I designed a bearing condition form, and my inspection experience shows in how field crews rated every deck.',
          'Inspecting highway bridges on a decade long cycle depends on one form that every crew fills in the same way.',
          'Crews stopped rating bearings from memory.',
        ],
        mapping: { claim: 'my inspection experience', proof: 'I designed a bearing condition form', relevance: 'Inspecting highway bridges on a decade long cycle depends on one form that every crew fills in the same way.', jobNeedQuote: 'Inspect highway bridges on a decade long cycle.' },
      },
      {
        sentences: ['I created the repair ranking sheet at Pierson Engineering that the county board reviewed each spring.', 'Funding went first to the spans with the highest structural risk.'],
        mapping: { proof: 'I created the repair ranking sheet that the county board reviewed each spring.', jobNeedQuote: 'Prioritize repair funding by structural risk.' },
      },
      { sentences: ['I welcome a conversation about how my inspection work could support your bridge program.'] },
    ],
  },
  {
    key: 'retail replenishment', company: 'Marlow Grocers', employer: 'Hartfield Stores', citations: true,
    posting: 'Forecast weekly demand for fresh departments. Set reorder points for perishable lines. Cut spoilage through tighter delivery windows.',
    quotes: ['Developed the weekly demand sheet used by produce managers in forty stores.', 'Maintained the reorder point table that buyers checked before each order.'],
    paragraphs: [
      { sentences: ['Fresh shelves stay full when someone forecast the week before it started, and this Replenishment Analyst role at Marlow Grocers forecasts it.'] },
      {
        sentences: [
          'In my analyst role at Hartfield Stores, I developed a weekly demand sheet that produce managers used in every store.',
          'My forecasting practice rests on that sheet, and weekly demand for fresh departments depends on one sheet that every manager reads the same way.',
          'Managers stopped ordering from habit.',
        ],
        mapping: { claim: 'My forecasting practice rests on that sheet', proof: 'I developed a weekly demand sheet that produce managers used in every store', relevance: 'weekly demand for fresh departments depends on one sheet that every manager reads the same way', jobNeedQuote: 'Forecast weekly demand for fresh departments.' },
      },
      {
        sentences: ['I maintained the reorder point table at Hartfield Stores that buyers checked before each order.', 'Spoiled stock fell steadily through the second half of the year.'],
        mapping: { proof: 'I maintained the reorder point table that buyers checked before each order.', jobNeedQuote: 'Set reorder points for perishable lines.' },
      },
      { sentences: ['I welcome a conversation about how my forecasting work could support your fresh departments.'] },
    ],
  },
  {
    // No citations: the closing's authorship noun is licensed only by the letter's own sentence, so deleting that sentence must reject the closing.
    key: 'seed bank curation', company: 'Greenvale Seed Trust', employer: 'Eastmoor Collection', citations: false,
    posting: 'Catalogue incoming seed accessions to international standards. Test germination on a rolling schedule. Reduce lost accessions through label audits.',
    quotes: [],
    paragraphs: [
      { sentences: ['A seed is only useful if someone can find it again, and this Collections Curator role at Greenvale Seed Trust makes sure they can.'] },
      {
        sentences: [
          'As a curator at Eastmoor Collection, I created an accession ledger, and my cataloguing background shows in how every donation was recorded.',
          'Incoming seed accessions reach international standards only when every record starts from one ledger.',
          'Curators stopped keeping private notebooks.',
        ],
        mapping: { claim: 'my cataloguing background', proof: 'I created an accession ledger', relevance: 'Incoming seed accessions reach international standards only when every record starts from one ledger.', jobNeedQuote: 'Catalogue incoming seed accessions to international standards.' },
      },
      {
        sentences: ['I wrote the germination protocol at Eastmoor Collection that volunteers followed for each test batch.', 'Failed batches were traced to the shelf within a day.'],
        mapping: { proof: 'I wrote the germination protocol that volunteers followed for each test batch.', jobNeedQuote: 'Test germination on a rolling schedule.' },
      },
      { sentences: ['I welcome a conversation about how the accession ledger I built could support your seed vault.'], mapping: { proof: 'the accession ledger I built', jobNeedQuote: 'Reduce lost accessions through label audits.' } },
    ],
  },
]);

const spanPresent = (span, paragraph) => paragraph.toLowerCase().includes(String(span).toLowerCase());

// The audit the review would record for these paragraphs after an edit: it keeps every span the paragraph still holds, falls back to a proof sentence when the
// proof span is gone, and records nothing for a paragraph that no longer states a candidate action.
function planOf(paragraphs) {
  return {
    paragraphs: paragraphs.map(paragraph => {
      const body = paragraph.sentences.join(' ');
      if (!paragraph.mapping) return { argumentMapping: null };
      const kept = {};
      for (const field of ['claim', 'proof', 'relevance']) if (paragraph.mapping[field] && spanPresent(paragraph.mapping[field], body)) kept[field] = paragraph.mapping[field];
      if (!kept.proof) {
        if (!paragraphHasCandidatePastProof(body)) return { argumentMapping: null };
        kept.proof = sentences(body).find(sentence => paragraphHasCandidatePastProof(sentence));
      }
      return { argumentMapping: { ...kept, jobNeedQuote: paragraph.mapping.jobNeedQuote } };
    }),
  };
}

// Every check the host runs on a final letter: the editorial battery as production runs it (checks
// whose disposition is 'off' are not run) and the audit's argument links.
function battery(domain, paragraphs) {
  const texts = paragraphs.map(paragraph => paragraph.sentences.join(' '));
  return [
    ...evaluateCoverLetterChecks({
      plan: {}, paragraphs: texts, evidence: { roles: [{ company: domain.employer }], projects: [], bullets: [] }, jobText: domain.posting, researchText: '', companyName: domain.company,
      paragraphCitations: domain.citations ? paragraphs.map(() => domain.quotes) : null,
      activeOnly: true,
    // paragraph-openers is an advisory record of opening-word variety that never rejects a letter, and these
    // fixtures predate that house rule, so the battery here is every rejecting or advisory check except it.
    }).filter(check => check.id !== 'paragraph-openers'),
    checkParagraphArgumentLinks({ plan: planOf(paragraphs), paragraphs: texts, jobText: domain.posting }),
  ];
}

// Delete each sentence in turn (a paragraph that loses its last sentence goes with it) and report, per deletion, the checks that fail now and did not before.
function deletions(domain) {
  const before = new Set(battery(domain, domain.paragraphs).filter(check => !check.passed).map(check => check.id));
  const rows = [];
  domain.paragraphs.forEach((paragraph, p) => paragraph.sentences.forEach((sentence, s) => {
    const edited = domain.paragraphs.map((item, index) => (index === p ? { ...item, sentences: item.sentences.filter((_, i) => i !== s) } : item)).filter(item => item.sentences.length);
    const newly = battery(domain, edited).filter(check => !check.passed && !before.has(check.id)).map(check => check.id);
    rows.push({ at: `paragraph ${p + 1} sentence ${s + 1}`, sentence, newly });
  }));
  return rows;
}

const unnamed = (rows, map) => [...new Set(rows.flatMap(row => row.newly))].filter(id => !Object.hasOwn(map, id)).sort();

// What the list says for each function name the map points at.
const PHRASE_OF = Object.freeze({
  'claim-and-relevance': 'a claim phrase and a sentence relating its proof to the job need',
  proof: 'a proof sentence in every proof-bearing paragraph',
  opening: 'an opening that leads with the target work',
  proportion: 'proportion limits',
});

const flat = value => String(value).replace(/\s+/gu, ' ').replace(/[’‘]/gu, "'");

export default [
  {
    name: 'Host functions, baseline: each fixture letter passes the whole battery and the audit gate, so a failure after a deletion is the deletion\'s (4 domains)',
    run() {
      for (const domain of DOMAINS) {
        const failing = battery(domain, domain.paragraphs).filter(check => !check.passed).map(check => `${check.id}: ${check.detail}`);
        assert(failing.length === 0, `${domain.key}: the letter passes every check (${failing.join(' | ')})`);
      }
    },
  },
  {
    name: 'Host functions, deletion: every check that newly fails when one sentence of a letter is deleted is named by the exported map, and the checks reached include the opening, the role context, the argument links and the proportion limits, and never the closing, whose check is off (4 domains, A/B/C)',
    run() {
      const reached = new Set();
      for (const domain of DOMAINS) {
        const rows = deletions(domain);
        assert(rows.length === domain.paragraphs.reduce((sum, paragraph) => sum + paragraph.sentences.length, 0), `${domain.key}/A: every sentence was deleted in turn`);
        // A: nothing the gates enforce goes unnamed.
        const missing = unnamed(rows, HOST_REQUIRED_LETTER_FUNCTION_CHECKS);
        assert(missing.length === 0, `${domain.key}/A: checks that reject a deletion and are named by no function: ${missing.join(', ')}`);
        for (const row of rows) for (const id of row.newly) reached.add(id);
      }
      // B: the test is not vacuous in the other direction either: some deletions lose no function at all (a trailing sentence of a three-sentence paragraph, the closing).
      const allRows = DOMAINS.flatMap(domain => deletions(domain));
      assert(allRows.some(row => row.newly.length === 0) && allRows.some(row => row.newly.length > 0), 'B: some deletions are free and some are not');
      for (const id of ['opening-artifact-context', 'prior-employer-opening', 'paragraph-argument-links', 'letter-proportion']) {
        assert(reached.has(id), `C: the experiment reaches ${id} (reached ${[...reached].join(', ')})`);
        assert(Object.hasOwn(HOST_REQUIRED_LETTER_FUNCTION_CHECKS, id), `C: and the map names it`);
      }
      // The closing is the writer's choice: its check is off, so no production deletion reports it and the map does not name it.
      // The seed bank letter has no cited quote, so deleting the sentence that licenses its closing noun is the deletion that used to reject the closing.
      const seed = DOMAINS.find(domain => domain.key === 'seed bank curation');
      const rows = deletions(seed);
      assert(rows.length > 0 && !rows.some(row => row.newly.includes('direct-welcome-closing')), `C: no deletion of the seed bank letter reports direct-welcome-closing (${rows.map(row => `${row.at}: ${row.newly.join('+') || 'none'}`).join('; ')})`);
      assert(!reached.has('direct-welcome-closing'), `C: no production deletion in any domain reports direct-welcome-closing (reached ${[...reached].join(', ')})`);
      assert(!Object.hasOwn(HOST_REQUIRED_LETTER_FUNCTION_CHECKS, 'direct-welcome-closing'), 'C: and the map no longer names the closing check');
    },
  },
  {
    name: 'Host functions, mutation: take one check out of the map and the same deletions name a check the map no longer covers, for each check the experiment reaches (4 domains, A/B/C)',
    run() {
      const rows = DOMAINS.flatMap(domain => deletions(domain));
      assert(unnamed(rows, HOST_REQUIRED_LETTER_FUNCTION_CHECKS).length === 0, 'A: the real map covers every deleted-sentence failure');
      const reached = [...new Set(rows.flatMap(row => row.newly))].sort();
      // The closing check is off, so the experiment reaches exactly the four checks production runs that lose a function.
      assert(reached.join() === 'letter-proportion,opening-artifact-context,paragraph-argument-links,prior-employer-opening', `the experiment reaches exactly four distinct checks (${reached.join(', ')})`);
      for (const id of reached) {
        const mutated = Object.fromEntries(Object.entries(HOST_REQUIRED_LETTER_FUNCTION_CHECKS).filter(([key]) => key !== id));
        const gaps = unnamed(rows, mutated);
        assert(gaps.length === 1 && gaps[0] === id, `B: without ${id} in the map the test names it (${gaps.join(', ')})`);
      }
      // C: an empty map names every failure.
      assert(unnamed(rows, {}).join() === reached.join(), 'C: with no map every reached check is unnamed');
    },
  },
  {
    name: 'Host functions, rule: the repair rule prints the list from the constant and does not claim it is the whole of what the host requires, every function the map points at has its phrase in the list, and the written doc says the same (A/B/C)',
    run() {
      const raised = BLIND_REPAIR_RAISED_CYCLES_RULE;
      // A: the rule.
      assert(raised.includes(`Among the functions the host requires of a cover-letter paragraph are these: ${HOST_REQUIRED_LETTER_FUNCTIONS}.`), 'the rule prints the list from the constant, as a part of what the host requires');
      assert(!/requires only|all of these|the only functions/iu.test(raised), 'and does not claim the list is complete');
      assert(raised.includes('unless a function the host requires of that paragraph would be lost'), 'and keeps the exception that the list explains');
      // B: the map and the list agree: every function name the map points at has its phrase in the printed list, and no phrase is printed for a name the map does not use.
      const used = new Set(Object.values(HOST_REQUIRED_LETTER_FUNCTION_CHECKS).flat());
      assert([...used].sort().join() === Object.keys(PHRASE_OF).sort().join(), `the map points at exactly the functions this test knows (${[...used].join(', ')})`);
      for (const name of used) assert(HOST_REQUIRED_LETTER_FUNCTIONS.includes(PHRASE_OF[name]), `the list says the ${name} function: ${PHRASE_OF[name]}`);
      for (const [id, names] of Object.entries(HOST_REQUIRED_LETTER_FUNCTION_CHECKS)) assert(Array.isArray(names) && names.length >= 1 && Object.isFrozen(names), `${id} names at least one function, immutably`);
      // The closing is the writer's choice: no function names it, and neither the list nor the rule prescribes its parts.
      assert(!used.has('closing') && !/\bclosing\b/iu.test(HOST_REQUIRED_LETTER_FUNCTIONS), `the list names no closing function: ${HOST_REQUIRED_LETTER_FUNCTIONS}`);
      assert(!raised.includes('the closing’s asset, action and target parts'), 'and the rule no longer prints the closing’s parts');
      // The list stays one grammatical series, "A, B, C, and D".
      assert(/^a claim phrase and a sentence relating its proof to the job need in [^,]+, a proof sentence/u.test(HOST_REQUIRED_LETTER_FUNCTIONS)
        && HOST_REQUIRED_LETTER_FUNCTIONS.endsWith(', a proof sentence in every proof-bearing paragraph, an opening that leads with the target work, with the candidate’s role stated wherever a prior employer or named project is first named, and paragraphs long enough to stay within the letter’s proportion limits'),
        `the list is the four functions in one series: ${HOST_REQUIRED_LETTER_FUNCTIONS}`);
      // C: the written doc prints exactly the constant's list (apostrophes and line breaks aside), with no closing parts,
      // and no longer says "all of these".
      const doc = flat(fs.readFileSync(path.resolve('local_ai/PASTE_BACK_APPLICATION.md'), 'utf8'));
      assert(!doc.includes('closing\'s asset, action and target parts'), 'the doc no longer prints the closing\'s asset, action and target parts');
      assert(doc.includes(`Among the functions the app requires of a cover-letter paragraph are these: ${flat(HOST_REQUIRED_LETTER_FUNCTIONS)}.`), 'PASTE_BACK_APPLICATION.md prints the list');
      assert(!doc.includes('those functions are all of these'), 'and no longer calls it complete');
      // The mutation: a list without the opening function fails the doc comparison.
      const withoutOpening = flat(HOST_REQUIRED_LETTER_FUNCTIONS).replace(', an opening that leads with the target work, with the candidate\'s role stated wherever a prior employer or named project is first named', '');
      assert(withoutOpening !== flat(HOST_REQUIRED_LETTER_FUNCTIONS) && !doc.includes(`are these: ${withoutOpening}`), 'a list that leaves the opening out is not what the doc says');
    },
  },
];
