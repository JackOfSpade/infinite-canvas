/**
 * SYNTHETIC scripted candidates for the interview practice call simulation.
 * Every name, sentence, pause and duration below is invented for the simulation; none of it is recorded or real data,
 * EXCEPT the pause-heavy-answers scenario, whose within-answer pause durations are real (AMI Meeting Corpus, CC BY 4.0,
 * read from scripts/fixtures/ami-within-turn-pauses.json). Its speech text is still synthetic.
 * Each scenario has: interviewer lines (one per interviewer utterance, in play order), candidate `actions`
 * with real timing, and machine-checkable `expect` data that scripts/tests/interview-practice-call-simulation.js asserts.
 */

import { readFileSync } from 'node:fs';

export const say = (text, { durationMs, pausesMs = [], unfinished = false } = {}) => ({ type: 'say', text, durationMs, pausesMs, unfinished });
export const wait = (ms, { afterInterviewer = true } = {}) => ({ type: 'wait', ms, afterInterviewer });
export const typeChat = (text, options = {}) => ({ type: 'typeChat', text, ...options });
export const typingStart = () => ({ type: 'typingStart' });
export const typingStop = () => ({ type: 'typingStop' });
export const hangUp = (options = {}) => ({ type: 'hangUp', ...options });
export const overlap = (text, { kind = 'ack', atMsAfterPlaybackStart = 0, durationMs } = {}) => ({
  type: 'overlap', text, kind, atMsAfterPlaybackStart, durationMs,
});

const GREETING = 'Hi, thanks for joining today. Tell me about a project you are proud of.';
const LONG_REPLY = 'Interesting, that sounds like a substantial piece of work. Walk me through how you decided on the architecture and which trade-offs you weighed along the way. I would also like to hear how the team reacted to the change.';

export const SCENARIOS = [
  {
    name: 'ack-mid-sentence', synthetic: true,
    interviewer: [GREETING, LONG_REPLY, 'Thanks, that makes sense.'],
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      overlap('right', { kind: 'ack', atMsAfterPlaybackStart: 2500, durationMs: 300 }),
      overlap('gotcha', { kind: 'ack', atMsAfterPlaybackStart: 5500, durationMs: 350 }),
      say('We chose queues because the retries were hard to reason about', { durationMs: 3000 }),
    ],
    expect: { cancels: 0, plays: 3, acknowledgements: ['right', 'gotcha'], ended: null },
  },
  {
    name: 'clarification-interrupt', synthetic: true,
    interviewer: [GREETING, LONG_REPLY, 'Yes, the API layer in front of the queue.'],
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      overlap('sorry, do you mean the API layer?', { kind: 'interrupt', atMsAfterPlaybackStart: 3000, durationMs: 1400 }),
    ],
    expect: { cancels: 1, plays: 3, interrupted: true },
  },
  {
    name: 'short-interrupt-classifier', synthetic: true,
    interviewer: [GREETING, LONG_REPLY, 'Of course, go ahead.'],
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      overlap('no, wait', { kind: 'interrupt', atMsAfterPlaybackStart: 3000, durationMs: 500 }),
    ],
    expect: { cancels: 1, classifierCalls: 1, classifierBeforeCancel: true },
  },
  {
    name: 'thinking-pause', synthetic: true,
    interviewer: [GREETING, 'Good, tell me more about the indexing.'],
    actions: [
      say('I would start with the data model and then think about indexing', { durationMs: 3200, pausesMs: [1500] }),
    ],
    expect: { plays: 2, cutIns: 0, pauseMs: 1500 },
  },
];

SCENARIOS.push(
  {
    name: 'silence-10s', synthetic: true,
    interviewer: [GREETING, 'Take your time, would you like me to rephrase the question?'],
    actions: [wait(11000)],
    expect: { silenceMessages: 1 },
  },
  {
    name: 'hang-up', synthetic: true,
    interviewer: [GREETING, LONG_REPLY],
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      hangUp({ atMsAfterPlaybackStart: 2000 }),
    ],
    expect: { endedReason: 'candidate', cancelsPlayingUtterance: true, commandsAfterEnd: 0 },
  },
  {
    name: 'session-crash', synthetic: true,
    interviewer: [GREETING, 'Thanks, that is clear. What was the hardest part?', 'I see, and how did you measure the result?'],
    failOn: { kind: 'main', turn: 1 },
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      say('The hardest part was keeping the old and new paths consistent', { durationMs: 3000 }),
    ],
    expect: { restartKind: 'main', resentTurn: true, plays: 3 },
  },
  {
    name: 'end-call', synthetic: true,
    interviewer: [GREETING, { say: 'Thanks for your time today. Goodbye.', endCall: true }],
    actions: [say('I led a migration of our billing service to a queue based design', { durationMs: 3500 })],
    expect: { endedReason: 'interviewer', endedAfterFinished: true },
  },
  {
    name: 'chat-typed-turn', synthetic: true,
    interviewer: [GREETING, 'Good, go on from there.'],
    actions: [typeChat('I would start with the data model')],
    expect: { typedMessage: "Candidate (typed in chat): 'I would start with the data model'", transcriptChannel: 'chat' },
  },
  {
    name: 'chat-typing-pauses-silence', synthetic: true,
    interviewer: [GREETING, 'Sure, take your time.', 'Thanks, that looks right.'],
    actions: [
      say("I'll type it in chat", { durationMs: 1200 }),
      typingStart(),
      wait(15000),
      typeChat('def add(a, b): return a + b'),
    ],
    expect: { silenceMessages: 0, typingFlag: '[candidate is typing in chat]', typedMessage: "Candidate (typed in chat): 'def add(a, b): return a + b'" },
  },
  {
    name: 'chat-type-over-interviewer', synthetic: true,
    interviewer: [GREETING, LONG_REPLY, 'Thanks, I have read your message.'],
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      typeChat('I will write it in chat', { during: true, atMsAfterPlaybackStart: 3000 }),
    ],
    expect: { cancels: 1, typedMessage: "Candidate (typed in chat): 'I will write it in chat'", interrupted: true },
  },
  {
    name: 'interviewer-chat-post', synthetic: true,
    interviewer: [GREETING, {
      say: 'Here is the problem. Take a moment to read it.',
      chat: 'Given a list of intervals, merge all overlapping intervals and return the result.',
    }],
    actions: [say('I am ready for a coding question', { durationMs: 2000 })],
    expect: { chatText: 'Given a list of intervals, merge all overlapping intervals and return the result.', chatNeverSpoken: true },
  },
  // Ear-on scenarios: run them with runScenario(scenario, { ear: { smartTurnAccuracy } }); the ear stays off by default.
  {
    name: 'ack-overlap-ear', synthetic: true, ear: true,
    interviewer: [GREETING, LONG_REPLY, 'Thanks, that makes sense.'],
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      overlap('right', { kind: 'ack', atMsAfterPlaybackStart: 2500, durationMs: 300 }),
      say('We chose queues because the retries were hard to reason about', { durationMs: 3000 }),
    ],
    expect: { ear: true, acknowledgements: ['right'], cancels: 0, pauses: 0, plays: 3 },
  },
  {
    name: 'interrupt-overlap-ear', synthetic: true, ear: true,
    interviewer: [GREETING, LONG_REPLY, 'Yes, the queue sits in front of the billing API.'],
    actions: [
      say('I led a migration of our billing service to a queue based design', { durationMs: 3500 }),
      overlap('sorry, is that the billing API layer?', { kind: 'interrupt', atMsAfterPlaybackStart: 3000, durationMs: 1400 }),
    ],
    expect: { ear: true, interrupted: true, pauses: 1, cancels: 1, plays: 3 },
  },
  {
    name: 'smart-turn-hold-pause', synthetic: true, ear: true,
    interviewer: [GREETING, 'Good, tell me more about the indexing.'],
    actions: [say('I would start with the data model and then think about indexing', { durationMs: 3200, pausesMs: [4000] })],
    // Ear off with fast thresholds (speculateMs 600 / commitMs 1200) a reply starts inside that pause; the hold pushes
    // both timers out past it, so the ear-off cut-in is the control for the ear-on run in the simulation test.
    expect: { ear: true, cutIns: 0, pauses: 0 },
  },
);

// Real within-turn pause durations (AMI Meeting Corpus, CC BY 4.0). Read-only data file: never edited by this code.
export const AMI_PAUSES_FILE = 'scripts/fixtures/ami-within-turn-pauses.json';
export const AMI_PAUSES = JSON.parse(readFileSync(new URL('./ami-within-turn-pauses.json', import.meta.url), 'utf8'));
if (!Array.isArray(AMI_PAUSES.pausesMs) || !AMI_PAUSES.pausesMs.length
  || !AMI_PAUSES.pausesMs.every(ms => Number.isFinite(ms) && ms > 0)) {
  throw new Error(`${AMI_PAUSES_FILE}: pausesMs must be a non-empty array of positive numbers`);
}
export const PAUSE_SOURCE_LINE = `Within-answer pauses: ${AMI_PAUSES.pausesMs.length} real durations from ${AMI_PAUSES.source} (${AMI_PAUSES_FILE})`;
export const PAUSE_HEAVY_LABEL = 'synthetic speech text, real pause durations';

// Sweep scenario: 2-5 within-answer pauses per answer, each sampled (seeded) from the AMI pause durations, followed
// by a turn-final silence (the candidate then waits for the interviewer to respond). Invented phrases, seeded per run.
const PHRASES = [
  'so the first thing I did was', 'look at the request logs', 'and what I found was that', 'most of the latency came from',
  'a single slow database query', 'so I added an index there', 'and then we measured again', 'the slowest requests dropped quite a bit',
  'which let us ship the change', 'without needing more servers',
];

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PAUSE_HEAVY_ANSWERS = 6;

export function pauseHeavyActions(seed, answers = PAUSE_HEAVY_ANSWERS) {
  const rand = prng((seed >>> 0) * 7919 + 13);
  const actions = [];
  for (let answer = 0; answer < answers; answer += 1) {
    const pauseCount = 2 + Math.floor(rand() * 4);
    const pool = [...PHRASES];
    const phrases = [];
    for (let index = 0; index <= pauseCount; index += 1) phrases.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    const pausesMs = phrases.slice(1).map(() => AMI_PAUSES.pausesMs[Math.floor(rand() * AMI_PAUSES.pausesMs.length)]);
    const text = phrases.join(' ');
    actions.push(say(text, { durationMs: text.split(' ').length * 330, pausesMs }));
  }
  // Turn-final silence: wait() blocks until the interviewer has answered the last answer, then sleeps.
  actions.push(wait(1000));
  return actions;
}

SCENARIOS.push({
  name: 'pause-heavy-answers', synthetic: true, sweep: true, loopLines: true,
  label: PAUSE_HEAVY_LABEL, pauseSource: AMI_PAUSES_FILE,
  interviewer: [
    GREETING, 'Okay, and what did you do next?', 'Right, how did you check that it worked?',
    'Understood, what would you change if you did it again?', 'Fair enough, who else was involved?',
  ],
  actions: pauseHeavyActions,
  expect: { answers: PAUSE_HEAVY_ANSWERS },
});

export const getScenario = name => {
  const found = SCENARIOS.find(item => item.name === name);
  if (!found) throw new Error(`unknown scenario: ${name}`);
  return found;
};
