import path from 'node:path';
import assert from 'node:assert/strict';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

const CARDS = Array.from({ length: 24 }, (_, index) => ({ id: `card-${index}`, question: index < 2 ? 'A shared question?' : `Prepared question ${index}?` }));
const CARD = { ...CARDS[0], headline: 'I revised the team guide.', headlineEvidenceIds: ['guide'],
  bullets: [{ text: 'I checked the guide with the team.', stage: 'action', evidenceIds: ['guide'] }],
  example: { text: 'The team used a checklist.', evidenceIds: ['guide'] },
  evidence: [{ id: 'guide', sourceLabel: 'Saved project', quote: 'I checked the guide with the team using a checklist.' }], optionalExtension: [] };
const EMPTY = { version: 1, question: '', answerCard: null, plan: null,
  briefing: { role: { title: 'Engineer' }, preparedCards: CARDS, preparedQuestions: CARDS.map(card => card.question) } };
const selected = id => ({ ...EMPTY, question: CARDS.find(card => card.id === id).question,
  answerCard: { ...CARD, ...CARDS.find(card => card.id === id), headline: `Prepared answer ${id}` },
  matching: { method: 'manual', approximate: false } });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function enterText(window, textarea, value) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
  textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}
async function mounted(overrides, run) {
  await withDom(async window => {
    const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
    let update;
    window.interviewAPI = { getBrief: async () => EMPTY, onBriefUpdated: callback => { update = callback; return () => undefined; },
      close: async () => true, setAlwaysOnTop: async () => true, ...overrides };
    const root = bundle.module.createRoot(window.document.getElementById('root'));
    const act = async fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
    try {
      await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)));
      await run({ window, act, update: value => update(value) });
    } finally { await act(() => root.unmount()); await bundle.dispose(); }
  });
}

export default [
  {
    name: 'interview prepared picker: all initial buttons select IDs directly even for identical question text',
    async run() {
      const calls = [];
      await mounted({ selectPreparedCard: async id => { calls.push(id); return selected(id); },
        submitQuestion: async () => { throw new Error('Explicit card choice must bypass AI.'); },
        nextQuestion: async () => { throw new Error('Explicit card choice must replace directly.'); } }, async ({ window, act }) => {
        const buttons = window.document.querySelectorAll('[aria-label="Prepared questions"] button');
        assert.equal(buttons.length, CARDS.length);
        assert.equal(buttons[0].textContent, buttons[1].textContent);
        await act(() => buttons[1].click());
        assert.deepEqual(calls, [CARDS[1].id]);
        assert.equal(window.document.querySelector('.answer-headline-text').textContent, 'Prepared answer card-1');
        assert.equal(window.document.querySelector('.interview-ready').textContent, 'Prepared answer selected');
      });
    },
  },
  {
    name: 'interview prepared picker: every response offers all cards in one tap and retains typed override',
    async run() {
      const calls = [];
      await mounted({ selectPreparedCard: async id => { calls.push(id); return selected(id); } }, async ({ window, act, update }) => {
        for (const response of [selected('card-0'),
          { ...EMPTY, plan: { status: 'supported', question: 'Different topic?', steps: [{ id: 'cue', label: 'Saved cue', cue: 'Exact saved text.' }] } },
          { ...EMPTY, plan: { status: 'unsupported', question: 'Unknown topic?', message: 'No saved evidence.', steps: [] } }]) {
          await act(() => update(response));
          const picker = window.document.querySelector('[aria-label="Other prepared answers"]');
          assert(picker && picker.tagName === 'SECTION');
          const buttons = picker.querySelectorAll('button');
          assert.equal(buttons.length, CARDS.length);
          assert(window.document.querySelector('[aria-label="Type a different question"] textarea'));
          await act(() => buttons[23].click());
          assert.equal(calls.at(-1), 'card-23');
          assert.equal(window.document.querySelector('.answer-headline-text').textContent, 'Prepared answer card-23');
          assert.equal(window.document.querySelectorAll('.prepared-answer-picker button[aria-pressed="true"]').length, 1);
        }
        assert.equal(calls.length, 3);
      });
    },
  },
  {
    name: 'interview prepared picker: explicit choice supersedes pending AI and fences its late result',
    async run() {
      const pending = deferred(); const calls = [];
      await mounted({ submitQuestion: question => { calls.push(question); return pending.promise; },
        selectPreparedCard: async id => selected(id) }, async ({ window, act }) => {
        await act(() => enterText(window, window.document.querySelector('#interview-question'), 'A paraphrased question?'));
        await act(() => window.document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
        assert.equal(calls.length, 1);
        assert(window.document.querySelector('#interview-question').disabled);
        const choice = window.document.querySelectorAll('[aria-label="Prepared questions"] button')[23];
        assert.equal(choice.disabled, false);
        await act(() => choice.click());
        assert.equal(window.document.querySelector('.answer-headline-text').textContent, 'Prepared answer card-23');
        await act(() => pending.resolve(selected('card-0')));
        assert.equal(window.document.querySelector('.answer-headline-text').textContent, 'Prepared answer card-23');
        assert.equal(window.document.querySelector('#interview-manual-question').disabled, false);
      });
    },
  },
  {
    name: 'interview prepared picker: a typed replacement still uses semantic matching after direct correction',
    async run() {
      const calls = [];
      await mounted({ getBrief: async () => selected('card-1'), nextQuestion: async () => { calls.push('next'); return EMPTY; },
        submitQuestion: async question => { calls.push(question); return { ...selected('card-2'), question }; } }, async ({ window, act }) => {
        const textarea = window.document.querySelector('#interview-manual-question');
        await act(() => enterText(window, textarea, 'A new interviewer question?'));
        await act(() => textarea.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
        assert.deepEqual(calls, ['A new interviewer question?']);
        assert.equal(window.document.querySelector('.locked-question-preview').textContent, 'A new interviewer question?');
        assert.equal(window.document.querySelector('#interview-manual-question').value, '');
      });
    },
  },
];
