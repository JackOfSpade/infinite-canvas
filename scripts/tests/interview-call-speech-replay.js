import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInterviewCallQuestionDetector, selectInterviewCallQuestion } from '../../electron/interviewCallQuestionDetector.js';

// Speech result ranges use the analyzer's audio clock. Activity and endpoint
// timing use main-process receipt time, with a deliberately different origin.
const RECEIPT_ORIGIN = 100_000;
const activity = (detector, speaking, at) => detector.receive({ type: 'activity', speaking }, RECEIPT_ORIGIN + at);
const result = (detector, text, startMs, endMs, at, final = false, segmentId = String(startMs)) => detector.receive({
  type: 'transcript', text, segmentId, final, startMs, endMs,
}, RECEIPT_ORIGIN + at);
const poll = (detector, at) => detector.poll(RECEIPT_ORIGIN + at);

const firstQuestion = 'Okay, great. So what made you want to apply for this particular role?';
const secondQuestion = 'Tell me about a time you had to deal with a difficult teammate.';
const thirdQuestion = 'How do you prioritize your work when several deadlines conflict?';

export default [
  {
    name: 'interview speech replay: real Apple capture preserves exactly four complete spoken turns',
    run() {
      const records = readFileSync(new URL('../fixtures/interview-live-asr-events-2026-10-30.jsonl', import.meta.url), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      // Recorded detector endpoints are evidence of the bug, not replay input
      // or expected output. Poll continuously, including gaps between events.
      const events = records.filter(record => record.type === 'helper-event');
      const detector = createInterviewCallQuestionDetector();
      const endpoints = [];
      const collect = at => {
        const endpoint = detector.poll(at);
        if (endpoint) endpoints.push(endpoint);
      };
      let nextPollAt = events[0].receivedAtMs;
      for (const { event, receivedAtMs } of events) {
        while (nextPollAt < receivedAtMs) {
          collect(nextPollAt);
          nextPollAt += 25;
        }
        detector.receive(event, receivedAtMs);
        collect(receivedAtMs);
      }
      const drainedAt = events.at(-1).receivedAtMs + 5000;
      while (nextPollAt <= drainedAt) {
        collect(nextPollAt);
        nextPollAt += 25;
      }
      assert.deepEqual(endpoints.map(endpoint => endpoint.text), [
        'All right, so to get things started, could you walk me through a project you have worked on that you are really proud of?',
        'Great. Thanks for sharing that. Now, I am curious. Why are you interested in working at Discord specifically?',
        'That makes a lot of sense. Our team actually launched something pretty similar last year.',
        'Okay, and what are your salary expectations for this position?',
      ]);
      assert.deepEqual(endpoints.map(endpoint => endpoint.id), [1, 2, 3, 4], 'no extra or duplicate endpoints');
      assert.equal(detector.getTranscript(), '', 'punctuation-only idle results cannot reopen a turn');
      assert.equal(detector.poll(drainedAt + 10_000), null);
    },
  },
  {
    name: 'interview speech replay: an early-ending final waits only the grace before recovering its superseded tail',
    run() {
      for (const volatileEnding of ['?', '']) {
        const detector = createInterviewCallQuestionDetector();
        const complete = 'Okay, and what are your salary expectations for this position?';
        activity(detector, true, 0);
        result(detector, complete.replace(/\?$/u, volatileEnding), 0, 4000, 4000);
        activity(detector, false, 4100);
        assert.equal(result(detector, '. Okay, and what are your salary expectations?', 1000, 3500, 4300, true), true);
        assert.equal(poll(detector, 4899), null, '800ms silence remains mandatory');
        assert.equal(poll(detector, 4900), null, 'a final that leaves heard words uncovered still needs finalization grace');
        assert.equal(poll(detector, 5599), null);
        assert.equal(poll(detector, 5600)?.text, complete, 'recover all heard words at the bounded deadline, retaining the question mark');
        assert.equal(poll(detector, 7000), null);

        activity(detector, true, 7100);
        result(detector, thirdQuestion, 4500, 7000, 7200);
        assert.equal(result(detector, complete, 0, 4200, 7300, true), false,
          'a late correction of the recovered hypothesis cannot contaminate the next turn');
        assert.equal(detector.getTranscript(), thirdQuestion);
        result(detector, thirdQuestion, 4500, 7000, 7400, true);
        activity(detector, false, 7500);
        const next = poll(detector, 8300);
        assert.equal(next?.id, 2);
        assert.equal(next?.text, thirdQuestion);
        assert.equal(poll(detector, 10_000), null);
      }
    },
  },
  {
    name: 'interview speech replay: a corrected final can retain a uniquely aligned volatile suffix',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 0);
      result(detector, 'Okay, what are your salary expectations for this position?', 0, 4000, 4000);
      activity(detector, false, 4100);
      result(detector, '. Well, what are your salary expectations?', 1000, 3500, 4300, true);
      assert.equal(poll(detector, 4900), null);
      assert.equal(poll(detector, 5600)?.text, 'Well, what are your salary expectations for this position?',
        'retain final corrections without repeating its shared words or losing the unfinalized suffix');
      assert.equal(poll(detector, 7000), null);
    },
  },
  {
    name: 'interview speech replay: a later final covering the saved tail releases grace with normal stability',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 0);
      result(detector, 'Tell me about a project and its results?', 0, 4000, 4000);
      activity(detector, false, 4100);
      result(detector, 'Tell me about a project', 1000, 3500, 4200, true);
      assert.equal(poll(detector, 4900), null);
      assert.equal(result(detector, 'and its results?', 3500, 4000, 5000, true), true);
      assert.equal(poll(detector, 5249), null, 'the newly finalized words must stabilize for 250ms');
      assert.equal(poll(detector, 5250)?.text, 'Tell me about a project and its results?',
        'covering finals need not wait out the remaining grace');
      assert.equal(poll(detector, 7000), null);
    },
  },
  {
    name: 'interview speech replay: a fresh volatile tail replaces the saved hypothesis rather than duplicating it',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 0);
      result(detector, 'Tell me about a project and its old results?', 0, 4000, 4000);
      activity(detector, false, 4100);
      result(detector, 'Tell me about a project', 1000, 3500, 4200, true);
      result(detector, 'and what you learned?', 3500, 4500, 4300);
      assert.equal(poll(detector, 5600)?.text, 'Tell me about a project and what you learned?');
      assert.equal(poll(detector, 7000), null);
    },
  },
  {
    name: 'interview speech replay: delayed correcting finals with changed ends cannot revive a retired volatile turn',
    run() {
      for (const endMs of [2900, 3000, 3300]) {
        for (const nextQuestion of [false, true]) {
          const detector = createInterviewCallQuestionDetector();
          activity(detector, true, 0);
          result(detector, 'what made you want to apply for this roll', 0, 3000, 3000);
          activity(detector, false, 3180);
          assert.equal(poll(detector, 4680)?.id, 1, 'a missing final eventually reaches the bounded fallback');
          activity(detector, true, 4800); // Next speech, cough, or notification.
          if (nextQuestion) result(detector, 'What are your strengths?', 3500, 5500, 4900);
          assert.equal(result(detector, 'What made you want to apply for this role?', 0, endMs, 5000, true), false,
            'the analyzer range start identifies the correction even when words and end change');
          activity(detector, false, 5500);
          const endpoint = poll(detector, 7000);
          assert.equal(endpoint?.text ?? null, nextQuestion ? 'What are your strengths?' : null);
          assert.equal(poll(detector, 9000), null, 'one correction must never create another endpoint');
        }
      }
    },
  },
  {
    name: 'interview speech replay: finalization grace preserves trailing words before emitting the turn',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 0);
      result(detector, 'Tell me about a time you disagreed with your', 0, 2900, 3000);
      activity(detector, false, 3180);
      assert.equal(poll(detector, 3980), null, 'the old silence deadline must not emit truncated volatile text');
      result(detector, 'Tell me about a time you disagreed with your manager?', 0, 3400, 4200, true);
      assert.equal(poll(detector, 4449), null, 'a corrected final still observes transcript stability');
      assert.equal(poll(detector, 4450)?.text, 'Tell me about a time you disagreed with your manager?');
      assert.equal(poll(detector, 6000), null);
    },
  },
  {
    name: 'interview speech replay: finalization grace is bounded when the analyzer never returns a final',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 0);
      result(detector, 'How do you prioritize your work?', 0, 3000, 3000);
      activity(detector, false, 3180);
      assert.equal(poll(detector, 4679), null);
      assert.equal(poll(detector, 4680)?.text, 'How do you prioritize your work?');
      assert.equal(poll(detector, 6000), null);
    },
  },
  {
    name: 'interview speech replay: a reading pause after an unfinished scaffold preserves one complete AI turn',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 0);
      result(detector, 'Can you walk me through', 0, 1600, 1600, true);
      activity(detector, false, 1780);
      assert.equal(poll(detector, 2580), null, 'one second of quiet must not cut unfinished scaffolding');
      activity(detector, true, 2700); // 1.1s reading pause from the last voice.
      result(detector, 'a project you are really proud of?', 1600, 4800, 4900, true);
      activity(detector, false, 4980);
      const endpoint = poll(detector, 5780);
      assert.equal(endpoint?.text, 'Can you walk me through a project you are really proud of?');
      assert.equal(selectInterviewCallQuestion(endpoint, {}, { semantic: true }).question, endpoint.text);
    },
  },
  {
    name: 'interview speech replay: continuation timing is bounded and never suppresses AI interpretation',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 0);
      result(detector, 'Tell me about a time when', 0, 1600, 1600, true);
      activity(detector, false, 1780);
      assert.equal(poll(detector, 3979), null);
      const endpoint = poll(detector, 3980);
      assert.equal(endpoint?.text, 'Tell me about a time when');
      assert.equal(selectInterviewCallQuestion(endpoint, {}, { semantic: true }).accepted, true,
        'the bounded delay must not become a local not-question verdict');
    },
  },
  {
    name: 'interview speech replay: one volatile tail replaces shifted starts even when ranges no longer overlap',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 100);
      result(detector, 'great.', 0, 260, 450);
      result(detector, 'Okay, great. So what made you want to a', 300, 3000, 3200);
      assert.equal(detector.getTranscript(), 'Okay, great. So what made you want to a');
      result(detector, firstQuestion, 80, 4500, 4700);
      assert.equal(detector.getTranscript(), firstQuestion);
      activity(detector, false, 4800);
      assert.equal(poll(detector, 5599), null);
      assert.equal(poll(detector, 5600), null, 'a volatile tail gets a bounded finalization grace interval');
      assert.equal(poll(detector, 6300)?.text, firstQuestion);
      assert.equal(poll(detector, 8000), null);
    },
  },
  {
    name: 'interview speech replay: final commits replace an overlapping volatile tail extending beyond the final',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 100);
      result(detector, 'Okay, great. So what made you want to a', 0, 3000, 3100);
      assert.equal(result(detector, 'Okay, great.', 80, 600, 3200, true), true);
      assert.equal(detector.getTranscript(), 'Okay, great.');
      result(detector, 'So what made you want to apply for this role', 600, 4200, 4300);
      activity(detector, false, 5000);
      result(detector, 'So what made you want to apply for this particular role?', 680, 5400, 5500);
      assert.equal(result(detector, 'So what made you want to apply for this particular role?', 600, 5000, 5600, true), true,
        'a superseded volatile start is still a valid later final commit');
      assert.equal(detector.getTranscript(), firstQuestion);
      assert.equal(poll(detector, 5850)?.text, firstQuestion);
    },
  },
  {
    name: 'interview speech replay: three questions survive final tiling silence and inflated old volatile ranges',
    run() {
      const detector = createInterviewCallQuestionDetector();
      const endpoints = [];

      activity(detector, true, 100);
      result(detector, 'great.', 0, 350, 500);
      result(detector, 'Okay, great. So what made you want to a', 400, 4300, 4400);
      activity(detector, false, 4500);
      result(detector, 'Okay, great. So what made you want to apply for this role', 400, 5000, 5100);
      result(detector, firstQuestion, 0, 4400, 5200, true);
      assert.equal(poll(detector, 5449), null);
      endpoints.push(poll(detector, 5450));

      // The second result starts at the first final's end, before this actual
      // utterance: the range includes the intervening two seconds of silence.
      activity(detector, true, 6500);
      result(detector, 'Tell me about a time you had to deal', 4400, 8800, 8900);
      activity(detector, false, 10_000);
      result(detector, secondQuestion, 4600, 10_400, 10_500);
      result(detector, secondQuestion, 4400, 10_000, 10_600, true);
      endpoints.push(poll(detector, 10_850));

      activity(detector, true, 11_200);
      result(detector, 'How do you prioritize your work', 10_000, 13_000, 13_200);
      activity(detector, false, 14_500);
      result(detector, thirdQuestion, 10_180, 14_900, 15_000);
      result(detector, thirdQuestion, 10_000, 14_500, 15_100, true);
      endpoints.push(poll(detector, 15_350));

      assert.deepEqual(endpoints.map(endpoint => endpoint?.text), [firstQuestion, secondQuestion, thirdQuestion]);
      assert.deepEqual(endpoints.map(endpoint => endpoint?.id), [1, 2, 3]);
      assert(endpoints.every(endpoint => endpoint.question), 'all three turns remain complete question endpoints');
      assert.equal(poll(detector, 20_000), null);
    },
  },
  {
    name: 'interview speech replay: delayed final revisions of an endpointed volatile turn cannot create another turn',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 100);
      result(detector, firstQuestion, 0, 4200, 4300);
      activity(detector, false, 4400);
      assert.equal(poll(detector, 5900)?.text, firstQuestion);

      assert.equal(result(detector, firstQuestion, 0, 4200, 6100, true), false);
      assert.equal(detector.getTranscript(), '');
      assert.equal(poll(detector, 6200), null);

      activity(detector, true, 6500);
      result(detector, 'Tell me about a time you had to deal', 4200, 8500, 8600);
      assert.equal(result(detector, firstQuestion, 80, 4200, 8700, true), false,
        'a delayed old final with a shifted id is still wholly in retired audio');
      assert.equal(detector.getTranscript(), 'Tell me about a time you had to deal');
      result(detector, secondQuestion, 4200, 9800, 9850, true);
      activity(detector, false, 9900);
      assert.equal(poll(detector, 10_700)?.text, secondQuestion);
      assert.equal(poll(detector, 12_000), null);
    },
  },
  {
    name: 'interview speech replay: a changed delayed final after fresh activity cannot contaminate the next question',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 100);
      result(detector, 'What made you want to apply for this role', 0, 4200, 4300);
      activity(detector, false, 4400);
      assert(poll(detector, 5900));
      activity(detector, true, 6500);
      result(detector, 'Tell me about a time you had to deal', 4200, 8500, 8600);
      assert.equal(result(detector, firstQuestion, 80, 4200, 8700, true), false,
        'the old audio endpoint identifies its corrected final without an idle final first');
      assert.equal(detector.getTranscript(), 'Tell me about a time you had to deal');
      result(detector, secondQuestion, 4200, 9800, 9850, true);
      activity(detector, false, 9900);
      assert.equal(poll(detector, 10_700)?.text, secondQuestion);
      assert.equal(poll(detector, 12_000), null);
    },
  },
  {
    name: 'interview speech replay: a new utterance crossing a retired boundary may reuse the old range start',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 100);
      result(detector, firstQuestion, 0, 4200, 4300);
      activity(detector, false, 4400);
      assert.equal(poll(detector, 5900)?.text, firstQuestion);

      activity(detector, true, 6500);
      assert.equal(result(detector, secondQuestion, 0, 9500, 9600), true,
        'a reused timestamp id and an old range start cannot make the detector deaf');
      assert.equal(detector.getTranscript(), secondQuestion);
      result(detector, secondQuestion, 0, 9800, 9850, true);
      activity(detector, false, 9900);
      assert.equal(poll(detector, 10_700)?.text, secondQuestion);
    },
  },
  {
    name: 'interview speech replay: final replacements still require 800ms silence and 250ms text stability',
    run() {
      const detector = createInterviewCallQuestionDetector();
      activity(detector, true, 100);
      result(detector, 'Tell me about a time you had to deal with a difficult team mate', 0, 4000, 4100);
      activity(detector, false, 4200);
      result(detector, secondQuestion, 0, 4300, 4900, true);
      assert.equal(poll(detector, 4999), null);
      assert.equal(poll(detector, 5000), null, 'the final correction has not been stable for 250ms');
      assert.equal(poll(detector, 5149), null);
      assert.equal(poll(detector, 5150)?.text, secondQuestion);
    },
  },
];
