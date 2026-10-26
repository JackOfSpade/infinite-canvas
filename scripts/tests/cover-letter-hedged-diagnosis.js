import assert from 'node:assert/strict';
import { assertSourceQuoteLinksFinalText, withoutStanceHedges } from '../../electron/ipc/localAiApplication.js';

// A letter that argues opens on the writer's hedged read of the target ("As I
// read it, your dispatchers ...") and ties each proof back to it. The hedge's
// "I" states an interpretation, not the candidate's work, so it must not turn
// a sentence about the target into a claim the career quotes have to state.
// The same hedge must never free a sentence that does report the candidate's
// own work.
const QUOTES = ['Rebuilt the depot routing board so drivers saw live route changes, while the paper sheets stayed in use until every depot had switched.'];
const PROOF = 'I rebuilt the depot routing board so drivers saw live route changes, while the paper sheets stayed in use until every depot had switched.';
const OPTIONS = { identityTokens: ['harbor', 'freight'], targetTitle: 'Product Engineer', targetCompany: 'Lanecraft' };

function verdict(sentence, order = 'after') {
  const text = order === 'before' ? `${sentence} ${PROOF}` : `${PROOF} ${sentence}`;
  try {
    assertSourceQuoteLinksFinalText(text, QUOTES, 'coverLetterParagraphs', 0, OPTIONS);
    return 'pass';
  } catch (error) {
    return error.message;
  }
}

export default [
  {
    name: 'cover letter grounding: a hedged read of the target is not a claim about the candidate, wherever it sits',
    run() {
      for (const sentence of [
        'As I read it, your dispatchers lose time moving loads out of Trackwell and Routeplan.',
        'I suspect the hard part of this role is moving carriers off Trackwell without losing history.',
        'My guess is that your customers outgrow tools they cannot adapt.',
        'From what I gather, your team wants engineers who own a change through rollout.',
        'In my reading of the posting, your dispatchers lose time moving loads out of Trackwell.',
        'From my read of the role, your team wants engineers who own a change through rollout.',
        'As far as I understand the role, your team ships a change through rollout.',
        'My reading of the role is that your team wants engineers who own a change through rollout.',
      ]) {
        for (const order of ['before', 'after']) assert.equal(verdict(sentence, order), 'pass', `${order}: ${sentence}`);
      }
      // Restore the pre-feature naming verdicts: these hedged target readings
      // remain claim-free in either position beside the cited career proof.
      for (const sentence of [
        'If I read the posting right, Lanecraft customers arrive with years of history in Trackwell.',
        'From my understanding, Lanecraft wants engineers who own a change through rollout.',
        'The way I read it, Lanecraft customers arrive with years of history in Trackwell.',
      ]) for (const order of ['before', 'after']) {
        assert.equal(verdict(sentence, order), 'pass', `${order}: ${sentence}`);
      }
      // Control: the unhedged sentence was always free; the hedge must not cost more than it.
      assert.equal(verdict('Your dispatchers lose time moving loads out of Trackwell and Routeplan.'), 'pass');
    },
  },
  {
    name: 'cover letter grounding: a hedge never frees a sentence that reports the candidate’s own work',
    run() {
      for (const [sentence, expected] of [
        ['As I read it, my Trackwell integrations would carry over directly.', /names “Trackwell”/u],
        // The name check runs first: "Trackwell" is in no quote, so that is the rejection.
        ['I suspect I built the only Trackwell importer the depots had.', /names \u201cTrackwell\u201d, which none of its bound career-data quotes states/u],
        // "driver" is its only quote term ("switch" would be a second, meeting the floor).
        ['I believe I also ran the driver interviews for the rollout.', /unrelated to its bound career-data quotes/u],
        ['My guess is that my routing board cut missed pickups by 30%.', /unsupported figure “30%”/u],
        ['From my understanding, my Trackwell integrations would carry over directly.', /names “Trackwell”/u],
        ['The way I read it, I built the only Trackwell importer the depots had.', /names \u201cTrackwell\u201d, which none of its bound career-data quotes states/u],
        ['In my reading of the posting, I built the only Trackwell importer the depots had.', /names \u201cTrackwell\u201d, which none of its bound career-data quotes states/u],
        ['My reading of the role is that my Trackwell integrations would carry over directly.', /names “Trackwell”/u],
      ]) {
        assert.match(verdict(sentence), expected, sentence);
      }
    },
  },
  {
    name: 'cover letter grounding: only the hedge is removed, every other first-person word stays',
    run() {
      assert.equal(withoutStanceHedges('As I read it, your team ships weekly.').includes('I'), false);
      assert.match(withoutStanceHedges('I suspect I built it.'), /\bI built\b/u);
      assert.match(withoutStanceHedges('My guess is that my board helped.'), /\bmy board\b/u);
      assert.doesNotMatch(withoutStanceHedges('From my understanding, your team ships weekly.'), /(?<![\p{L}\p{N}])(?:I|we|me|us|my|mine|our|ours)(?![\p{L}\p{N}])/iu);
      assert.match(withoutStanceHedges('From my understanding, I built it.'), /\bI built\b/u);
      assert.doesNotMatch(withoutStanceHedges('The way I read it, your team ships weekly.'), /\bI\b/u);
      assert.match(withoutStanceHedges('My reading of the role is that my board helped.'), /^\s*my board helped\.$/u);
      // A past-tense report is not a hedge: "I read the manuals" stays first person.
      assert.match(withoutStanceHedges('I read the manuals before the switch.'), /^I read/u);
    },
  },
  {
    name: 'cover letter grounding: word forms of one cited word count as one shared term in a letter paragraph',
    run() {
      // "boards"/"board" and "depots"/"depot" share the floor only by word form; the tie-back reuses no exact quote word but "depot".
      assert.equal(verdict('That is the same problem I solved when the depots changed boards.'), 'pass');
      // Two forms of one word are one term, never two. "untangled" makes this the
      // candidate's own work (regular -ed past), so the two-term floor applies, and
      // "boards"/"board" is the only overlap with the quote.
      assert.match(verdict('That is the same problem I untangled when boards and the board jammed.'), /unrelated to its bound career-data quotes/u);
      // Control: one more genuinely shared word ("drivers") meets the floor, so the
      // rejection above comes from the one-term count, not from the classification.
      assert.equal(verdict('That is the same problem I untangled when boards and the board jammed for drivers.'), 'pass');
      // A résumé bullet keeps exact terms.
      assert.throws(() => assertSourceQuoteLinksFinalText('Solved problems when depots changed boards.', ['Rebuilt the depot routing board.'], 'resumeBullets', 0, { identityTokens: [] }), /unrelated/u);
    },
  },
];
