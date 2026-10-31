import { assert } from './testHelpers.js';
import {
  classifyInterviewCallQuestion,
  createInterviewCallQuestionDetector,
  selectInterviewCallQuestion,
} from '../../electron/interviewCallQuestionDetector.js';
import { matchInterviewAnswerCard } from '../../src/utils/interviewAnswerMatching.js';
import { buildInterviewPlan } from '../../src/utils/interviewHelper.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';
import { interviewCallNonQuestions, interviewCallTranscriptFixtures } from '../fixtures/interview-call-transcripts.mjs';

function receiveText(detector, text, now = 100, { segmentId = 'segment-1', final = false, startMs = 0, endMs = 1000 } = {}) {
  return detector.receive({ type: 'transcript', text, segmentId, final, startMs, endMs }, now);
}

function endedTurn(detector, text, { at = 0, segmentId = `segment-${at}`, startMs = at, endMs = at + 500 } = {}) {
  detector.receive({ type: 'activity', speaking: true }, at);
  receiveText(detector, text, at + 100, { segmentId, startMs, endMs, final: true });
  detector.receive({ type: 'activity', speaking: false }, at + 500);
  return detector.poll(at + 1300) || detector.poll(at + 2700);
}

const liveTurns = [
  "Alright, thanks for that. Can you walk me through a project you're really proud of?",
  "Great, that's helpful. Tell me about a time you disagreed with a teammate.",
  'Cool. Nice. So how do you handle ambiguous requirements?',
  "Thanks. Next one. What's your biggest weakness?",
  'I see, that makes sense. Why Discord?',
  "Can you walk me through a project you're really proud of?",
  'Why Discord?',
  'Alright. How do you prioritize your work?',
  'Cool, tell me about leading a team.',
  'Nice. What motivates you?',
  'Great, how do you handle working under pressure?',
  'Perfect. Describe a difficult decision you made.',
  'Got it. Can you give me an example?',
  'I see. Why this role?',
  'Makes sense. How would you approach this problem?',
  "That's helpful. What happened next?",
  'Thanks for that. What would you do differently?',
  'Next one, what are your salary expectations?',
  "Great. So a bit about the team: we're about twelve engineers.",
  'Cool. We have two engineering offices and meet every other Friday.',
  ...interviewCallNonQuestions,
];

export default [
  {
    name: 'interview call detector: a "Next one" lead-in is removed whole',
    run() {
      for (const text of ['Next one, tell me about leading a team.', 'Next one: tell me about leading a team.', 'Next one. Tell me about leading a team?']) {
        assert(/^tell me about leading a team[.?]$/iu.test(classifyInterviewCallQuestion(text)?.question || ''), `no stray "one": ${text}`);
      }
    },
  },
  {
    name: 'interview call detector: ASR boundary artefacts are trimmed without stripping meaningful punctuation',
    run() {
      for (const [input, expected] of [
        ['\u200b.\tOkay, and what are your salary expectations?\n . , ', 'Okay, and what are your salary expectations?'],
        [' ... ; Why Discord? ; , ', 'Why Discord?'],
        ['  Why Discord ?  ', 'Why Discord?'],
        ['  Tell me about leading a team, ;  ', 'Tell me about leading a team'],
        ['. “Why Discord?” . ', '“Why Discord?”'],
        ['  What does “ownership” mean to you, and why?  ', 'What does “ownership” mean to you, and why?'],
        ["What's your experience with C++, .NET, and Node.js?", "What's your experience with C++, .NET, and Node.js?"],
        ['.NET experience: how did you improve latency by 0.5 ms?', '.NET experience: how did you improve latency by 0.5 ms?'],
        ['(For this role) what are your salary expectations?', '(For this role) what are your salary expectations?'],
        ["'Why Discord?'", "'Why Discord?'"],
        ['Well... tell me about your work!', 'Well... tell me about your work!'],
      ]) {
        for (const final of [false, true]) {
          const detector = createInterviewCallQuestionDetector();
          detector.receive({ type: 'activity', speaking: true }, 0);
          assert(receiveText(detector, input, 100, { final }), 'text with meaningful words must remain usable');
          assert(detector.getTranscript() === expected, `clean only stray ASR boundaries: ${input}`);
          assert(detector.getPartial().text === expected, 'speculative text uses the same cleaned assembly');
          detector.receive({ type: 'activity', speaking: false }, 500);
          assert(detector.poll(2000)?.text === expected, 'final and volatile endpoints preserve meaningful punctuation');
          assert(detector.poll(4000) === null, 'cleanup must not produce duplicate endpoints');
        }
      }
      for (const text of ['.', ' ... ', ' , ; ? ! ', '\t\n', '\u200b']) {
        const detector = createInterviewCallQuestionDetector();
        detector.receive({ type: 'activity', speaking: true }, 0);
        assert(!receiveText(detector, text, 100), 'a punctuation-only artefact is not spoken text');
        detector.receive({ type: 'activity', speaking: false }, 500);
        assert(detector.getTranscript() === '', 'no punctuation-only transcript may accumulate');
        assert(detector.poll(4000) === null, 'punctuation alone cannot create a turn');
      }
    },
  },
  ...liveTurns.map(text => ({
    name: `interview call detector: semantic gate forwards the complete non-filler turn: ${text}`,
    run() {
      const selected = selectInterviewCallQuestion({ text }, {}, { semantic: true });
      assert(selected.accepted && selected.question === text && selected.dependent === false,
        'only the AI may classify or shorten a meaningful live turn');
    },
  })),
  {
    name: 'interview call detector: semantic gate drops only empty or pure filler turns locally',
    run() {
      for (const text of [
        '', '  ', 'Okay.', 'Right.', 'Mm-hm.', 'mm hmm', 'Great!', 'Alright.', 'Cool.', 'Nice.', 'Perfect.',
        'Got it.', 'I see.', 'Makes sense.', "That's helpful.", "That's great.", 'Thanks for that.', 'Next one.',
        'Cool. Nice. Okay, great.', 'I see, that makes sense.', 'Um, uh. Hmm.',
      ]) {
        assert(!selectInterviewCallQuestion({ text }, {}, { semantic: true }).accepted,
          `a filler-only turn must not trigger AI selection: ${text}`);
      }
      assert(selectInterviewCallQuestion({ text: 'x'.repeat(2001) }, {}, { semantic: true }).reason === 'too-long',
        'an untruncated overlong input stays local');
      assert(selectInterviewCallQuestion({ text: 'Why Discord?', reason: 'too-long' }, {}, { semantic: true }).reason === 'too-long',
        'a clipped endpoint cannot become an automatic question');
    },
  },
  {
    name: 'interview call detector: conservative fallback accepts common acknowledgement lead-ins',
    run() {
      for (const prefix of [
        'Alright', 'Cool', 'Nice', 'Great', 'Perfect', 'Got it', 'I see', 'Makes sense', "That's helpful", "That's great", 'Thanks for that', 'Next one',
      ]) {
        for (const separator of [', ', '. ']) {
          const text = `${prefix}${separator}How do you prioritize your work?`;
          assert(selectInterviewCallQuestion({ text }, {}).accepted,
            `ordinary delivery words must not block the offline fallback: ${text}`);
        }
      }
    },
  },
  {
    name: 'interview call detector: approximate fallback accepts stranded prepositions and neutral lead-ins',
    run() {
      for (const text of [
        'Can you walk me through a project you are really proud of?',
        'What are you most proud of?',
        'Who did you report to?',
        'What kind of work are you passionate about?',
        'Thanks for sharing that. How do you handle conflict on a team?',
        'That was great. Tell me about a time you failed.',
        'Next, tell me about a time you failed.',
        "Alright, thanks for that. Can you walk me through a project you're really proud of?",
      ]) {
        assert(selectInterviewCallQuestion({ text }, { cards: [] }).accepted,
          `a complete offline question remains answerable: ${text}`);
        const detector = createInterviewCallQuestionDetector();
        detector.receive({ type: 'activity', speaking: true }, 0);
        receiveText(detector, text, 100, { final: true });
        detector.receive({ type: 'activity', speaking: false }, 500);
        assert(detector.poll(1300)?.text === text, 'complete questions keep the normal silence deadline');
      }
      assert(!selectInterviewCallQuestion({ text: 'At RivalCo. Tell me about a time you failed.' }, { cards: [] }).accepted,
        'neutral lead-in handling must not discard factual scope');
    },
  },
  {
    name: 'interview call detector: endpoints on output silence and transcript stability, never ASR final alone',
    run() {
      const detector = createInterviewCallQuestionDetector();
      detector.receive({ type: 'activity', speaking: true }, 0);
      receiveText(detector, 'How do you prioritize your work?', 100, { final: true });
      assert(detector.poll(2000) === null, 'a final result cannot endpoint while output is still speaking');
      detector.receive({ type: 'activity', speaking: false }, 2100);
      assert(detector.poll(2899) === null, 'wait for the entire silence interval');
      receiveText(detector, 'How do you prioritize your work?', 2850, { final: true });
      const endpoint = detector.poll(2900);
      assert(endpoint?.question === 'How do you prioritize your work?', 'same-text final flags must not extend transcript stability');
      assert(detector.poll(5000) === null, 'one turn must emit only once');
    },
  },
  {
    name: 'interview call detector: volatile revisions replace words, remain live, and wait briefly after a correction',
    run() {
      const detector = createInterviewCallQuestionDetector();
      detector.receive({ type: 'activity', speaking: true }, 0);
      receiveText(detector, 'Tell me about leaving a team', 100);
      receiveText(detector, 'Tell me about leading a team.', 300);
      assert(detector.getTranscript() === 'Tell me about leading a team.', 'volatile segments replace rather than duplicate words');
      detector.receive({ type: 'activity', speaking: false }, 400);
      receiveText(detector, 'Tell me about leading a team?', 1150);
      assert(detector.poll(1200) === null, 'recent corrections require a stability interval');
      assert(detector.poll(1400) === null, 'a volatile tail waits briefly for the native final');
      assert(detector.poll(1900)?.question === 'Tell me about leading a team?', 'a stalled final cannot hold the turn indefinitely');
    },
  },
  {
    name: 'interview call detector: shifted-start ASR revisions replace an overlapping volatile fragment instead of duplicating it',
    run() {
      const detector = createInterviewCallQuestionDetector();
      detector.receive({ type: 'activity', speaking: true }, 0);
      receiveText(detector, 'Great.', 100, { segmentId: '0', startMs: 0, endMs: 500 });
      const revised = 'Okay, great. So what made you want to apply for this role?';
      receiveText(detector, revised, 200, { segmentId: '80', startMs: 80, endMs: 2500 });
      assert(detector.getTranscript() === revised, 'the old leading fragment must not be prepended to its revised range');
      assert(receiveText(detector, 'Okay, great.', 250, { segmentId: '0', startMs: 0, endMs: 500, final: true }),
        'a superseded volatile id remains valid for an authoritative final commit');
      assert(detector.getTranscript() === 'Okay, great.', 'a shorter final clears the entire overlapping volatile tail');
      receiveText(detector, 'So what made you want to apply for this role?', 350,
        { segmentId: '500', startMs: 500, endMs: 2500 });
      detector.receive({ type: 'activity', speaking: false }, 2500);
      assert(detector.poll(4000)?.text === revised, 'the locked question receives only the revised turn');
    },
  },
  {
    name: 'interview call detector: changed ids cannot overwrite finalized ranges and distinct repeated words remain intact',
    run() {
      const detector = createInterviewCallQuestionDetector();
      detector.receive({ type: 'activity', speaking: true }, 0);
      receiveText(detector, 'Great.', 100, { segmentId: 'first', startMs: 0, endMs: 500, final: true });
      assert(!receiveText(detector, 'Stale changed-id words.', 200, { segmentId: 'shifted', startMs: 100, endMs: 500 }),
        'a changed id does not bypass finalized segment protection');
      receiveText(detector, 'Great. How do you prioritize your work?', 300,
        { segmentId: 'second', startMs: 500, endMs: 2500 });
      assert(detector.getTranscript() === 'Great. Great. How do you prioritize your work?',
        'real repeated words in adjacent audio ranges must not be text-deduplicated');
    },
  },
  {
    name: 'interview call detector: short pauses and question marks do not cut a multipart output turn',
    run() {
      const detector = createInterviewCallQuestionDetector();
      detector.receive({ type: 'activity', speaking: true }, 0);
      receiveText(detector, 'Tell me about leading a team?', 100, { segmentId: 'first', final: true, startMs: 0, endMs: 400 });
      detector.receive({ type: 'activity', speaking: false }, 400);
      assert(detector.poll(1000) === null, 'a 600ms pause is not an endpoint');
      detector.receive({ type: 'activity', speaking: true }, 1050);
      receiveText(detector, 'What did you learn?', 1150, { segmentId: 'second', startMs: 1050, endMs: 1500 });
      detector.receive({ type: 'activity', speaking: false }, 1500);
      const endpoint = detector.poll(3000);
      assert(endpoint?.parts.length === 2 && endpoint.multipart, 'preserve both the initial question and follow-up');
      assert(endpoint.text === 'Tell me about leading a team? What did you learn?', 'the whole silence-delimited utterance remains available');
    },
  },
  {
    name: 'interview call detector: old finals cannot resubmit an ended turn and new straddling ranges remain usable',
    run() {
      const detector = createInterviewCallQuestionDetector();
      const first = endedTurn(detector, 'How do you prioritize your work?');
      assert(first?.id === 1, 'first question should endpoint');
      assert(!receiveText(detector, 'How do you prioritize your work?', 1400, { segmentId: 'segment-0', final: true, endMs: 500 }), 'retired segment ids are ignored');
      assert(!receiveText(detector, 'How do you prioritize your work?', 1450, { segmentId: 'late-id', final: true, endMs: 500 }), 'old ranges with changed ids are ignored');
      detector.receive({ type: 'activity', speaking: true }, 1600);
      assert(receiveText(detector, 'Old question and tell me about leadership?', 1700, { segmentId: 'overlap', startMs: 200, endMs: 1900 }), 'a range spanning an emitted endpoint must retain new audio');
      assert(detector.getTranscript() === 'Old question and tell me about leadership?', 'ambiguous straddles remain visible without unsafe time clipping');
      receiveText(detector, 'Tell me about leading a team.', 1800, { segmentId: 'new-id', startMs: 1600, endMs: 2000 });
      detector.receive({ type: 'activity', speaking: false }, 2000);
      const second = detector.poll(3500);
      assert(second?.id === 2 && second.question === 'Tell me about leading a team.', 'a distinct following turn remains usable');
    },
  },
  {
    name: 'interview call detector: segments use audio order and stale volatile results cannot undo finalized text',
    run() {
      const detector = createInterviewCallQuestionDetector();
      detector.receive({ type: 'activity', speaking: true }, 0);
      receiveText(detector, 'What did you learn?', 100, { segmentId: 'second', startMs: 500, endMs: 1000 });
      receiveText(detector, 'Tell me about leading a team?', 110, { segmentId: 'first', final: true, startMs: 0, endMs: 500 });
      assert(!receiveText(detector, 'Tell me about leaving', 120, { segmentId: 'first', startMs: 0, endMs: 500 }), 'finalized segments reject late volatile revisions');
      assert(detector.getTranscript() === 'Tell me about leading a team? What did you learn?', 'audio ranges restore sentence order');
      detector.receive({ type: 'activity', speaking: false }, 1000);
      assert(detector.poll(2500)?.parts.length === 2, 'ordered segments form one multipart turn');
    },
  },
  {
    name: 'interview call detector: ordinary statements and incomplete prompts abstain with a visible transcript',
    run() {
      for (const text of interviewCallNonQuestions) {
        const detector = createInterviewCallQuestionDetector();
        const endpoint = endedTurn(detector, text);
        assert(endpoint?.text === text, `keep the words for explicit override: ${text}`);
        assert(!endpoint.question && !selectInterviewCallQuestion(endpoint, {}).accepted, `ordinary prose must not auto-advance: ${text}`);
      }
    },
  },
  {
    name: 'interview call detector: complete short interview questions are distinct from uncertain noun fragments',
    run() {
      for (const text of ['Why us?', 'Why this role?', 'What motivates you?', "What's your background?"]) {
        assert(classifyInterviewCallQuestion(text)?.question === text, `a complete short question remains available: ${text}`);
      }
      for (const text of ['Which role', 'How would you', 'Leading team?']) {
        assert(classifyInterviewCallQuestion(text) === null, `uncertain fragments remain explicit override only: ${text}`);
      }
    },
  },
  {
    name: 'interview call detector: output activity is required and timing state resets between sessions',
    run() {
      const detector = createInterviewCallQuestionDetector();
      receiveText(detector, 'Tell me about leading a team.', 0);
      detector.receive({ type: 'activity', speaking: false }, 100);
      assert(detector.poll(10000) === null, 'silent recognizer hallucinations are not speech turns');
      detector.reset();
      assert(detector.getTranscript() === '', 'reset clears session transcript');
      const endpoint = endedTurn(detector, 'Tell me about leading a team.');
      assert(endpoint?.id === 1, 'reset also clears retired segment ids and timing');
    },
  },
  {
    name: 'interview call detector: oversized turns abstain instead of silently answering a clipped question',
    run() {
      const detector = createInterviewCallQuestionDetector();
      const endpoint = endedTurn(detector, `Tell me about leading a team ${'with detailed context '.repeat(150)}`);
      assert(endpoint?.reason === 'too-long' && endpoint.text.length === 2000 && !endpoint.question, 'display is bounded without making a clipped automatic question');
      assert(selectInterviewCallQuestion(endpoint, {}).reason === 'too-long', 'selector preserves oversized-turn abstention');
      assert(!detector.receive({ type: 'transcript', segmentId: 'bad', text: {}, final: false }, 1400), 'non-string transcript is rejected');
      assert(!detector.receive({ type: 'transcript', segmentId: 'bad\u0000', text: 'Question', final: false }, 1500), 'unsafe ids are rejected');
    },
  },
  {
    name: 'interview call detector: transcript fixtures reuse the prepared matcher and preserve factual abstentions',
    run() {
      const { bank, snapshot } = createInterviewWindowE2EFixture();
      for (const fixture of interviewCallTranscriptFixtures) {
        const endpoint = endedTurn(createInterviewCallQuestionDetector(), fixture.text);
        const selected = selectInterviewCallQuestion(endpoint, bank);
        assert(selected.accepted, `a complete single question keeps honest existing lookup: ${fixture.text}`);
        assert((matchInterviewAnswerCard(selected.question, bank)?.id ?? null) === fixture.expected, `matching must retain anchors and conservative behavior: ${fixture.text}`);
        if (fixture.text.includes('99%') || fixture.text.includes('never leading') || fixture.text.includes('RivalCo')) {
          assert(buildInterviewPlan({ question: selected.question, profile: snapshot }).status === 'unsupported', 'exact cue fallback must also abstain on unknown facts');
        }
      }
      const duplicate = { cards: [bank.cards[0], { ...bank.cards[0], id: 'duplicate' }] };
      assert(matchInterviewAnswerCard(bank.cards[0].question, duplicate) === null, 'answer ties remain honest abstentions');
    },
  },
  {
    name: 'interview call detector: incompatible multipart prompts never choose only their latest prepared card',
    run() {
      const { bank } = createInterviewWindowE2EFixture();
      for (const text of [
        'Tell me about leading a team? How do you prioritize your work?',
        'Tell me about leading a team and how do you prioritize your work?',
      ]) {
        const endpoint = endedTurn(createInterviewCallQuestionDetector(), text);
        assert(endpoint.parts.length === 2, 'separate question-like parts even without ASR punctuation');
        assert(selectInterviewCallQuestion(endpoint, bank).reason === 'multipart-conflict', 'different prepared cards require user override');
      }
      const unknown = endedTurn(createInterviewCallQuestionDetector(), 'Tell me about leading a team? What are your salary expectations?');
      assert(selectInterviewCallQuestion(unknown, bank).reason === 'multipart-unmatched', 'an unsupported part cannot disappear behind a known card');
      const same = endedTurn(createInterviewCallQuestionDetector(), 'Tell me about leading a team? Describe your approach to leadership.');
      assert(selectInterviewCallQuestion(same, bank).accepted, 'two variants of the same prepared intent can use one card');
    },
  },
  {
    name: 'interview call detector: detached factual context cannot disappear from automatic question matching',
    run() {
      const { bank } = createInterviewWindowE2EFixture();
      for (const text of [
        'Tell me about leading a team. At RivalCo.',
        'At RivalCo. Tell me about leading a team?',
        'Tell me about leading a team. With a 99% improvement.',
        'Tell me about leading a team; at RivalCo.',
        'At RivalCo, tell me about leading a team?',
        'How do you prioritize your work? You must raise conversion by 99%.',
      ]) {
        const endpoint = endedTurn(createInterviewCallQuestionDetector(), text);
        assert(endpoint.text === text, 'the full turn remains visible for explicit override');
        assert(endpoint.question === text, 'classification must not reconstruct a context-free question');
        const selection = selectInterviewCallQuestion(endpoint, bank);
        assert(!selection.accepted && selection.reason === 'context-uncertain', `detached scope must abstain: ${text}`);
      }
      for (const text of [
        'Thanks. Tell me about leading a team?',
        'Okay. Tell me about leading a team? Great.',
        'Um. Tell me about leading a team?',
      ]) {
        const selected = selectInterviewCallQuestion(endedTurn(createInterviewCallQuestionDetector(), text), bank);
        assert(selected.accepted && selected.question.includes('Tell me about leading a team?'), 'only harmless filler can be removed from the safe fallback question');
        assert(matchInterviewAnswerCard(selected.question, bank)?.id === 'leadership', 'safe filler cannot prevent the existing local match');
      }
      const dependent = selectInterviewCallQuestion(endedTurn(createInterviewCallQuestionDetector(), 'Thanks. What did you learn?'), bank);
      assert(dependent.accepted && dependent.dependent && dependent.question === 'What did you learn?', 'safe filler preserves the existing finite follow-up grammar');
    },
  },
  {
    name: 'interview call detector: narrow dependent questions retain the existing explicit story-followup path',
    run() {
      const { bank } = createInterviewWindowE2EFixture();
      for (const text of ['What did you learn?', 'What happened next?', 'How did you handle that?', 'What would you do differently?']) {
        const selected = selectInterviewCallQuestion(endedTurn(createInterviewCallQuestionDetector(), text), bank);
        assert(selected.accepted && selected.dependent, `only a recognized dependent follow-up uses the prior story: ${text}`);
      }
      const independent = selectInterviewCallQuestion(endedTurn(createInterviewCallQuestionDetector(), 'How do you prioritize your work?'), bank);
      assert(independent.accepted && !independent.dependent, 'a new independent topic cannot inherit a previous story');
      const multipart = classifyInterviewCallQuestion('Tell me about leading a team? What did you learn?');
      const selected = selectInterviewCallQuestion({ text: multipart.question }, bank);
      assert(!selected.accepted, 'a prepared card lacking the asked lesson component cannot silently stand in for the whole multipart prompt');
    },
  },
];
