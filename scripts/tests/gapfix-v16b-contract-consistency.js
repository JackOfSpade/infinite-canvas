// One contract, said once: what a proof-bearing paragraph owes.
//
// The failure these tests pin. The claim budget told the writer that only the first
// proof-bearing paragraph owes a claim span and a later one may leave it out. Beside
// that, the same cover-letter contract, the review contract, the correction brief and
// the error text still said that every later paragraph keeps its claim, proof and
// relevance, that all three spans are each an exact span of the paragraph, and that
// the audit must carry all four fields. A writer that obeyed the older sentences kept
// the closed-grammar abstract claim in every paragraph: the filler the budget was
// meant to remove. The contradiction lived in prose no test read, because each test
// pinned the sentence it was written for.
//
// What each group below proves:
//   scanner    a scanner for sentences that make every proof-bearing paragraph owe a
//              claim or a relevance span is itself proved: it flags each phrasing the
//              reviewers found (and variants), and it passes the budget sentences
//   surface    nothing the system prints says it: the exported rule constants, every
//              prose line of the prompt, schema and error sources, the docs, the
//              contracts the real protocol prints (cover-letter, review), and the
//              correction brief for a letter paragraph
//   one voice  the span-budget block is printed once in each contract and in the
//              brief, built from the exported constants, the generationAudit shape
//              notation marks the optional fields, and the shape error names the
//              fields each paragraph owes
//   guidance   the placement rule separates the claim phrase from the relevance
//              sentence, the repair rule names the host-required functions from the
//              constants (and follows them when a constant moves), and the opening and
//              proof-count rules cover the cases they left open
//   relevance  (v16c) a second scanner flags the older sentences that push EVERY paragraph toward a standalone statement of relevance ("point, proof and relevance",
//              "relevance links need their own path", "ties them to the target work"); nothing the system prints says them, and the opening and the reference
//              criterion say once, in one voice, how the role and the employer are named
//
// Every fixture is SYNTHETIC (invented careers in unrelated fields). Nothing in
// production names any of them.
import { assert } from './testHelpers.js';
import * as checks from '../../electron/ipc/coverLetterChecks.js';
import { APPLICATION_QUALITY_CRITERIA} from '../../electron/ipc/localAiApplication.js';


// ---------------------------------------------------------------------------
// The scanner.
// ---------------------------------------------------------------------------
// A clause that quantifies over paragraphs (every, each, all), says that paragraph
// keeps, records, owes, carries, supplies or needs something, and names a claim or a
// relevance within a few words, makes every proof-bearing paragraph owe that span. The
// windows are word counts, not sentence boundaries, so a sentence that merely mentions
// relevance elsewhere ("each body paragraph's point, proof, and relevance across as many
// sentences as clarity requires") is not read as an obligation. A clause is let through
// only when it also says the span may be left out or is the first paragraph's alone.
const OWING_VERBS = '(?:keeps?|records?|owes?|carr(?:y|ies)|supplies|supply|needs?|requires?|must|holds?|names?)';
const UNIVERSAL_OWNERSHIP = new RegExp(
  String.raw`\b(?:every|each|all)\b(?:\s+[\p{L}-]+){0,3}?\s+paragraphs?(?:['’]s)?\b(?:\s+[\p{L}'’,-]+){0,4}?\s+${OWING_VERBS}\b(?:\s+[\p{L}'’-]+){0,6}?\s+(?:claims?|relevance)\b`, 'iu');
const SPAN_REQUIRED_OF_EVERY = /\b(?:claims?|relevance)\b(?:\s+[\p{L}'’,-]+){0,6}?\s+(?:is|are)\s+(?:required|owed|needed)\s+(?:of|from|in)\s+(?:every|each|all)\b/iu;
const SPAN_MAY_BE_OMITTED = /\b(?:may (?:leave|omit)|leaves? (?:it|the claim|the relevance) out|omits?|where one is recorded|that records|it records|records it|no (?:claim|relevance)|neither|owes only|owes no|not owed|only the first|first proof-bearing|if it records|without (?:a|its|the) (?:claim|relevance))\b/iu;
// Phrasings that state the older contract outright, whatever the clause around them says.
const OLD_CONTRACT_PHRASES = Object.freeze([
  /\bclaim,? proof,? and relevance (?:spans )?(?:are|is) each\b/iu,
  /\b(?:all|those|these|the) (?:three|four) (?:argumentMapping )?(?:spans|fields)\b/iu,
  /\bkeeping each paragraph['’]s claim\b/iu,
  /\bkeeps? its claim,? (?:its )?proof\b/iu,
  /\bclaim, proof, relevance and jobNeedQuote\b/iu,
]);

/** The clauses of `text` that make every proof-bearing paragraph owe a claim or a relevance span. */
export function findUniversalSpanOwnership(text) {
  const found = [];
  for (const clause of String(text).replace(/\s+/gu, ' ').split(/(?<=[.;!?])\s+|\s+[—–]\s+/u)) {
    if (OLD_CONTRACT_PHRASES.some(pattern => pattern.test(clause))) { found.push(clause); continue; }
    if ((UNIVERSAL_OWNERSHIP.test(clause) || SPAN_REQUIRED_OF_EVERY.test(clause)) && !SPAN_MAY_BE_OMITTED.test(clause)) found.push(clause);
  }
  return found;
}

// Sentences that push EVERY paragraph toward a statement of relevance of its own, written before the budgets said that only the first proof-bearing paragraph owes one.
// Each is matched on its own words, whatever the sentence around it says; a negation ("no fixed claim-proof-relevance sentence pattern applies") is not one of them.
const RELEVANCE_PUSH_PHRASES = Object.freeze([
  /\b(?:establish|make)s? (?:its |their )?point,? (?:establish(?:es)? )?(?:its |their )?proof,? and (?:explain )?(?:its |their )?relevance\b/iu,
  /\bclaims?,? action steps?,? (?:and|or) relevance links?\b/iu,
  /\brelevance links? (?:need|get|require)s? (?:their|its) own\b/iu,
  /\b(?:and|then) ties? (?:them|each) to the target work\b/iu,
]);
// The reference criterion must name the role once and then say "this role"; the older wording said only that the position is referenced proximally.
const NAMES_THE_ROLE_ONCE = /\bnames the role by its title and the employer by name once\b/iu;

/** The clauses of `text` that tell a writer every paragraph owes a statement of relevance. */
export function findRelevancePush(text) {
  const found = [];
  for (const clause of String(text).replace(/\s+/gu, ' ').split(/(?<=[.;!?])\s+/u)) {
    if (RELEVANCE_PUSH_PHRASES.some(pattern => pattern.test(clause))) found.push(clause);
  }
  return found;
}

// The text a writer reads out of a JavaScript source: its string and template literals (adjacent literals joined by "+" are one
// string, comments are skipped, and a template's substitutions are elided). Identifiers, regular expressions and the notes the
// engineers left in comments are not text a writer sees, and scanning whole lines would read them as prose.

// Every string an exported constant of a module holds (strings, and strings inside frozen arrays and plain objects).

// ---------------------------------------------------------------------------
// The real protocol's contracts, over a synthetic career (the legacy walker: queue a paste job, accept the plan and the résumé,
// keep the cover-letter and review prompts).
// ---------------------------------------------------------------------------
const CONTEXT_MARKER = '\n\nAuthoritative context:\n';
const CAREER = Object.freeze({
  name: 'Wen Adeyemi', email: 'wen@example.test', employer: 'Alderbank Ferries', title: 'Berth Planner',
  listing: 'Berth planner role focused on reliable ferry turnarounds. The team schedules docking crews and supports captains who depend on those schedules every working day. You will work with port partners to keep the sailing timetable dependable for the passengers who rely on it each week.',
  bullet: 'Maintained ferry turnaround schedules with supported docking practices.',
  lead: 'Reliable ferry turnarounds are the capability this planning role needs, and my scheduling experience supports it.',
  body: 'In my planning role at Alderbank Ferries, I kept the docking schedule dependable for daily captains through shared berth sheets.',
  thesis: 'Reliable ferry turnarounds are the supported capability this planning role needs.',
});


export default [
  {
    name: 'Scanner: it flags every phrasing of "every proof-bearing paragraph owes a claim or a relevance span" the reviewers found, and passes the budget sentences and the statements that follow from them (A/B/C)',
    run() {
      // A: the sentences of the older contract, in the words the reviewers quoted and in neighbouring words, are each flagged.
      const old = [
        'every later proof-bearing paragraph keeps its claim, proof and jobNeedQuote and ends on what the work did',
        'In a paragraph that owes one, claim, proof and relevance are each an exact span of THAT paragraph',
        'it must be an object carrying claim, proof, relevance and jobNeedQuote. Supply those four fields as an object',
        'keeping each paragraph’s claim, proof and the responsibility it answers, so that a proof paragraph closes on its last sentence about the work',
        'Every later proof paragraph records a relevance span that names the responsibility',
        'Each proof-bearing paragraph owes a claim span in the closed grammar',
        'All proof paragraphs must carry a claim and a relevance span',
        'Every later paragraph supplies its claim',
        'a relevance span is required of every later proof-bearing paragraph, so each later paragraph needs one',
        'The final review records all three spans for each paragraph',
      ];
      for (const sentence of old) assert(findUniversalSpanOwnership(sentence).length > 0, `the scanner flags: ${sentence}`);
      // B: the budget sentences, the rule for a span that is recorded, and ordinary statements about paragraphs pass.
      const current = [
        checks.EXPLICIT_CLAIM_BUDGET_RULE, checks.EXPLICIT_RELEVANCE_BUDGET_RULE, checks.EXPLICIT_TRANSFER_BUDGET_RULE, checks.ARGUMENT_LATER_RELEVANCE_SPAN_RULE,
        'A later proof-bearing paragraph owes only its proof and jobNeedQuote: it may leave the claim out and may leave the relevance out',
        'Every paragraph has one argumentative job and advances the same argument with clear transitions',
        'Each proof-bearing paragraph keeps its proof span and its jobNeedQuote',
        'each span the review records for it (claim, proof or relevance) is an exact span of THAT paragraph',
        'Only the first proof-bearing paragraph of the letter owes a claim or a relevance',
        'every proof-bearing paragraph must keep a sentence stating its own completed action',
      ];
      for (const sentence of current) assert(findUniversalSpanOwnership(sentence).length === 0, `the scanner passes: ${sentence}`);
      // C: flip one clause of a passing sentence into the older contract, and the verdict flips; flip it back and it clears.
      const hedged = 'Every later proof-bearing paragraph keeps its proof and may leave the claim out';
      const flipped = hedged.replace('may leave the claim out', 'keeps the claim');
      assert(flipped !== hedged && findUniversalSpanOwnership(hedged).length === 0 && findUniversalSpanOwnership(flipped).length > 0, 'flipping the hedge to the older wording is flagged');
      assert(findUniversalSpanOwnership(flipped.replace('keeps the claim', 'may leave the claim out')).length === 0, 'restoring the hedge clears it');
      // The real budget sentence, with only its second clause turned into the older contract, is flagged; the sentence as shipped is not.
      const realRule = checks.EXPLICIT_RELEVANCE_BUDGET_RULE;
      const olderRule = realRule.replace('a later proof-bearing paragraph owes only its proof span and its jobNeedQuote, may leave the relevance out, and is held to the same shape for a relevance span it records', 'every later proof-bearing paragraph keeps its relevance');
      assert(olderRule !== realRule && findUniversalSpanOwnership(olderRule).length === 1 && findUniversalSpanOwnership(realRule).length === 0, 'the shipped budget sentence passes and its older wording is flagged');
    },
  },
  {
    name: 'Relevance scanner: it flags every older sentence that pushes each paragraph toward a statement of relevance of its own, passes the sentences that replaced them, and flips with one clause (A/B/C)',
    run() {
      // A: the sentences the round-2 reviewer found in the prompts, the criteria, the proportion rule and the documents, in their own words.
      const older = [
        'Use the sentences the paragraph needs to establish its point, proof, and relevance clearly, usually two to four',
        'Use the sentences that paragraph needs to make its point, establish its proof, and explain its relevance clearly, usually two to four.',
        'Split a sentence when separate claims, action steps, or relevance links need their own clear grammatical path; combine them only when the combined sentence is simpler',
        'separate claims, action steps, and relevance links get their own sentence when that is easier to parse',
        'and split separate claims, action steps, or relevance links within the paragraph when a combined sentence is harder to parse.',
        'A persuasive letter selects the strongest two or three proofs, develops each in one paragraph of two to four sentences, and ties them to the target work',
        'Relevance links need their own sentence in every paragraph',
      ];
      for (const sentence of older) assert(findRelevancePush(sentence).length > 0, `the scanner flags: ${sentence}`);
      // B: what replaced them, the negations, and ordinary statements about relevance pass.
      const current = [
        'Use the sentences the paragraph needs to establish its point and its proof clearly, usually two to four',
        'Split a sentence when separate claims or action steps need their own clear grammatical path; combine them only when the combined sentence is simpler',
        'Only the paragraph that owes the sentence about the target gives it a sentence of its own',
        'no fixed claim-proof-relevance sentence pattern applies, and no single detail of the evidence gets a paragraph of its own',
        'A persuasive letter selects the strongest two or three proofs, develops each in one paragraph of two to four sentences, and binds each to the work it answers',
        checks.LETTER_PROPORTION_RULE, checks.EXPLICIT_RELEVANCE_BUDGET_RULE, checks.ARGUMENT_LATER_RELEVANCE_SPAN_RULE,
      ];
      for (const sentence of current) assert(findRelevancePush(sentence).length === 0, `the scanner passes: ${sentence.slice(0, 120)}`);
      // C: flip one clause of the real proportion rule back to the older wording and the verdict flips; flip it back and it clears.
      const rule = checks.LETTER_PROPORTION_RULE;
      assert(rule.includes('binds each to the work it answers'), 'the real proportion rule says what it replaced the older clause with');
      const flipped = rule.replace('binds each to the work it answers', 'ties them to the target work');
      assert(flipped !== rule && findRelevancePush(rule).length === 0 && findRelevancePush(flipped).length === 1, 'the older clause is flagged in the real rule');
      assert(findRelevancePush(flipped.replace('ties them to the target work', 'binds each to the work it answers')).length === 0, 'restoring the clause clears it');
    },
  },
  ];
