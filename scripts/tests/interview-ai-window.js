import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInterviewWindowController } from '../../electron/interviewWindow.js';
import { createInterviewAiMatcher } from '../../electron/interviewAiMatcher.js';
import { buildInterviewPlan, isDependentInterviewFollowUp } from '../../src/utils/interviewHelper.js';
import { matchInterviewAnswerCard } from '../../src/utils/interviewAnswerMatching.js';
import { getCurrentIpcRequestContext } from '../../electron/ipc/ipcUtils.js';
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
async function harness({ launchQuestion = null, initialResponses = [], bridge = false, requestAi, poolSize = 1 } = {}) {
  const fixture = createInterviewWindowE2EFixture();
  const owner = new Window(); const handlers = new Map(); const transports = []; const queue = [...initialResponses];
  let time = 0; let bank = fixture.bank; let failPlan = false; let audioInput; let active = false; let transcript = ''; let endpointId = 0;
  const controller = createInterviewWindowController({ BrowserWindow: Window,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    appInstance: { isPackaged: false, getPath: () => '/tmp/synthetic-interview-ai-unused' },
    isAuthorizedOwner: candidate => candidate === owner,
    loadSnapshot: async () => fixture.snapshot, loadBundle: async () => fixture.bundle,
    loadPreparedBrief: async () => fixture.brief, loadAnswerBank: async () => bank,
    buildPlan: options => { if (failPlan) throw new Error('Synthetic projection failure.'); return buildInterviewPlan(options); },
    createMatcher: options => createInterviewAiMatcher({ ...options, config: { ...options.config, poolSize }, now: () => time }),
    matcherConfig: bridge ? { transport: 'chatgpt-bridge' } : { transport: 'claude-warm', timeoutMs: 5000 },
    requestAi,
    matcherTransportFactory: bridge ? undefined : () => {
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
      const state = { status: 'idle', transcript: '', question: '', errorCode: null, message: '' };
      return { start() { active = true; state.status = 'listening'; input.onState(state); return state; },
        stop() { active = false; state.status = 'idle'; input.onState(state); return state; },
        getState: () => state, getQuestion: () => transcript, notice: message => { state.message = message; } };
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
  return { fixture, owner, controller, session, event, handlers, transports, queue, updates,
    setBank: value => { bank = value; }, failPlan: value => { failPlan = value; },
    launchQuestion: question => controller.launch({ sender: owner.webContents }, argsFor(question)),
    endpoint: (text, isCurrent = () => active, id = ++endpointId) => { transcript = text; return audioInput.onQuestion({ text, id }, isCurrent); },
    partial: (text, turnId = endpointId + 1) => { transcript = text; return audioInput.onPartial({ text, turnId }); },
    setTranscript: text => { transcript = text; },
    cleanup: () => controller.cleanupOwner(owner) };
}

export default [
  {
    name: 'interview AI window: identical in-flight audio selection locks without another transport call and clears preview immediately',
    async run() {
      for (const withPreview of [false, true]) {
        const h = await harness({ poolSize: 2 }); const pending = deferred(); const started = deferred();
        try {
          await h.controller.selectPreparedCard(h.event, 'priorities'); h.controller.startListening(h.event);
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
    name: 'interview AI window: a typed question wins while an identical speculative endpoint is awaiting its reply',
    async run() {
      const h = await harness({ poolSize: 2 }); const pending = deferred(); const started = deferred();
      try {
        await h.controller.selectPreparedCard(h.event, 'leadership'); h.controller.startListening(h.event);
        h.queue.push({ pending, started }); h.partial('Tell me about leading teams'); await started.promise;
        const lookup = h.endpoint('Tell me about leading teams.');
        assert.equal(h.session.questionOrigin, 'audio');
        h.queue.push({ result: pick('priorities') });
        const display = await h.controller.submitQuestion(h.event, 'How do you prioritize work?');
        assert.equal(display.answerCard.id, 'priorities'); assert.equal(display.question, 'How do you prioritize work?');
        assert.equal(display.matching.source, 'ai'); assert.equal(h.session.display, display);
        const updateCount = h.updates().length;
        pending.resolve(pick('leadership')); await lookup;
        assert.equal(h.session.display, display, 'late speculative selection cannot replace the explicit answer');
        assert.equal(h.updates().length, updateCount); assert.equal(h.session.locked, true);
        assert.deepEqual(h.transports.map(transport => transport.matches.length), [1, 1], 'only the speculative call and deliberate typed call are sent');
      } finally { pending.resolve(pick('leadership')); h.cleanup(); }
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
        await h.controller.selectPreparedCard(h.event, 'priorities');
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
        await h.controller.selectPreparedCard(h.event, 'priorities'); h.controller.startListening(h.event);
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
          await h.controller.selectPreparedCard(h.event, 'priorities'); h.controller.startListening(h.event);
          h.queue.push({ result: pick('leadership') }); h.partial('Tell me about leading'); await new Promise(resolve => setImmediate(resolve));
          const pending = deferred(); const started = deferred();
          h.queue.push({ pending, started }); h.partial('Tell me about leading teams'); await started.promise;
          assert.notEqual(h.session.display.preview, null);
          const answer = h.session.display.answerCard;
          if (action === 'stop') h.controller.stopListening(h.event); else h.controller.close(h.event);
          assert.equal(h.session.display.preview, null);
          pending.resolve(pick('leadership')); await new Promise(resolve => setImmediate(resolve));
          assert.equal(h.session.display.preview, null); assert.equal(h.session.display.answerCard, answer);
          assert.equal(h.transports.every(transport => action === 'close' || transport.closes === 0), true, 'Stop detaches without killing warm sessions');
        } finally { h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: explicit typed, follow-up, transcript and prepared choices outrank speculation',
    async run() {
      for (const action of ['typed', 'follow-up', 'transcript', 'prepared']) {
        const h = await harness({ poolSize: 2 });
        try {
          await h.controller.selectPreparedCard(h.event, 'priorities'); h.controller.startListening(h.event);
          h.queue.push({ result: pick('leadership') }); h.partial('Tell me about leading'); await new Promise(resolve => setImmediate(resolve));
          const pending = deferred(); const started = deferred();
          h.queue.push({ pending, started }); h.partial('Tell me about leading teams'); await started.promise;
          if (action !== 'prepared') h.queue.push({ result: pick('priorities', action === 'follow-up') });
          const display = action === 'typed' ? await h.controller.submitQuestion(h.event, 'How do you prioritize work?')
            : action === 'follow-up' ? await h.controller.followUpQuestion(h.event, 'What happened next?')
            : action === 'transcript' ? await h.controller.useTranscriptQuestion(h.event)
            : await h.controller.selectPreparedCard(h.event, 'priorities');
          assert.equal(display.preview, null); assert.equal(display.answerCard.id, 'priorities');
          pending.resolve(pick('leadership')); await new Promise(resolve => setImmediate(resolve));
          h.partial('Tell me about leading teams every day'); await new Promise(resolve => setImmediate(resolve));
          assert.equal(h.session.display, display, 'late or continued speculative text cannot overwrite explicit choices');
          assert.equal(h.transports[1].closes, 0);
          assert.equal(h.transports[0].matches.length, action === 'prepared' ? 0 : 1);
        } finally { h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: explicit typed questions override not-question and replace the prior answer honestly',
    async run() {
      const h = await harness();
      try {
        await h.controller.selectPreparedCard(h.event, 'priorities');
        const before = h.session.display;
        const question = 'Tell me about leading a team.';
        h.queue.push({ result: { kind: 'not-question', cardId: 'none', confidence: 0.99 } });
        const display = await h.controller.submitQuestion(h.event, question);
        assert.notEqual(display, before); assert.equal(display.question, question);
        assert.equal(display.answerCard, null, 'an explicit override cannot manufacture or select an unapproved spoken answer');
        assert.equal(display.plan.status, 'supported'); assert.equal(display.matching.kind, 'question');
        assert.equal(h.session.audio, null, 'the explicit result is visible even without a Listen notice');
        h.queue.push({ result: { kind: 'not-question', cardId: 'none', confidence: 0.99 } });
        const unsupported = await h.controller.submitQuestion(h.event, 'Which telescope aperture photographs Jupiter best?');
        assert.equal(unsupported.plan.status, 'unsupported'); assert.equal(unsupported.answerCard, null);
        assert(unsupported.plan.message, 'a genuine lack of saved evidence produces a visible explanation');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: typed follow-ups override not-question and low-confidence classification',
    async run() {
      for (const result of [{ kind: 'not-question', cardId: 'none', confidence: 0.99 }, { ...pick('leadership', true), confidence: 0.1 }]) {
        const h = await harness();
        try {
          await h.controller.selectPreparedCard(h.event, 'leadership');
          h.queue.push({ result });
          const display = await h.controller.followUpQuestion(h.event, 'What did you learn?');
          assert.equal(display.question, 'What did you learn?'); assert.equal(display.answerCard.id, 'leadership');
          assert.equal(display.matching.kind, 'follow-up'); assert.equal(h.session.locked, true);
          assert.equal(h.updates().at(-1).value, display);
        } finally { h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: Use this question breaks the not-question notice loop and displays the requested text',
    async run() {
      const h = await harness();
      try {
        h.controller.startListening(h.event);
        const question = "Alright, thanks for that. Can you walk me through a project you're really proud of?";
        const declined = { kind: 'not-question', cardId: 'none', confidence: 0.99 };
        h.queue.push({ result: declined }); await h.endpoint(question);
        const before = h.session.display;
        assert.match(h.controller.getListeningState(h.event).message, /^Not matched · Use to match$/u);
        h.queue.push({ result: declined });
        const display = await h.handlers.get('interview-window:use-transcript-question')(h.event);
        assert.notEqual(display, before); assert.equal(display.question, question);
        assert.equal(display.matching.kind, 'question'); assert.equal(display.answerCard, null);
        assert(display.plan?.message, 'saved cues or a visible unsupported explanation must resolve the explicit choice');
        assert.equal(h.updates().at(-1).value, display); assert.equal(h.transports[0].matches.length, 2);
      } finally { h.cleanup(); }
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
    name: 'interview AI window: audio never cancels typed questions, follow-ups or Use this question requests',
    async run() {
      for (const action of ['typed', 'follow-up', 'transcript']) {
        const h = await harness(); const pending = deferred(); const started = deferred();
        try {
          h.controller.startListening(h.event);
          if (action === 'follow-up') await h.controller.selectPreparedCard(h.event, 'leadership');
          const question = action === 'follow-up' ? 'What did you learn?' : SEMANTIC_QUESTION;
          h.setTranscript(question); h.queue.push({ pending, started });
          const request = action === 'typed' ? h.controller.submitQuestion(h.event, question)
            : action === 'follow-up' ? h.controller.followUpQuestion(h.event, question)
            : h.controller.useTranscriptQuestion(h.event);
          await started.promise;
          const signal = h.transports[0].matches.at(-1).signal; const sequence = h.session.questionSequence;
          // Both a semantic non-question and a new real question remain only
          // transcripts until the deliberate user request has completed.
          await h.endpoint("Great. So a bit about the team: we're about twelve engineers.");
          await h.endpoint('How do you prioritize your work?');
          assert.equal(signal.aborted, false, action); assert.equal(h.session.questionSequence, sequence);
          assert.equal(h.transports[0].matches.length, 1, 'background audio cannot even queue a competing selection');
          h.controller.stopListening(h.event);
          assert.equal(signal.aborted, false, 'Stop listening cannot cancel a user text lookup');
          pending.resolve(pick('leadership', action === 'follow-up'));
          const display = await request;
          assert.equal(display.ignored, undefined); assert.equal(display.question, question); assert.equal(display.answerCard.id, 'leadership');
          assert.equal(h.session.display, display); assert.equal(h.session.questionOrigin, null);
        } finally { pending.resolve(pick('leadership')); h.cleanup(); }
      }
    },
  },
  {
    name: 'interview AI window: superseded user submissions return an explicit ignored result',
    async run() {
      const h = await harness(); const pending = deferred(); const started = deferred();
      try {
        h.queue.push({ pending, started });
        const request = h.controller.submitQuestion(h.event, SEMANTIC_QUESTION); await started.promise;
        h.controller.nextQuestion(h.event);
        const result = await request;
        assert.deepEqual(Object.keys(result).sort(), ['ignored', 'message', 'reason']);
        assert.equal(result.ignored, true); assert.equal(result.reason, 'superseded'); assert(result.message);
        assert.notEqual(result, h.session.display, 'the renderer cannot mistake cancellation for a successful old display');
        pending.resolve(pick('leadership')); await Promise.resolve();
        assert.equal(h.session.display.answerCard, null);
      } finally { pending.resolve(pick('leadership')); h.cleanup(); }
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
        await h.controller.submitQuestion(h.event, 'Tell me about leading a team.');
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
        assert.match(h.controller.getListeningState(h.event).message, /^Not matched · Use to match$/u);
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
    name: 'interview AI window: semantic paraphrases and exact typed questions invoke AI before displaying the selected card',
    async run() {
      const h = await harness();
      try {
        assert.equal(matchInterviewAnswerCard(SEMANTIC_QUESTION, h.fixture.bank), null, 'the synthetic paraphrase cannot pass the lexical fallback');
        h.queue.push({ result: pick('leadership') });
        const first = await h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
        assert.equal(first.answerCard.id, 'leadership'); assert.equal(first.matching.source, 'ai'); assert.equal(first.matching.approximate, false);
        assert.equal(h.transports[0].matches[0].question, SEMANTIC_QUESTION);
        h.controller.nextQuestion(h.event);
        const preparedQuestion = h.fixture.bank.cards.find(card => card.id === 'priorities').question;
        h.queue.push({ result: pick('priorities') });
        const typed = await h.handlers.get('interview-window:submit-question')(h.event, preparedQuestion);
        assert.equal(typed.answerCard.id, 'priorities'); assert.equal(h.transports[0].matches.length, 2, 'an exact typed question still uses semantic AI selection');
        assert.equal(h.updates().at(-1).value, h.session.display, 'main and renderer receive the same committed answer');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: explicit choices expose every card ID and open the selected prepared answer without AI',
    async run() {
      const h = await harness();
      try {
        const cards = h.fixture.bank.cards;
        assert.deepEqual(h.session.display.briefing.preparedCards, cards.map(({ id, question }) => ({ id, question })));
        assert.deepEqual(h.session.display.briefing.preparedQuestions, cards.map(card => card.question), 'the existing string projection remains compatible');
        const select = h.handlers.get('interview-window:select-prepared-card');
        for (const card of cards) {
          const display = await select(h.event, card.id);
          assert.equal(display.answerCard.id, card.id); assert.equal(display.question, card.question);
          assert.equal(display.answerCard.headline, card.headline.text);
          assert.equal(display.matching.method, 'manual'); assert.equal(display.matching.source, 'manual');
          assert.equal(display.matching.label, 'Prepared answer selected'); assert.equal(display.matching.approximate, false);
          assert.equal(h.session.locked, true); assert.equal(h.session.anchorPlan, null);
          assert.equal(h.updates().at(-1).value, display);
        }
        assert.equal(h.transports.flatMap(item => item.matches).length, 0, 'manual selection makes no AI calls, including when no provider result exists');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: explicit card choice immediately supersedes a pending AI turn and fences its late reply',
    async run() {
      const h = await harness();
      const pending = deferred(); const started = deferred(); let timer;
      try {
        h.queue.push({ pending, started });
        const older = h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
        await started.promise;
        const display = await Promise.race([h.controller.selectPreparedCard(h.event, 'priorities'), new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Explicit card selection waited for AI.')), 1000);
        })]);
        clearTimeout(timer);
        assert.equal(display.answerCard.id, 'priorities'); assert.equal(display.matching.method, 'manual');
        assert.equal(h.transports.flatMap(item => item.matches).length, 1, 'the card click cannot start another matching call');
        const updateCount = h.updates().length;
        pending.resolve(pick('leadership')); await older; await Promise.resolve(); await Promise.resolve();
        assert.equal(h.session.display, display); assert.equal(h.updates().length, updateCount, 'the late semantic selection cannot overwrite the explicit choice');
      } finally { clearTimeout(timer); pending.resolve(pick('leadership')); h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: manual card choice replaces supported evidence and unsupported responses in one update',
    async run() {
      const h = await harness();
      try {
        for (const [question, status] of [['How did you reduce Kafka consumer lag?', 'supported'], ['What telescope aperture would you choose for photographing Jupiter?', 'unsupported']]) {
          h.controller.nextQuestion(h.event); h.queue.push({ result: pick('none') });
          const before = await h.controller.submitQuestion(h.event, question);
          assert.equal(before.answerCard, null); assert.equal(before.plan.status, status);
          const updateCount = h.updates().length;
          const selected = await h.controller.selectPreparedCard(h.event, 'leadership');
          assert.equal(selected.answerCard.id, 'leadership'); assert.equal(selected.plan, null);
          assert.equal(h.updates().length, updateCount + 1, 'replacement publishes a single complete card without an intervening empty response');
        }
        assert.equal(h.transports.flatMap(item => item.matches).length, 2, 'only the original free-text questions invoke AI');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: direct card IPC rejects foreign frames, invalid IDs and stale banks while retaining the prior answer',
    async run() {
      const h = await harness();
      try {
        await h.controller.selectPreparedCard(h.event, 'leadership');
        const before = h.session.display; const updateCount = h.updates().length;
        const select = h.handlers.get('interview-window:select-prepared-card');
        for (const event of [{ sender: h.owner.webContents }, { sender: h.event.sender, senderFrame: {} }, { sender: { id: h.event.sender.id }, senderFrame: h.event.sender.mainFrame }]) {
          await assert.rejects(() => select(event, 'priorities'), /prepared answer is unavailable/u);
        }
        for (const cardId of [null, { cardId: 'priorities' }, '', 'x'.repeat(65), '../priorities', 'unsaved-card']) {
          await assert.rejects(() => select(h.event, cardId), /prepared answer is unavailable/u);
        }
        for (const bank of [null, { ...h.fixture.bank, inputs: { ...h.fixture.bank.inputs, careerSnapshotId: 'b'.repeat(64) } }]) {
          h.setBank(bank);
          await assert.rejects(() => select(h.event, 'priorities'), /prepared answer is unavailable/u);
        }
        assert.equal(h.session.display, before); assert.equal(h.session.locked, true); assert.equal(h.updates().length, updateCount);
        assert.equal(h.transports.flatMap(item => item.matches).length, 0, 'rejected direct choices cannot fall through to AI');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: an explicit AI none never selects a deterministic prepared card',
    async run() {
      const h = await harness();
      try {
        const question = 'Tell me about leading a team.';
        assert.equal(matchInterviewAnswerCard(question, h.fixture.bank)?.id, 'leadership');
        h.queue.push({ result: pick('none') });
        const display = await h.controller.submitQuestion(h.event, question);
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
        h.queue.push({ result: pick('leadership') });
        await h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
        assert.equal(h.session.anchorPlan, null, 'semantic selection does not manufacture an exact career rail');
        h.queue.push({ result: pick('leadership', true) });
        const display = await h.controller.followUpQuestion(h.event, 'What did you learn?');
        const request = h.transports[0].matches.at(-1);
        assert.equal(request.previousCardId, 'leadership'); assert.equal(request.previousQuestion, SEMANTIC_QUESTION);
        assert.equal(display.answerCard.id, 'leadership'); assert.equal(display.matching.kind, 'follow-up');
        assert.equal(h.session.locked, true); assert.equal(h.updates().at(-1).value, h.session.display);
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: opening warms context once, Next reuses it, changed banks reset it and close releases it',
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
        h.queue.push({ result: pick('leadership') }); await h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
        const projected = h.session.display.answerCard;
        assert.equal(projected.optionalExtension.length, 2);
        for (const point of projected.optionalExtension) {
          assert(point.exampleHook && point.evidenceIds.every(id => projected.evidence.some(source => source.id === id)), 'each optional point exposes its tiny example hook and additional exact evidence');
        }
        h.controller.nextQuestion(h.event);
        assert.equal(h.transports.length, 1); assert.equal(h.transports[0].starts.length, 1); assert.equal(h.transports[0].closes, 0);
        const revised = structuredClone(h.fixture.bank);
        revised.cards.find(card => card.id === 'leadership').id = 'leadership-revised';
        h.setBank(revised); h.queue.push({ result: pick('leadership-revised') });
        const display = await h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
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
    name: 'interview AI window: explicit paraphrased follow-ups reach AI with previous prepared-card context beyond the deterministic grammar',
    async run() {
      const h = await harness();
      try {
        h.queue.push({ result: pick('leadership') }); await h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
        const question = 'On that same situation, which takeaway changed your next attempt?';
        assert.equal(isDependentInterviewFollowUp(question), false, 'the test wording deliberately falls outside the old dependent-follow-up grammar');
        h.queue.push({ result: pick('leadership', true) });
        const display = await h.controller.followUpQuestion(h.event, question);
        const request = h.transports[0].matches.at(-1);
        assert.equal(request.question, question); assert.equal(request.previousCardId, 'leadership'); assert.equal(request.previousQuestion, SEMANTIC_QUESTION);
        assert.equal(display.answerCard.id, 'leadership'); assert.equal(display.matching.kind, 'follow-up');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: default ChatGPT bridge matching is a bounded compact task owned by the canvas IPC context',
    async run() {
      const calls = [];
      const h = await harness({ bridge: true, requestAi: async options => {
        await Promise.resolve(); calls.push({ options, context: getCurrentIpcRequestContext() }); return pick('leadership');
      } });
      try {
        assert.equal(calls.length, 0, 'warming the selected bridge stages context without a paid selection call');
        const display = await h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
        assert.equal(display.answerCard.id, 'leadership'); assert.equal(display.matching.source, 'ai'); assert.equal(calls.length, 1);
        const { options, context } = calls[0];
        assert.equal(context.sender, h.owner.webContents); assert.equal(context.nodeId, 'ai_window_test'); assert.equal(context.channel, 'interview-window:submit-question');
        assert.equal(options.task, 'interview-live-match'); assert.equal(options.requestKind, 'structured-text'); assert.equal(options.grounding, false);
        assert.equal(options.maxOutputTokens, 80); assert.equal(options.signal.aborted, false); assert.deepEqual(JSON.parse(options.prompt), { question: SEMANTIC_QUESTION });
        assert.deepEqual(options.responseSchema.required, ['kind', 'cardId', 'confidence']);
        assert.match(options.cachedPrefix, /Cards \(id,question,headline\)/u); assert.doesNotMatch(options.cachedPrefix, /"quotes"|"evidenceIds"/u);
        assert.equal(getCurrentIpcRequestContext(), null, 'the owner context does not leak outside the matching request');
        assert.equal(h.transports.length, 0, 'the bridge uses no CLI process adapter');
      } finally { h.cleanup(); }
    },
  },
  {
    name: 'interview AI window: measured p50 switches layouts automatically and only the real child main frame can override it',
    async run() {
      const h = await harness();
      try {
        h.queue.push({ result: pick('leadership'), latencyMs: 3000 });
        const slow = await h.controller.submitQuestion(h.event, SEMANTIC_QUESTION);
        assert.equal(slow.matching.p50Ms, 3000); assert.equal(slow.matching.mode, 'auto'); assert.equal(slow.matching.effectiveMode, 'continuation');
        const mode = h.handlers.get('interview-window:set-latency-mode');
        assert.equal(mode(h.event, 'recall').matching.effectiveMode, 'recall', 'manual recall overrides measured latency');
        assert.throws(() => mode(h.event, 'continuation'), /display mode is invalid/u, 'Keep going can only follow measured latency');
        assert.equal(mode(h.event, 'auto').matching.effectiveMode, 'continuation');
        for (const event of [{ sender: h.owner.webContents }, { sender: h.event.sender, senderFrame: {} }, { sender: { id: h.event.sender.id }, senderFrame: h.event.sender.mainFrame }]) {
          assert.throws(() => mode(event, 'recall'), /display mode is invalid/u);
        }
        assert.throws(() => mode(h.event, 'arbitrary'), /display mode is invalid/u);
        h.controller.nextQuestion(h.event); h.queue.push({ result: pick('priorities'), latencyMs: 100 });
        const quick = await h.controller.submitQuestion(h.event, 'How do you prioritize your work?');
        assert.equal(quick.matching.p50Ms, 1550); assert.equal(quick.matching.effectiveMode, 'recall', 'automatic layout follows measured median, using the same prepared data');
      } finally { h.cleanup(); }
    },
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
