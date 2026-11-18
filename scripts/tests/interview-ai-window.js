import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInterviewWindowController } from '../../electron/interviewWindow.js';
import { createInterviewAiMatcher } from '../../electron/interviewAiMatcher.js';
import { buildInterviewPlan, isDependentInterviewFollowUp } from '../../src/utils/interviewHelper.js';
import { matchInterviewAnswerCard } from '../../src/utils/interviewAnswerMatching.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';

const SEMANTIC_QUESTION = 'Describe how you enabled peers to exercise sound judgement without taking their decisions away.';
const pick = (cardId, followUp = false) => ({ kind: followUp ? 'follow-up' : 'question', cardId, confidence: 0.98 });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Contents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.mainFrame = {}; this.sent = []; }
  send(channel, value) { this.sent.push({ channel, value }); }
  setWindowOpenHandler() {}
}
class Window extends EventEmitter {
  static nextId = 1;
  static all = new Map();
  static fromWebContents(sender) { return this.all.get(sender); }
  constructor() { super(); this.id = Window.nextId++; this.webContents = new Contents(this.id); Window.all.set(this.webContents, this); }
  async loadURL() {}
  focus() {}
  isDestroyed() { return !!this.destroyed; }
  close() { if (this.destroyed) return; this.emit('close'); this.destroyed = true; this.emit('closed'); Window.all.delete(this.webContents); }
}
async function harness({ launchQuestion = null, initialResponses = [], poolSize = 1, createTalkingPoints = null } = {}) {
  const fixture = createInterviewWindowE2EFixture();
  const owner = new Window(); const handlers = new Map(); const transports = []; const queue = [...initialResponses];
  let time = 0; let bank = fixture.bank; let failPlan = false; let audioInput; let audioState; let active = false; let endpointId = 0;
  const controller = createInterviewWindowController({ BrowserWindow: Window,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    appInstance: { isPackaged: false, getPath: () => '/tmp/synthetic-interview-ai-unused' },
    isAuthorizedOwner: candidate => candidate === owner,
    loadSnapshot: async () => fixture.snapshot, loadBundle: async () => fixture.bundle,
    loadPreparedBrief: async () => fixture.brief, loadAnswerBank: async () => bank,
    buildPlan: options => { if (failPlan) throw new Error('Synthetic projection failure.'); return buildInterviewPlan(options); },
    createMatcher: options => createInterviewAiMatcher({ ...options, config: { ...options.config, poolSize }, now: () => time }),
    matcherConfig: { timeoutMs: 5000 },
    createTalkingPoints,
    matcherTransportFactory: () => {
      const record = { starts: [], matches: [], closes: 0 };
      transports.push(record);
      return { start: async input => { record.starts.push(input); },
        async match(input) {
          record.matches.push(input);
          const next = queue.shift();
          if (!next) throw new Error('No synthetic AI response queued.');
          time += next.latencyMs || 0;
          next.started?.resolve();
          return next.pending ? next.pending.promise : next.result;
        },
        close: async () => { record.closes += 1; } };
    },
    createAudioService: input => {
      audioInput = input;
      const state = audioState = { status: 'idle', transcript: '', question: '', errorCode: null, message: '' };
      return { start() { active = true; state.status = 'listening'; input.onState(state); return state; },
        stop() { active = false; state.status = 'idle'; input.onState(state); return state; },
        notice: message => { state.message = message; } };
    },
    devServerUrl: 'http://127.0.0.1:41739/',
  });
  const argsFor = question => ({ nodeId: 'ai_window_test', snapshotId: fixture.snapshot.snapshotId,
    jobUrl: fixture.canonicalJobUrl, briefRecordId: fixture.briefRecordId, brief: fixture.brief,
    plan: question ? buildInterviewPlan({ question, profile: fixture.snapshot, snapshotId: fixture.snapshot.snapshotId }) : null, currentStep: 0 });
  await controller.launch({ sender: owner.webContents }, argsFor(launchQuestion));
  const session = [...controller.sessions.values()][0];
  const event = { sender: session.child.webContents, senderFrame: session.child.webContents.mainFrame };
  const updates = () => event.sender.sent.filter(item => item.channel === 'interview-window:brief-updated');
  // Puts a prepared answer on screen the way the running app does: a detected
  // question that the AI maps to the card. The call counters are then zeroed so
  // the test measures only what it does next.
  const lock = async cardId => {
    const card = fixture.bank.cards.find(item => item.id === cardId);
    controller.startListening(event); queue.push({ result: pick(cardId) });
    await audioInput.onQuestion({ text: card.question, id: 'prime' }, () => active);
    for (const record of transports) record.matches.length = 0;
  };
  return { fixture, owner, controller, session, event, handlers, transports, queue, updates, lock, listeningState: () => audioState,
    setBank: value => { bank = value; }, failPlan: value => { failPlan = value; },
    launchQuestion: question => controller.launch({ sender: owner.webContents }, argsFor(question)),
    endpoint: (text, isCurrent = () => active, id = ++endpointId) => audioInput.onQuestion({ text, id }, isCurrent),
    partial: (text, turnId = endpointId + 1) => audioInput.onPartial({ text, turnId }),
    cleanup: () => controller.cleanupOwner(owner) };
}

export default [
  {
    name: 'interview AI window: an unmatched question gets live talking points; a matched, superseded or closed one never does',
    async run() {
      const asked = []; const replies = []; let closes = 0;
      const createTalkingPoints = () => ({ start: async () => {}, close: () => { closes += 1; },
        generate: question => { asked.push(question); const reply = deferred(); replies.push(reply); return reply.promise; } });
      const h = await harness({ createTalkingPoints });
      const settle = () => new Promise(resolve => setImmediate(resolve));
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: { kind: 'question', cardId: 'none', confidence: 0.9 } });
        await h.endpoint('Tell me about a time you handled conflict between coworkers.');
        const blank = h.session.display;
        assert.equal(blank.answerCard, null); assert.equal(blank.talkingPoints, undefined, 'the card is blank until the points arrive');
        assert.deepEqual(asked, ['Tell me about a time you handled conflict between coworkers.']);
        const before = h.updates().length;
        replies[0].resolve([{ text: 'Listen actively', sub: ['Hear each person separately first', ' '] }, 'Focus on shared goal', '  ']); await settle();
        assert.deepEqual(JSON.parse(JSON.stringify(h.session.display.talkingPoints)), [{ text: 'Listen actively', sub: ['Hear each person separately first'] }, { text: 'Focus on shared goal', sub: [] }]);
        assert.equal(h.session.display.answerCard, null); assert.equal(h.updates().length, before + 1);
        assert.equal(h.updates().at(-1).value, h.session.display);
        // A question a prepared card answers asks for nothing and drops the old points.
        h.queue.push({ result: pick('leadership') });
        await h.endpoint('Tell me about leading teams.');
        assert.equal(h.session.display.answerCard.id, 'leadership'); assert.equal(h.session.display.talkingPoints, undefined); assert.equal(asked.length, 1);
        // Points that arrive after the next question is on screen are discarded.
        h.queue.push({ result: { kind: 'question', cardId: 'none', confidence: 0.9 } });
        await h.endpoint('What would you do with a vague requirement from a client?');
        h.queue.push({ result: pick('priorities') });
        await h.endpoint('How do you decide what to do first?');
        const shown = h.session.display; const count = h.updates().length;
        replies[1].resolve(['Ask clarifying questions', 'Confirm the goal']); await settle();
        assert.equal(h.session.display, shown, 'late points cannot replace a newer answer'); assert.equal(h.updates().length, count);
        // One point, or none, is not an outline: the card stays blank.
        h.queue.push({ result: { kind: 'question', cardId: 'none', confidence: 0.9 } });
        await h.endpoint('What is your favourite database and why is that so?');
        const still = h.session.display;
        replies[2].resolve(['Only one point']); await settle();
        assert.equal(h.session.display, still);
        // Not a question: nothing is requested.
        h.queue.push({ result: { kind: 'not-question', cardId: 'none', confidence: 0.99 } });
        await h.endpoint('Okay great, thanks for sharing that with me.');
        assert.equal(asked.length, 3);
      } finally { h.cleanup(); }
      assert(closes >= 1, 'closing the window ends the talking-points session');
    },
  },
  {
    name: 'interview AI window: identical in-flight audio selection locks without another transport call and clears preview immediately',
    async run() {
      for (const withPreview of [false, true]) {
        const h = await harness({ poolSize: 2 }); const pending = deferred(); const started = deferred();
        try {
          await h.lock('priorities'); h.controller.startListening(h.event);
          const answer = h.session.display.answerCard; const anchor = h.session.anchorPlan;
          if (withPreview) {
            h.queue.push({ result: pick('leadership') }); h.partial('Tell me about leading');
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(h.session.display.preview.cardId, 'leadership');
          }
          h.queue.push({ pending, started }); h.partial('Tell me about leading teams'); await started.promise;
          const lookup = h.endpoint(' TELL  me about leading teams?! ');
          assert.equal(h.session.display.preview, null, 'preview clears before the in-flight selection settles');
          assert.equal(h.session.display.answerCard, answer); assert.equal(h.session.anchorPlan, anchor);
          assert.equal(h.session.locked, true); assert.equal(h.session.questionOrigin, 'audio');
          assert.deepEqual(h.transports.map(transport => transport.matches.length), [0, withPreview ? 2 : 1]);
          pending.resolve(pick('leadership')); await lookup;
          assert.equal(h.session.display.answerCard.id, 'leadership'); assert.equal(h.session.locked, true);
          assert.equal(h.session.display.matching.source, 'speculative-inflight'); assert.equal(h.session.display.preview, null);
          assert.deepEqual(h.transports.map(transport => transport.matches.length), [0, withPreview ? 2 : 1], 'endpoint must not restart the identical selection');
          assert.equal(h.transports.flatMap(transport => transport.matches).filter(input => input.question === 'Tell me about leading teams').length, 1);
          assert.equal(h.updates().at(-1).value, h.session.display);
        } finally { pending.resolve(pick('leadership')); h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: unsuitable in-flight replies fall back to a normal final selection',
    async run() {
      for (const selection of [{ ...pick('leadership'), confidence: 0.1 }, { kind: 'not-question', cardId: 'none', confidence: 0.99 }]) {
        const h = await harness({ poolSize: 2 }); const pending = deferred(); const started = deferred();
        try {
          h.controller.startListening(h.event);
          h.queue.push({ pending, started }); h.partial('Tell me about leading teams'); await started.promise;
          h.queue.push({ result: pick('priorities') });
          const lookup = h.endpoint('Tell me about leading teams.');
          pending.resolve(selection); await lookup;
          assert.equal(h.session.display.answerCard.id, 'priorities'); assert.equal(h.session.display.matching.source, 'ai');
          assert.deepEqual(h.transports.map(transport => transport.matches.length), [1, 1]);
          assert.equal(h.transports[0].matches[0].question, 'Tell me about leading teams.');
          assert.equal(h.session.locked, true); assert.equal(h.session.display.preview, null);
        } finally { pending.resolve(pick('leadership')); h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: preview is independent sealed display state, coalesces confidence and locks instantly',
    async run() {
      const h = await harness({ poolSize: 2 });
      try {
        await h.lock('priorities');
        const locked = h.session.display.answerCard; const anchor = h.session.anchorPlan;
        h.controller.startListening(h.event);
        const before = h.updates().length;
        h.queue.push({ result: { ...pick('leadership'), confidence: 0.6 } });
        h.partial('Tell me about leading'); await new Promise(resolve => setImmediate(resolve));
        const preview = h.session.display.preview;
        assert.equal(preview.id, '1'); assert.equal(preview.cardId, 'leadership');
        assert.equal(preview.transcript, 'Tell me about leading'); assert.equal(preview.confidence, 0.6);
        assert.equal(Number.isFinite(preview.updatedAt), true);
        assert.equal(preview.card.question, h.session.answerBank.cards.find(card => card.id === 'leadership').question);
        assert.deepEqual(Object.keys(preview).sort(), ['card', 'cardId', 'confidence', 'id', 'transcript', 'updatedAt']);
        assert.equal(h.session.display.answerCard, locked); assert.equal(h.session.anchorPlan, anchor); assert.equal(h.session.locked, true);
        assert.equal(h.updates().length, before + 1);
        h.queue.push({ result: { ...pick('leadership'), confidence: 0.61 } });
        h.partial('Tell me about leading teams'); await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.updates().length, before + 1, 'same rounded confidence must not churn the renderer');
        assert.equal(h.session.display.preview, preview);
        await h.endpoint('Tell me about leading teams.');
        assert.equal(h.session.display.preview, null); assert.equal(h.session.display.answerCard.id, 'leadership');
        assert.deepEqual(h.session.display.answerCard, preview.card, 'preview and locked cards have the identical sealed projection');
        assert.equal(h.session.display.matching.source, 'speculative');
        assert.deepEqual(h.transports.map(transport => transport.matches.length), [0, 2], 'endpoint cannot add a final AI call');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: not-question final clears preview without changing locked answer or anchor',
    async run() {
      const h = await harness({ poolSize: 2 });
      try {
        await h.lock('priorities'); h.controller.startListening(h.event);
        const answer = h.session.display.answerCard; const anchor = h.session.anchorPlan;
        h.queue.push({ result: pick('leadership') }); h.partial('Tell me about leading');
        await new Promise(resolve => setImmediate(resolve)); assert.equal(h.session.display.preview.cardId, 'leadership');
        h.queue.push({ result: { kind: 'not-question', cardId: 'none', confidence: 0.99 } });
        await h.endpoint('Actually I was just describing our team.');
        assert.equal(h.session.display.preview, null); assert.equal(h.session.display.answerCard, answer);
        assert.equal(h.session.anchorPlan, anchor); assert.equal(h.session.locked, true);
        assert.equal(h.transports[0].matches.length, 1, 'different endpoint text must make a normal final call');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: Stop and close clear preview and reject late speculative results',
    async run() {
      for (const action of ['stop', 'close']) {
        const h = await harness({ poolSize: 3 });
        try {
          await h.lock('priorities'); h.controller.startListening(h.event);
          h.queue.push({ result: pick('leadership') }); h.partial('Tell me about leading'); await new Promise(resolve => setImmediate(resolve));
          const pending = deferred(); const started = deferred();
          h.queue.push({ pending, started }); h.partial('Tell me about leading teams'); await started.promise;
          assert.notEqual(h.session.display.preview, null);
          const answer = h.session.display.answerCard;
          if (action === 'stop') h.controller.stopListening(h.event); else h.session.child.close();
          assert.equal(h.session.display.preview, null);
          pending.resolve(pick('leadership')); await new Promise(resolve => setImmediate(resolve));
          assert.equal(h.session.display.preview, null); assert.equal(h.session.display.answerCard, answer);
          assert.equal(h.transports.every(transport => action === 'close' || transport.closes === 0), true, 'Stop detaches without killing warm sessions');
        } finally { h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: healthy AI follow-ups retain a saved-evidence rail without a prepared card',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('none') }); await h.endpoint('Tell me about leading a team.');
        const anchor = h.session.anchorPlan; const steps = h.session.display.plan.steps;
        assert(anchor); assert.equal(h.session.display.answerCard, null);
        // The first wording is deliberately outside the offline finite grammar.
        for (const question of ['What was the result of that?', 'What did you learn?']) {
          h.queue.push({ result: { kind: 'follow-up', cardId: 'none', confidence: 0.99 } });
          await h.endpoint(question);
          const request = h.transports[0].matches.at(-1);
          assert.equal(request.previousCardId, null); assert.equal(request.previousPlanLocked, true);
          assert(request.previousQuestion); assert.equal(h.session.anchorPlan, anchor); assert.equal(h.session.locked, true);
          assert.deepEqual(h.session.display.plan.steps, steps); assert.equal(h.session.display.answerCard, null);
          assert.equal(h.session.display.matching.kind, 'follow-up'); assert.equal(h.session.display.matching.source, 'ai');
          assert.equal(h.session.display.question, question);
        }
        assert.equal(h.transports.length, 1, 'valid follow-up/none cannot burn a cold fallback or reset the session');
        assert.equal(h.transports[0].matches.length, 3);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: audio follow-up preserves the locked bank while a new question adopts the queued bank',
    async run() {
      for (const changedId of [false, true]) {
        const h = await harness();
        try {
          h.controller.startListening(h.event);
          h.queue.push({ result: pick('leadership') }); await h.endpoint(SEMANTIC_QUESTION);
          const oldBank = h.session.answerBank; const oldCard = h.session.display.answerCard;
          const nextBank = structuredClone(h.fixture.bank);
          const nextCard = nextBank.cards.find(card => card.id === 'leadership');
          if (changedId) nextCard.id = 'leadership-new';
          h.setBank(nextBank); await h.launchQuestion(null);
          const pendingParent = h.session.pendingParent;
          assert(pendingParent);
          h.controller.startListening(h.event);
          h.queue.push({ result: pick('leadership', true) });
          await h.endpoint('Thanks. On that same situation, what would you change next time?');
          assert.equal(h.session.answerBank, oldBank); assert.equal(h.session.pendingParent, pendingParent);
          assert.equal(h.session.display.answerCard.id, oldCard.id); assert.equal(h.session.display.answerCard.headline, oldCard.headline);
          assert.equal(h.transports.at(-1).matches.at(-1).previousCardQuestion, oldCard.question);
          h.queue.push({ result: pick(nextCard.id) }); await h.endpoint('Great. Tell me about a new project.');
          assert.equal(h.session.pendingParent, null); assert.equal(h.session.answerBank, nextBank);
          assert.equal(h.session.display.answerCard.id, nextCard.id); assert.equal(h.session.display.answerCard.headline, nextCard.headline.text);
        } finally { h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: prefixed approximate follow-up continues an evidence-only locked plan',
    async run() {
      const h = await harness();
      try {
        h.setBank(null);
        await h.launchQuestion('Tell me about leading a team.');
        assert.equal(h.session.display.answerCard, null); assert.equal(h.session.display.plan.status, 'supported');
        const anchor = h.session.anchorPlan;
        assert(anchor);
        h.controller.startListening(h.event);
        await h.endpoint('Thanks. What did you learn?');
        assert.equal(h.session.anchorPlan, anchor); assert.equal(h.session.locked, true);
        assert.equal(h.session.display.plan.status, 'supported'); assert.equal(h.session.display.question, 'What did you learn?');
        assert.match(h.session.display.matching.label, /Approximate/u);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: an ignored audio turn resumes the audio question it pre-empted',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        const first = deferred(); const firstStarted = deferred();
        h.queue.push({ pending: first, started: firstStarted });
        const question = 'Tell me about leading a team.';
        const lookup = h.endpoint(question); await firstStarted.promise;
        h.queue.push({ result: { kind: 'not-question', cardId: 'none', confidence: 0.99 } });
        h.queue.push({ result: pick('leadership') });
        const filler = h.endpoint("Great. So a bit about the team: we're about twelve engineers.");
        first.resolve(pick('leadership'));
        await Promise.all([lookup, filler]);
        assert.equal(h.session.display.question, question, 'the pre-empted question is answered, not lost');
        assert.equal(h.session.display.answerCard?.id, 'leadership');
        assert.equal(h.transports[0].matches.length, 3);
        assert.equal(h.session.questionOrigin, null);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: a resume never suppresses a newer live turn, and walks back through a chain of ignored turns',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        const a = deferred(); const aStarted = deferred(); const b = deferred(); const bStarted = deferred();
        const question = 'Tell me about leading a team.';
        h.queue.push({ pending: a, started: aStarted });
        const lookupA = h.endpoint(question); await aStarted.promise;
        h.queue.push({ pending: b, started: bStarted });
        const lookupB = h.endpoint("Great. So a bit about the team: we're about twelve engineers.");
        a.resolve(pick('leadership')); await bStarted.promise;
        h.queue.push({ result: { kind: 'not-question', cardId: 'none', confidence: 0.99 } });
        h.queue.push({ result: { kind: 'not-question', cardId: 'none', confidence: 0.99 } });
        h.queue.push({ result: pick('leadership') });
        const lookupC = h.endpoint('Right, okay, and so the team works across three time zones.');
        h.session.audioTurnId = 99; // a newer live turn started while C was matched
        b.resolve({ kind: 'not-question', cardId: 'none', confidence: 0.99 });
        await Promise.all([lookupA, lookupB, lookupC]);
        assert.equal(h.session.display.question, question, 'two ignored turns still resume the original question');
        assert.equal(h.session.display.answerCard?.id, 'leadership');
        assert.notEqual(h.session.suppressedAudioTurn, 99, 'the resume does not suppress the newer live turn');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: audio not-question keeps the exact locked display and exposes the transcript notice',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('leadership') }); await h.endpoint('Tell me about leading a team.');
        const before = h.session.display; const anchor = h.session.anchorPlan; const updateCount = h.updates().length;
        const pending = deferred(); const started = deferred();
        const question = "Great. So a bit about the team: we're about twelve engineers.";
        h.queue.push({ pending, started });
        const lookup = h.endpoint(question); await started.promise;
        assert.equal(h.session.display, before); assert.equal(h.updates().length, updateCount, 'classification never flashes an empty card');
        h.failPlan(true);
        pending.resolve({ kind: 'not-question', cardId: 'none', confidence: 0.99 }); await lookup;
        assert.equal(h.session.display, before); assert.equal(h.session.anchorPlan, anchor); assert.equal(h.session.locked, true);
        assert.equal(h.updates().length, updateCount, 'a non-question never projects or publishes a replacement');
        assert.equal(h.transports[0].matches.at(-1).question, question);
        assert.match(h.listeningState().message, /^Not matched · Use to match$/u);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: pure audio fillers spend no matcher call while natural short questions replace once',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('leadership') }); await h.endpoint('Tell me about leading a team.');
        const before = h.session.display; const updateCount = h.updates().length;
        for (const filler of ['Okay.', 'Alright, cool. Nice!', 'Got it. I see. Makes sense.', 'Mm-hm.', "That's helpful. Thanks for that. Next one."]) await h.endpoint(filler);
        assert.equal(h.transports[0].matches.length, 1); assert.equal(h.session.display, before); assert.equal(h.updates().length, updateCount);
        h.queue.push({ result: pick('priorities') }); await h.endpoint('I see, that makes sense. Why Discord?');
        assert.equal(h.transports[0].matches.length, 2); assert.equal(h.transports[0].matches.at(-1).question, 'I see, that makes sense. Why Discord?');
        assert.equal(h.session.display.answerCard.id, 'priorities'); assert.equal(h.updates().length, updateCount + 1);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: AI classifies an unfamiliar audio follow-up against the locked card in one call',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('leadership') }); await h.endpoint(SEMANTIC_QUESTION);
        const updateCount = h.updates().length;
        const question = 'Great, thanks for that. On that same situation, which takeaway changed your next attempt?';
        assert.equal(isDependentInterviewFollowUp(question), false);
        h.queue.push({ result: pick('leadership', true) }); await h.endpoint(question);
        const request = h.transports[0].matches.at(-1);
        assert.equal(request.question, question); assert.equal(request.previousCardId, 'leadership');
        assert.equal(request.previousCardQuestion, h.fixture.bank.cards.find(card => card.id === 'leadership').question);
        assert.equal(request.previousQuestion, SEMANTIC_QUESTION); assert.equal(h.transports[0].matches.length, 2);
        assert.equal(h.session.display.answerCard.id, 'leadership'); assert.equal(h.session.display.matching.kind, 'follow-up');
        assert.equal(h.session.locked, true); assert.equal(h.updates().length, updateCount + 1);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: a real unmatched audio question uses the existing honest display',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('leadership') }); await h.endpoint(SEMANTIC_QUESTION);
        h.queue.push({ result: pick('none') }); await h.endpoint("Thanks. Next one. What's your biggest weakness?");
        assert.equal(h.session.display.answerCard, null); assert.equal(h.session.display.matching.kind, 'question');
        assert.equal(h.session.display.matching.source, 'ai'); assert.equal(h.session.display.question, "Thanks. Next one. What's your biggest weakness?");
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: unavailable audio AI invokes the strict detector and labels accepted fallback Approximate',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('leadership') }); await h.endpoint(SEMANTIC_QUESTION);
        const before = h.session.display; const updateCount = h.updates().length;
        await h.endpoint("Great. So a bit about the team: we're about twelve engineers.");
        assert.equal(h.session.display, before); assert.equal(h.updates().length, updateCount);
        await h.endpoint('Cool. Nice. So how do you prioritize your work?');
        assert.equal(h.session.display.answerCard?.id, 'priorities'); assert.equal(h.session.display.matching.source, 'approximate');
        assert.match(h.session.display.matching.label, /Approximate/u); assert.equal(h.updates().length, updateCount + 1);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: semantic paraphrases and exact prepared questions invoke AI before displaying the selected card',
    async run() {
      const h = await harness();
      try {
        assert.equal(matchInterviewAnswerCard(SEMANTIC_QUESTION, h.fixture.bank), null, 'the synthetic paraphrase cannot pass the lexical fallback');
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('leadership') });
        await h.endpoint(SEMANTIC_QUESTION); const first = h.session.display;
        assert.equal(first.answerCard.id, 'leadership'); assert.equal(first.matching.source, 'ai'); assert.equal(first.matching.approximate, false);
        assert.equal(h.transports[0].matches[0].question, SEMANTIC_QUESTION);
        const preparedQuestion = h.fixture.bank.cards.find(card => card.id === 'priorities').question;
        h.queue.push({ result: pick('priorities') });
        await h.endpoint(preparedQuestion); const typed = h.session.display;
        assert.equal(typed.answerCard.id, 'priorities'); assert.equal(h.transports[0].matches.length, 2, 'an exact prepared question still uses semantic AI selection');
        assert.equal(h.updates().at(-1).value, h.session.display, 'main and renderer receive the same committed answer');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: the opening display lists every prepared card ID and question',
    async run() {
      const h = await harness();
      try {
        const cards = h.fixture.bank.cards;
        assert.deepEqual(h.session.display.briefing.preparedCards, cards.map(({ id, question }) => ({ id, question })));
        assert.deepEqual(h.session.display.briefing.preparedQuestions, cards.map(card => card.question), 'the existing string projection remains compatible');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: an AI none never selects a deterministic prepared card',
    async run() {
      const h = await harness();
      try {
        const question = 'Tell me about leading a team.';
        assert.equal(matchInterviewAnswerCard(question, h.fixture.bank)?.id, 'leadership');
        h.controller.startListening(h.event); h.queue.push({ result: pick('none') });
        await h.endpoint(question); const display = h.session.display;
        assert.equal(display.answerCard, null, 'AI abstention cannot silently become a lexical spoken answer');
        assert.equal(display.matching.source, 'ai');
        if (display.plan?.status === 'supported') {
          assert.equal(display.matching.approximate, true); assert.match(display.matching.label, /Approximate/u, 'saved evidence relevance stays visibly approximate');
        }
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: prepared-card follow-ups retain semantic context without requiring an exact-cue plan anchor',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event); h.queue.push({ result: pick('leadership') });
        await h.endpoint(SEMANTIC_QUESTION);
        assert.equal(h.session.anchorPlan, null, 'semantic selection does not manufacture an exact career rail');
        h.queue.push({ result: pick('leadership', true) });
        await h.endpoint('What did you learn?'); const display = h.session.display;
        const request = h.transports[0].matches.at(-1);
        assert.equal(request.previousCardId, 'leadership'); assert.equal(request.previousQuestion, SEMANTIC_QUESTION);
        assert.equal(display.answerCard.id, 'leadership'); assert.equal(display.matching.kind, 'follow-up');
        assert.equal(h.session.locked, true); assert.equal(h.updates().at(-1).value, h.session.display);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: opening warms context once, a later question reuses it, changed banks reset it and close releases it',
    async run() {
      const h = await harness();
      try {
        await Promise.resolve();
        assert.equal(h.transports.length, 1); assert.equal(h.transports[0].starts.length, 1, 'window open starts the warm transport before a question');
        const initial = h.transports[0].starts[0];
        assert.equal(initial.cards.length, h.fixture.bank.cards.length); assert.equal(initial.extensions.leadership.length, 2, 'both separately prepared optional points are sent during initialization');
        for (const points of Object.values(initial.extensions)) for (const point of points) {
          assert.deepEqual(Object.keys(point).sort(), ['exampleHook', 'id', 'text'], 'warm extension context contains compact approved points and hooks, without raw source quotes or evidence bindings');
        }
        h.controller.startListening(h.event); h.queue.push({ result: pick('leadership') }); await h.endpoint(SEMANTIC_QUESTION);
        const projected = h.session.display.answerCard;
        assert.equal(projected.optionalExtension.length, 2);
        for (const point of projected.optionalExtension) {
          assert(point.exampleHook && point.evidenceIds.every(id => projected.evidence.some(source => source.id === id)), 'each optional point exposes its tiny example hook and additional exact evidence');
        }
        assert.equal(h.transports.length, 1); assert.equal(h.transports[0].starts.length, 1); assert.equal(h.transports[0].closes, 0);
        const revised = structuredClone(h.fixture.bank);
        revised.cards.find(card => card.id === 'leadership').id = 'leadership-revised';
        h.setBank(revised); await h.launchQuestion(null); h.queue.push({ result: pick('leadership-revised') });
        await h.endpoint(SEMANTIC_QUESTION); const display = h.session.display;
        assert.equal(display.answerCard.id, 'leadership-revised'); assert.equal(h.transports.length, 2);
        assert.equal(h.transports[0].closes, 1); assert.equal(h.transports[1].starts.length, 1);
        h.session.child.close(); assert.equal(h.transports[1].closes, 1); assert.equal(h.controller.sessionCount(), 0);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: parent-provided plans select through AI once on both new and reused unlocked children',
    async run() {
      const question = 'Tell me about leading a team.';
      const fresh = await harness({ launchQuestion: question, initialResponses: [{ result: pick('priorities') }] });
      try {
        const canonicalQuestion = buildInterviewPlan({ question, profile: fresh.fixture.snapshot, snapshotId: fresh.fixture.snapshot.snapshotId }).analysis.transcript;
        assert.equal(matchInterviewAnswerCard(question, fresh.fixture.bank)?.id, 'leadership');
        assert.equal(fresh.transports[0].matches.length, 1); assert.equal(fresh.transports[0].matches[0].question, canonicalQuestion);
        assert.equal(fresh.session.display.answerCard.id, 'priorities', 'new-child parent plans use the AI result rather than the lexical prepared card');
        assert.equal(fresh.session.display.matching.source, 'ai');
      } finally { fresh.cleanup(); }
      const reused = await harness();
      try {
        assert.equal(reused.session.locked, false); reused.queue.push({ result: pick('priorities') });
        const result = await reused.launchQuestion(question);
        assert.equal(result.reused, true); assert.equal(reused.transports[0].matches.length, 1);
        assert.equal(reused.session.display.answerCard.id, 'priorities', 'reused-unlocked parent plans use the AI result rather than the lexical prepared card');
        assert(reused.updates().every(update => update.value.answerCard?.id !== 'leadership'), 'no intermediate notification flashes the lexical prepared card');
      } finally { reused.cleanup(); }
    },
  },
  {
    name: 'interview AI window: the measured p50 of detected questions picks the automatic layout',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        h.queue.push({ result: pick('leadership'), latencyMs: 3000 });
        await h.endpoint(SEMANTIC_QUESTION); const slow = h.session.display;
        assert.equal(slow.matching.p50Ms, 3000); assert.equal(slow.matching.mode, 'auto'); assert.equal(slow.matching.effectiveMode, 'continuation');
        h.queue.push({ result: pick('priorities'), latencyMs: 100 });
        await h.endpoint('How do you prioritize your work?'); const quick = h.session.display;
        assert.equal(quick.matching.p50Ms, 1550); assert.equal(quick.matching.effectiveMode, 'recall', 'automatic layout follows measured median, using the same prepared data');
      } finally { h.cleanup(); }
    }
  },
  {
    name: 'interview AI window: call-audio projection failure atomically retains the visible old card and its main-process lock',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event); h.queue.push({ result: pick('leadership') }); await h.endpoint('Tell me about leading a team.');
        const before = h.session.display; const anchor = h.session.anchorPlan; const updateCount = h.updates().length;
        h.failPlan(true); h.queue.push({ result: pick('priorities') });
        await assert.rejects(() => h.endpoint('How do you prioritize your work?'), /Synthetic projection failure/u);
        assert.equal(h.session.display, before); assert.equal(h.session.locked, true); assert.equal(h.session.anchorPlan, anchor);
        assert.equal(h.updates().length, updateCount); assert.equal(h.updates().at(-1).value, h.session.display, 'a failed automatic advance cannot clear main while renderer retains the old answer');
        h.failPlan(false); h.queue.push({ result: pick('priorities') }); await h.endpoint('How do you prioritize your work?');
        assert.equal(h.session.display.answerCard.id, 'priorities'); assert.equal(h.updates().length, updateCount + 1, 'a successful retry commits exactly one complete update');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: a newer audio question cancels the pending turn and receives fresh semantic AI selection before the late reply',
    async run() {
      const h = await harness();
      const pending = deferred(); let timer;
      try {
        h.controller.startListening(h.event); h.queue.push({ result: pick('leadership') }); await h.endpoint('Tell me about leading a team.');
        const updateCount = h.updates().length; const started = deferred();
        h.queue.push({ pending, started });
        const older = h.endpoint('Walk me through a technical problem.');
        await started.promise;
        const question = 'Describe an instance of allocating scarce attention when several worthwhile requests arrived together.';
        assert.equal(matchInterviewAnswerCard(question, h.fixture.bank), null, 'the new audio question deliberately cannot use a lexical prepared card');
        h.queue.push({ result: pick('priorities') });
        await Promise.race([h.endpoint(question), new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('The newer audio question waited for a superseded AI reply.')), 1000);
        })]);
        clearTimeout(timer);
        const newest = h.session.display;
        assert.equal(newest.answerCard?.id, 'priorities'); assert.equal(newest.matching.source, 'ai'); assert.equal(newest.matching.approximate, false);
        assert.equal(h.transports.length, 1, 'cancelling a caller retains its healthy warm conversation');
        assert.equal(h.transports[0].closes, 0); assert.equal(h.transports[0].starts.length, 1); assert.equal(h.transports[0].matches.length, 3);
        assert.equal(h.transports[0].matches.at(-1).question, question); assert.equal(h.updates().length, updateCount + 1);
        pending.resolve(pick('technical')); await older; await Promise.resolve(); await Promise.resolve();
        assert.equal(h.session.display, newest); assert.equal(h.updates().length, updateCount + 1, 'the retired reply cannot overwrite the newer card or emit an extra update');
        assert.equal(h.updates().at(-1).value, newest); assert.equal(h.session.locked, true);
      } finally { clearTimeout(timer); pending.resolve(pick('technical')); h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: an audio question superseded while AI is pending cannot clear or replace the old main/renderer display',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event); h.queue.push({ result: pick('leadership') }); await h.endpoint('Tell me about leading a team.');
        const before = h.session.display; const anchor = h.session.anchorPlan; const updateCount = h.updates().length;
        const pending = deferred(); const started = deferred(); let current = true;
        h.queue.push({ pending, started });
        const lookup = h.endpoint('How do you prioritize your work?', () => current);
        await started.promise;
        assert.equal(h.session.display, before); assert.equal(h.session.locked, true, 'old card remains locked while automatic replacement is pending');
        current = false; pending.resolve(pick('priorities')); await lookup;
        assert.equal(h.session.display, before); assert.equal(h.session.locked, true); assert.equal(h.session.anchorPlan, anchor);
        assert.equal(h.updates().length, updateCount); assert.equal(h.updates().at(-1).value, h.session.display);
        await h.endpoint('How do you prioritize your work?', () => false);
        assert.equal(h.transports[0].matches.length, 2, 'an already retired endpoint does not call AI');
      } finally { h.cleanup(); }
    },
  },
];
