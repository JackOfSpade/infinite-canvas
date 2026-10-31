import { assert } from './testHelpers.js';
import { interviewSpokenReplayFixture } from '../fixtures/interview-spoken-replay.mjs';
import { buildInterviewPreparedAnswers } from '../../electron/ipc/interviewPreparation.js';
import { inspectInterviewAnswerCards, isInterviewAnswerBank } from '../../electron/ipc/interviewAnswerBank.js';

function boundary(prompt, label) {
  const match = prompt.match(new RegExp(`<untrusted-${label}-[a-f0-9]+>\\n([\\s\\S]*?)\\n</untrusted-${label}-[a-f0-9]+>`));
  assert(match, `expected ${label} data boundary`);
  return JSON.parse(match[1]);
}

async function replay({ context, responses, fixedDraft } = {}) {
  const requests = [];
  let draftIndex = 0;
  const initial = structuredClone(fixedDraft || responses[0].value);
  const initialFailures = inspectInterviewAnswerCards(initial.cards, context).failures;
  const failingIds = new Set(initialFailures.map(issue => initial.cards[issue.cardIndex].id));
  const locked = initial.cards.filter(card => !failingIds.has(card.id));
  const callText = async (prompt, options) => {
    let value;
    if (prompt.startsWith('INTERVIEW ANSWER ENTAILMENT REVIEW')) {
      const claims = boundary(prompt, 'interview-answer-entailment-claims');
      value = { verdicts: claims.map(({ path, claimDigest }) => ({ path, claimDigest, entailed: true, reason: 'SUPPORTED' })) };
    } else if (prompt.includes('<untrusted-interview-answer-failing-cards-')) {
      const requested = boundary(prompt, 'interview-answer-failing-cards');
      assert(requested.length > 0 && requested.length < initial.cards.length, 'repair must request only the unresolved subset');
      assert(requested.every(({ card, issues }) => card.id && issues.length > 0), 'each requested card must carry its own complete issues');
      assert(requested.every(({ card }) => !locked.some(item => item.id === card.id)), 'initial passing cards must remain locked throughout replay');
      if (requests.length) {
        const previousIds = new Set(requests.at(-1).map(({ card }) => card.id));
        assert(requested.every(({ card }) => previousIds.has(card.id)), 'newly passing cards must leave subsequent repair requests');
      }
      requests.push(structuredClone(requested));
      draftIndex++;
      const next = fixedDraft || responses[Math.min(draftIndex, responses.length - 1)].value;
      value = { cards: requested.map(({ card }) => {
        const replacement = next.cards.find(item => item.question === card.question) || card;
        return { ...structuredClone(replacement), id: card.id, question: card.question };
      }) };
    } else {
      assert(draftIndex === 0, 'only one complete generation is permitted');
      value = structuredClone(initial);
    }
    options.responseValidator?.(value);
    return value;
  };
  const args = {
    brief: context.brief, snapshotId: context.snapshot.snapshotId,
    canonicalJobUrl: context.canonicalJobUrl, bundleArtifactId: context.bundleArtifactId,
    loadBundle: async () => context.bundle, loadSnapshot: async () => context.snapshot, callText,
  };
  return { run: () => buildInterviewPreparedAnswers(args), requests, initial, locked, initialFailures };
}

/** Create a stable positive synthetic bank from the least-failing recorded
 * draft. Warning/coverage metadata is normalized after the synthetic final drafts
 * have been calibrated for standalone, nonredundant speech. */
function validRecordedDraft(fixture) {
  const value = structuredClone(fixture.responses[2].value);
  for (const card of value.cards) {
    card.thinEvidence = true;
    card.consistency = { consistentWithResume: false, resumeQuote: '' };
  }
  assert(inspectInterviewAnswerCards(value.cards, fixture.context).failures.length === 0, 'calibrated recorded claims must retain a usable complete baseline');
  return value;
}

export default [
  {
    name: 'interview spoken replay: recorded drafts converge or degrade with passing cards locked',
    async run() {
      const fixture = interviewSpokenReplayFixture();
      assert(fixture.responses.length === 4 && fixture.responses.every(item => item.value.cards.length === 12), 'replay must retain all four complete saved drafts');
      const outcomes = [];
      for (const [index, response] of fixture.responses.entries()) {
        const session = await replay({ ...fixture, responses: fixture.responses.slice(index) });
        const { bank } = await session.run();
        assert(session.initialFailures.length > 0, 'each recorded draft must exercise repair rather than start passing');
        assert(session.requests.length <= 2, 'truth repair must be bounded to two sparse rounds; host evidence warnings may avoid an unnecessary repair');
        assert(bank.cards.length >= 8 && bank.cards.length <= 12, 'recorded replay must converge or retain at least eight verified cards');
        assert(isInterviewAnswerBank(bank, fixture.context), 'merged replay must pass source binding and all full-bank checks');
        assert(inspectInterviewAnswerCards(bank.cards, fixture.context).failures.length === 0, 'no failing recorded proposition may survive sealing');
        for (const original of session.locked) {
          const surviving = bank.cards.find(card => card.id === original.id);
          assert(JSON.stringify(surviving) === JSON.stringify(original), 'repair must preserve every previously passing card byte-for-byte');
        }
        const survivingQuestions = new Set(bank.cards.map(card => card.question));
        const omitted = session.initial.cards.filter(card => !survivingQuestions.has(card.question)).map(card => card.question);
        assert(JSON.stringify([...(bank.droppedQuestions || [])].sort()) === JSON.stringify(omitted.sort()), 'every omitted recorded question must be explicitly retained for cue fallback');
        outcomes.push({ step: response.recordedStep, sparseRounds: session.requests.length, surviving: bank.cards.length, dropped: omitted.length });
      }
      return { recordedDrafts: fixture.responses.length, outcomes };
    },
  },
  {
    name: 'interview spoken replay: eight-card floor seals only surviving claims after bounded repeated failures',
    async run() {
      const fixture = interviewSpokenReplayFixture();
      const valid = validRecordedDraft(fixture);
      const failing = structuredClone(valid);
      for (const card of failing.cards.filter(card => card.question !== 'Walk me through a project.').slice(0, 4)) card.headline.text = 'I built UnlistedCorp systems and increased revenue by 999 percent.';
      const session = await replay({ ...fixture, fixedDraft: failing });
      const { bank } = await session.run();
      assert(session.requests.length === 2 && bank.cards.length === 8, 'persistent failures must be dropped after two rounds, accepting exactly eight survivors');
      assert(bank.droppedQuestions.length === 4 && isInterviewAnswerBank(bank, fixture.context), 'drop record and complete bank checks must survive exact-floor degradation');
      assert(!JSON.stringify(bank).includes('UnlistedCorp'), 'failing claims must never enter sealed bank or drop metadata');
      return { surviving: bank.cards.length, dropped: bank.droppedQuestions.length };
    },
  },
  {
    name: 'interview spoken replay: seven-card remainder fails Prepare instead of accepting an unsupported claim',
    async run() {
      const fixture = interviewSpokenReplayFixture();
      const failing = validRecordedDraft(fixture);
      for (const card of failing.cards.filter(card => card.question !== 'Walk me through a project.').slice(0, 5)) card.headline.text = 'I built UnlistedCorp systems and increased revenue by 999 percent.';
      const session = await replay({ ...fixture, fixedDraft: failing });
      let refusal;
      try { await session.run(); } catch (error) { refusal = error; }
      assert(refusal && session.requests.length === 2, 'Prepare must reject a seven-card remainder after the bounded repair budget');
      return { sparseRounds: session.requests.length, refused: true };
    },
  },
];
