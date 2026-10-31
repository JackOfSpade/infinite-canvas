import { assert } from './testHelpers.js';
import { interviewAnswerV5ReplayFixture } from '../fixtures/interview-answer-v5-replay.mjs';
import { buildInterviewPreparedAnswers } from '../../electron/ipc/interviewPreparation.js';
import { inspectInterviewAnswerCards, isInterviewAnswerBank, INTERVIEW_REQUIRED_QUESTIONS } from '../../electron/ipc/interviewAnswerBank.js';

function boundary(prompt, label) {
  const match = prompt.match(new RegExp(`<untrusted-${label}-[a-f0-9]+>\\n([\\s\\S]*?)\\n</untrusted-${label}-[a-f0-9]+>`));
  assert(match, `expected ${label} data boundary`);
  return JSON.parse(match[1]);
}

const claimKey = claim => JSON.stringify([claim.text, claim.evidenceIds]);

export default [
  {
    name: 'interview v5 replay: saved sparse repairs retain ten safe answers including required intro and project',
    async run() {
      const fixture = interviewAnswerV5ReplayFixture();
      const { context } = fixture;
      assert(JSON.stringify(fixture.responses.map(response => response.cards.length)) === '[12,9,5]', 'retain the saved full draft and both sparse repair responses');
      const requests = [];
      const reviews = [];
      const diagnostics = [];
      // Preserve the recorded judge rejection. Additional claims that the old
      // host never submitted to its judge are explicitly synthetic approvals;
      // this replay tests host recovery, never claims a fresh model evaluation.
      const recorded = new Map(fixture.recordedReviews.map(review => [claimKey(review), review]));
      const knownClaims = new Set(fixture.responses.flatMap(response => response.cards)
        .flatMap(card => [card.headline, ...card.bullets, card.example, ...(card.extensions || [])]).map(claimKey));
      let generated = false;
      const callText = async (prompt, options) => {
        let value;
        if (prompt.startsWith('INTERVIEW ANSWER ENTAILMENT REVIEW')) {
          const claims = boundary(prompt, 'interview-answer-entailment-claims');
          reviews.push(claims);
          value = { verdicts: claims.map(claim => {
            assert(knownClaims.has(claimKey(claim)), 'replay must not silently approve newly invented fallback speech');
            const verdict = recorded.get(claimKey(claim));
            return { path: claim.path, claimDigest: claim.claimDigest,
              entailed: verdict?.entailed ?? true, reason: verdict?.reason ?? 'SUPPORTED' };
          }) };
        } else if (prompt.includes('<untrusted-interview-answer-failing-cards-')) {
          const requested = boundary(prompt, 'interview-answer-failing-cards');
          requests.push(requested);
          assert(requests.length <= 2, 'repairs must stay bounded to two rounds');
          const next = fixture.responses[requests.length];
          value = { cards: requested.map(({ card }) => {
            const replacement = next.cards.find(item => item.id === card.id);
            return structuredClone(replacement || card);
          }) };
        } else {
          assert(!generated, 'only one initial draft is allowed');
          generated = true;
          value = { cards: structuredClone(fixture.responses[0].cards) };
        }
        options.responseValidator?.(value);
        return value;
      };
      const { bank } = await buildInterviewPreparedAnswers({
        brief: context.brief, snapshotId: context.snapshot.snapshotId, canonicalJobUrl: context.canonicalJobUrl,
        bundleArtifactId: context.bundleArtifactId, loadBundle: async () => context.bundle,
        loadSnapshot: async () => context.snapshot, callText,
        onValidationRound: round => diagnostics.push(round),
      });
      const final = diagnostics.at(-1);
      assert(bank.cards.length >= 10, `v5 replay must recover at least ten safe cards; got ${bank.cards.length}, dropped ${JSON.stringify(final?.droppedCards)}`);
      assert(INTERVIEW_REQUIRED_QUESTIONS.every(question => bank.cards.some(card => card.question === question)), 'required intro and project must survive');
      assert(isInterviewAnswerBank(bank, context) && inspectInterviewAnswerCards(bank.cards, context).failures.length === 0, 'every surviving claim must pass complete bank and truth validation');
      const survivingClaims = new Set(bank.cards.flatMap(card => [card.headline, ...card.bullets, card.example, ...(card.extensions || [])]).map(claimKey));
      assert(fixture.recordedReviews.filter(review => !review.entailed).every(review => !survivingClaims.has(claimKey(review))), 'a recorded semantic rejection must never be rescued under a new card path');
      const strengths = bank.cards.find(card => card.id === 'strengths');
      const earlierStrengths = fixture.responses[1].cards.find(card => card.id === 'strengths');
      assert(strengths?.bullets.some(claim => claimKey(claim) === claimKey(earlierStrengths.bullets[1])), 'a previously approved detail must recover strengths without duplicating the locked relevant-experience card');
      assert(!requests.flat().some(({ card }) => card.id === 'relevant-experience'), 'résumé annotation failure must not send a safe relevant-experience card through destructive repairs');
      assert(reviews.length > 0, 'recovered claims must still undergo semantic review');
      assert(bank.cards.every(card => card.extensions?.length >= 2), 'every realistic replay card must retain at least two independently cited additional points');
      assert(reviews.some(claims => claims.some(claim => /\.extensions\[/u.test(claim.path))), 'extension propositions must reach the same independent semantic review as memorized claims');
      const byId = new Map(fixture.evidence.map(source => [source.id, source]));
      for (const card of bank.cards) for (const claim of [card.headline, ...card.bullets, card.example, ...(card.extensions || [])]) {
        assert(claim.quotes.every(quote => quote.quote === byId.get(quote.evidenceId).text), 'recovered citations must contain the full exact original synthetic source');
      }
      return { recordedSteps: fixture.responses.map(response => response.recordedStep), surviving: bank.cards.length, sparseRounds: requests.length,
        survivingByRound: diagnostics.filter(round => round.phase === 'validation').map(round => round.survivingCardCount), dropped: bank.droppedQuestions || [] };
    },
  },
];
