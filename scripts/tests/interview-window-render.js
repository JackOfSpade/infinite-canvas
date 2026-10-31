import fs from 'node:fs';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

const DISPLAY = {
  version: 1, snapshotId: 'a'.repeat(64),
  plan: { status: 'supported', question: 'How did you improve onboarding conversion and retention?', currentStep: 0, message: 'Use saved details.', missingComponents: ['lesson'], steps: [
    { id: 'one', label: 'RELEVANT EXPERIENCE', cue: 'Improved onboarding conversion.', roleAttribution: 'Product Manager · Acme' },
    { id: 'two', label: 'RELATED EXPERIENCE', cue: 'Reviewed retention weekly.', roleAttribution: 'Product Manager · Acme' },
  ] },
  briefing: { role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Own onboarding.' }, roleThemes: ['Product strategy'], companyFacts: ['B2B SaaS'], recentContext: ['Launch'], likelyQuestions: ['How do you measure?'], questionsToAsk: ['What is success?'], applicationPositioning: ['Conversion experience'], warnings: ['Verify fresh facts'], sources: [{ sourceUrl: `https://research.example.test/${'long-reference-path/'.repeat(16)}`, sourceDate: '2026-10-08' }] },
};

const ANSWER_CARD = {
  id: 'answer-onboarding', question: 'Tell me about onboarding.',
  headline: 'I improved onboarding with a simpler setup flow.',
  headlineEvidenceIds: ['career-one'],
  bullets: [{ text: 'I reviewed the setup flow.', stage: 'situation', evidenceIds: ['career-one'] }, { text: 'I simplified the setup flow.', stage: 'action', evidenceIds: ['career-one'] }, { text: 'Onboarding conversion improved.', stage: 'result', evidenceIds: ['career-two'] }],
  example: { text: 'I reviewed retention weekly.', evidenceIds: ['career-two'] },
  consistency: { consistentWithResume: true, resumeQuote: 'Improved onboarding conversion with a simpler setup flow.' },
  evidence: [{ id: 'career-one', quote: 'Improved onboarding conversion with a simpler setup flow.', sourceLabel: 'Saved achievement · Product Manager · Acme' }, { id: 'career-two', quote: 'Reviewed retention weekly.', sourceLabel: 'Saved project · Product Manager · Acme' }],
};

async function flush() { await Promise.resolve(); await Promise.resolve(); }

function button(window, label) { return [...window.document.querySelectorAll('button')].find(item => item.textContent === label); }
function setQuestion(window, textarea, value) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
  textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}
function press(window, target, key, options = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

export default [
  ...[
    ['initial question', 'interview-question', false],
    ['locked-card replacement', 'interview-manual-question', true],
    ['follow-up', 'interview-follow-up', true],
  ].map(([scenario, inputId, locked]) => ({
    name: `interview window ignored ${scenario}: keeps the draft, form and locked answer with inline feedback`,
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const shown = { ...DISPLAY, plan: null, answerCard: locked ? ANSWER_CARD : null, question: locked ? ANSWER_CARD.question : '' };
        const message = 'No saved evidence can answer this request. Add a project or choose a prepared question.';
        const calls = []; let nextCalls = 0;
        window.interviewAPI = { getBrief: async () => shown, onBriefUpdated: () => () => undefined, close: async () => true,
          submitQuestion: async value => { calls.push(value); return { ignored: true, reason: 'unsupported', message }; },
          followUpQuestion: async value => { calls.push(value); return { ignored: true, reason: 'unsupported', message }; },
          nextQuestion: async () => { nextCalls += 1; return { ...shown, answerCard: null }; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const act = async fn => bundle.module.act(async () => { await fn(); await flush(); });
        try {
          await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)));
          const answer = window.document.querySelector('.spoken-answer');
          if (inputId === 'interview-follow-up') await act(() => button(window, 'Follow-up').click());
          const input = window.document.getElementById(inputId);
          await act(() => setQuestion(window, input, 'my Kubernetes migration'));
          for (let attempt = 0; attempt < 2; attempt += 1) {
            await act(() => input.closest('form').querySelector('button[type="submit"]').click());
            assert(input.isConnected && input.value === 'my Kubernetes migration' && !input.disabled, `${scenario}: an ignored reply must preserve an open, enabled draft`);
            assert(input.closest('form').querySelector('[role="alert"]')?.textContent === message, `${scenario}: the ignored reason must appear inside the submitted form even without listening`);
            assert(window.document.activeElement === input, `${scenario}: repeated ignored replies must return focus to the preserved draft`);
            assert(window.document.querySelector('.spoken-answer') === answer, `${scenario}: an ignored reply must leave the current answer untouched`);
          }
          assert(calls.length === 2 && calls.every(value => value === 'my Kubernetes migration'), `${scenario}: explicit text must be sent unchanged on each attempt`);
          assert(nextCalls === 0, 'replacing a card must submit atomically, without clearing the current answer first');
        } finally { await act(() => root.unmount()); await bundle.dispose(); }
      });
    },
  })),
  ...['brief update', 'Use this question'].map(route => ({
    name: `interview window follow-up draft: ${route} changing the story requires reopening before sending`,
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const first = { ...DISPLAY, plan: null, question: ANSWER_CARD.question, answerCard: ANSWER_CARD };
        const second = { ...first, question: 'Tell me about your migration.', answerCard: { ...ANSWER_CARD, id: 'answer-migration', question: 'Tell me about your migration.', headline: 'I checked the migration.' } };
        let update; const calls = [];
        window.interviewAPI = { getBrief: async () => first, onBriefUpdated: callback => { update = callback; return () => undefined; }, close: async () => true,
          getListeningState: async () => ({ status: 'listening', transcript: second.question, question: second.question }), onListeningUpdated: () => () => undefined,
          useTranscriptQuestion: async () => second,
          followUpQuestion: async value => { calls.push({ value, question: window.document.querySelector('.locked-question-preview').textContent }); return second; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const act = async fn => bundle.module.act(async () => { await fn(); await flush(); });
        try {
          await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)));
          await act(() => button(window, 'Follow-up').click());
          const input = window.document.querySelector('#interview-follow-up');
          await act(() => setQuestion(window, input, 'What did you learn from the first example?'));
          await act(() => update({ ...first, matching: { effectiveMode: 'continuation' } }));
          assert(window.document.querySelector('#interview-follow-up') === input && input.value.includes('first example'), 'a layout-only update must preserve the current follow-up form');
          await act(() => route === 'brief update' ? update(second) : button(window, 'Use this question').click());
          assert(!window.document.querySelector('#interview-follow-up') && calls.length === 0, 'a different card must close the stale form before it can attach to the new story');
          assert(window.document.body.textContent.includes('Your follow-up draft is saved'), 'changing the story must explain that the draft was saved and needs review');
          assert(window.document.activeElement === window.document.querySelector('.spoken-answer h2'), 'the new answer must receive focus after the stale form closes');
          // Unsupported responses and later cards must not resurrect a hidden form.
          await act(() => update({ ...second, answerCard: null, plan: { status: 'unsupported', question: 'An unsupported topic?', steps: [], message: 'No saved evidence.' } }));
          await act(() => update(second));
          assert(!window.document.querySelector('#interview-follow-up'), 'later cards must keep the stale draft closed until explicitly reopened');
          await act(() => button(window, 'Follow-up').click());
          const reviewed = window.document.querySelector('#interview-follow-up');
          assert(reviewed.value === 'What did you learn from the first example?' && window.document.activeElement === reviewed, 'explicitly reopening must restore the saved text for review against the current card');
          await act(() => press(window, reviewed, 'Enter'));
          assert(calls.length === 1 && calls[0].question === second.question && calls[0].value === reviewed.value, 'only the explicit reopened submission may attach the preserved text to the new answer');
        } finally { await act(() => root.unmount()); await bundle.dispose(); }
      });
    },
  })),
  {
    name: 'interview window transcript action: a mouse-selected question preserves an unfocused typed draft',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const initial = { ...DISPLAY, plan: null, answerCard: null };
        window.interviewAPI = { getBrief: async () => initial, onBriefUpdated: () => () => undefined,
          getListeningState: async () => ({ status: 'listening', transcript: ANSWER_CARD.question, question: ANSWER_CARD.question }), onListeningUpdated: () => () => undefined,
          useTranscriptQuestion: async () => ({ ...initial, question: ANSWER_CARD.question, answerCard: ANSWER_CARD }), close: async () => true, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const act = async fn => bundle.module.act(async () => { await fn(); await flush(); });
        try {
          await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)));
          await act(() => setQuestion(window, window.document.querySelector('#interview-question'), 'My unfinished typed question'));
          const use = button(window, 'Use this question');
          use.focus(); // Browser mouse clicks focus the button before invoking it.
          await act(() => use.click());
          assert(window.document.querySelector('#interview-manual-question')?.value === 'My unfinished typed question', 'explicit transcript selection must carry an unfocused draft into the replacement form');
        } finally { await act(() => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window prepared answers: thin evidence warning stays compact while exact candor notes stay in sources',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const sourceQuote = 'Maintained the ticketing system (not originally built by me). Tech used: Python.';
        const thinCard = { ...ANSWER_CARD, thinEvidence: true,
          evidence: [{ ...ANSWER_CARD.evidence[0], quote: sourceQuote }, ANSWER_CARD.evidence[1]] };
        let update;
        window.interviewAPI = { getBrief: async () => ({ ...DISPLAY, plan: null, answerCard: thinCard }), onBriefUpdated: callback => { update = callback; return () => undefined; }, close: async () => true, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const card = window.document.querySelector('.spoken-answer');
          const warning = card.querySelector('.answer-thin-evidence');
          assert(warning?.textContent === 'Thin evidence' && warning.getAttribute('role') === 'status', 'a narrowed card must disclose thin evidence with a small status warning');
          assert(card.querySelector('.answer-headline-text').textContent === ANSWER_CARD.headline && card.querySelectorAll('.spoken-bullets li').length === 3, 'the warning must leave the headline and bullets available at a glance');
          const evidence = card.querySelector('.answer-evidence');
          assert(!evidence.open && evidence.querySelector('blockquote').textContent === sourceQuote, 'the collapsed evidence toggle must preserve the exact source, including candor and technology notes');
          assert(!card.querySelector('h2').textContent.includes('Tech used:') && !card.querySelector('.spoken-bullets').textContent.includes('not originally built'), 'source notes must not appear in the speaking surface');
          await bundle.module.act(async () => { update({ ...DISPLAY, plan: null, answerCard: { ...thinCard, thinEvidence: false } }); await flush(); });
          assert(!window.document.querySelector('.answer-thin-evidence'), 'a fully supported card must not retain a previous thin-evidence warning');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window prepared answers: numbered statement citations open and focus their exact source quote',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        window.interviewAPI = { getBrief: async () => ({ ...DISPLAY, plan: null, answerCard: ANSWER_CARD }), onBriefUpdated: () => () => undefined, close: async () => true, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const card = window.document.querySelector('.spoken-answer');
          const bullets = card.querySelectorAll('.spoken-bullets li');
          assert(card.querySelector('h2 .answer-citation-ref').textContent === '[1]' && bullets[0].querySelector('.answer-citation-ref').textContent === '[1]' && bullets[2].querySelector('.answer-citation-ref').textContent === '[2]', 'headline and separate bullets must map their evidence IDs to the correct source numbers');
          assert(card.querySelector('.spoken-example .answer-citation-ref').textContent === '[2]', 'concrete example must retain its own citation mapping');
          const evidence = card.querySelector('.answer-evidence');
          const sources = evidence.querySelectorAll('li');
          assert(!evidence.open && sources[0].dataset.citationNumber === '1' && sources[0].querySelector('blockquote').textContent === ANSWER_CARD.evidence[0].quote && sources[1].querySelector('blockquote').textContent === ANSWER_CARD.evidence[1].quote, 'numbered evidence list must preserve the exact corresponding quotes');
          const reference = bullets[2].querySelector('.answer-citation-ref');
          assert(reference.getAttribute('aria-label') === 'Show exact cited evidence 2' && reference.tagName === 'BUTTON', 'statement citations must be natively keyboard-operable controls with a clear accessible name');
          await bundle.module.act(async () => { reference.click(); await flush(); });
          assert(evidence.open && window.document.activeElement === sources[1], 'opening a statement citation must expand evidence and focus the exact source, rather than making the user hunt through all cues');
          await bundle.module.act(async () => { card.querySelector('h2 .answer-citation-ref').click(); await flush(); });
          assert(window.document.activeElement === sources[0], 'a second citation must move focus to its own source while keeping evidence open');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window prepared answers: card leads, exact evidence stays expandable, copy and keyboard focus work without an evidence plan',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const preparedQuestions = Array.from({ length: 20 }, (_, index) => `Prepared question ${index + 1}?`);
        const preparedCards = preparedQuestions.map((question, index) => ({ id: `prepared-${index}`, question }));
        const unplanned = { ...DISPLAY, plan: null, answerCard: null, briefing: { ...DISPLAY.briefing, preparedQuestions, preparedCards } };
        const answered = { ...unplanned, answerCard: ANSWER_CARD };
        const calls = []; let copied; let nextCalls = 0;
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        window.interviewAPI = { getBrief: async () => unplanned, onBriefUpdated: () => () => undefined, close: async () => true,
          selectPreparedCard: async cardId => { calls.push(cardId); return answered; }, submitQuestion: async () => { throw new Error('Prepared buttons must bypass AI matching.'); }, nextQuestion: async () => { nextCalls += 1; return unplanned; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const prepared = window.document.querySelector('[aria-label="Prepared questions"]');
          assert(prepared.querySelectorAll('button').length === 20, 'every prepared card must have an accessible direct question button');
          await bundle.module.act(async () => { prepared.querySelectorAll('button')[19].click(); await flush(); });
          assert(calls.join() === preparedCards[19].id, 'prepared button must pass its exact card ID through the direct API');
          const card = window.document.querySelector('[aria-label="Prepared spoken answer"]');
          assert(card?.querySelector('.answer-headline-text')?.textContent === ANSWER_CARD.headline && card.querySelectorAll('.spoken-bullets li').length === 3, 'spoken headline and bullets must appear immediately, without an evidence-plan dependency');
          assert(window.document.activeElement === card.querySelector('h2'), 'matched card headline must receive focus');
          assert(!window.document.querySelector('[aria-label="Current saved cue"]') && !button(window, 'Previous') && button(window, 'Follow-up'), 'a card without a rail must keep AI follow-up available while omitting unusable cue controls');
          const evidence = card.querySelector('.answer-evidence');
          assert(!evidence.open && evidence.textContent.includes(ANSWER_CARD.evidence[0].quote) && evidence.textContent.includes(ANSWER_CARD.evidence[0].sourceLabel), 'exact cited text and attribution must be available behind a collapsed evidence toggle');
          evidence.querySelector('summary').click();
          assert(evidence.open && card.querySelector('.answer-consistency').textContent.includes(ANSWER_CARD.consistency.resumeQuote), 'source toggle must open and résumé consistency must cite the submitted wording');
          await bundle.module.act(async () => { button(window, 'Copy answer').click(); await flush(); });
          assert(copied.includes(ANSWER_CARD.headline) && copied.includes(ANSWER_CARD.bullets[1].text) && copied.includes(ANSWER_CARD.example.text) && copied.includes(ANSWER_CARD.evidence[0].quote), 'copy must include the spoken answer, example and cited exact evidence');
          assert(window.document.body.textContent.includes('Copied prepared answer and cited evidence.'), 'copy result must be announced');
          await bundle.module.act(async () => { press(window, window.document.body, 'Enter', { ctrlKey: true }); await flush(); });
          assert(nextCalls === 1 && window.document.activeElement === window.document.querySelector('textarea'), 'next-question shortcut must unlock a card-only display and focus question entry');
          const css = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
          assert(css.includes('.spoken-answer h2') && css.includes('font-size: 24px') && css.includes('.spoken-bullets') && css.includes('font-size: 18px'), 'headline and spoken bullets must use glanceable type sizes');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window prepared answers: a matched card precedes raw cues and a later fallback preserves honesty labels',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let update;
        window.interviewAPI = { getBrief: async () => ({ ...DISPLAY, answerCard: ANSWER_CARD }), onBriefUpdated: callback => { update = callback; return () => undefined; }, close: async () => true, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const card = window.document.querySelector('.spoken-answer');
          const rail = window.document.querySelector('.all-cues');
          assert(card.compareDocumentPosition(rail) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'spoken answer must precede the collapsed raw-cue rail');
          assert(!window.document.querySelector('.evidence-card') && !window.document.querySelector('.interview-plan-note'), 'the raw retrieval cue and its message must not compete with the prepared answer');
          await bundle.module.act(async () => { update({ ...DISPLAY, answerCard: null, briefing: { ...DISPLAY.briefing, preparedQuestions: [ANSWER_CARD.question] } }); await flush(); });
          assert(!window.document.querySelector('.spoken-answer') && window.document.querySelector('.evidence-card')?.textContent.includes(DISPLAY.plan.steps[0].cue), 'an unmatched question must return to the exact saved cue view');
          assert(window.document.querySelector('h1').textContent === 'Saved career evidence' && window.document.querySelector('.interview-plan-note.glance-chip')?.textContent === 'No prepared answer · saved cues' && window.document.querySelector('.interview-plan-note').getAttribute('title') === 'No confident prepared answer match. Showing exact saved career cues only.', 'a prepared-session fallback must visibly identify itself as exact evidence rather than a spoken answer');
          assert(window.document.body.textContent.includes('Saved evidence does not document: lesson learned. Do not fill that gap from this rail.'), 'fallback must retain the missing-evidence honesty warning');
          assert(window.document.activeElement === window.document.querySelector('.evidence-card h2'), 'fallback result must receive keyboard focus');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window live UX: Enter submits once, respects composition and newlines, and returns focus after next-question shortcut',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unplanned = { ...DISPLAY, plan: null };
        const calls = []; let resolveQuestion; let nextCalls = 0;
        window.interviewAPI = { getBrief: async () => unplanned, onBriefUpdated: () => () => undefined, close: async () => true,
          submitQuestion: question => { calls.push(question); return new Promise(resolve => { resolveQuestion = resolve; }); },
          nextQuestion: async () => { nextCalls += 1; return unplanned; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const input = window.document.querySelector('textarea');
          assert(window.document.activeElement === input, 'opening the unplanned live view must focus question entry');
          assert(window.document.body.textContent.includes('AI selects your prepared answer'), 'readiness must explain that AI maps questions to the prepared answers');
          await bundle.module.act(async () => { setQuestion(window, input, 'Tell me about onboarding'); await flush(); });
          assert(!press(window, input, 'Enter', { shiftKey: true }), 'Shift+Enter must retain normal multiline input');
          assert(!press(window, input, 'Enter', { isComposing: true }), 'IME composition Enter must never submit');
          assert(!press(window, input, 'Enter', { repeat: true }), 'auto-repeated Enter must not submit');
          assert(!press(window, input, 'ArrowDown'), 'typing retains normal caret navigation');
          await bundle.module.act(async () => { assert(press(window, input, 'Enter'), 'Enter must submit'); press(window, input, 'Enter'); await flush(); });
          assert(calls.length === 1 && calls[0] === 'Tell me about onboarding', `same-tick Enter presses must invoke exactly once with typed text, got ${JSON.stringify(calls)}`);
          assert(input.disabled && window.document.querySelector('form').getAttribute('aria-busy') === 'true' && button(window, 'Finding saved evidence…')?.disabled, 'pending lookup must visibly prevent duplicate interaction');
          await bundle.module.act(async () => { resolveQuestion(DISPLAY); await flush(); });
          assert(window.document.activeElement === window.document.querySelector('.evidence-card h2'), 'returned evidence must receive keyboard focus');
          const card = window.document.querySelector('.evidence-card');
          const rail = window.document.querySelector('.evidence-rail');
          assert(card.compareDocumentPosition(rail) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the readable current cue must precede the full rail');
          assert(!rail.closest('details').open && rail.closest('details').querySelector('summary').textContent === 'All saved cues (2)', 'the duplicate full rail must start collapsed to keep controls and reference reachable in a compact window');
          const gapWarning = [...window.document.querySelectorAll('[role="status"]')].find(item => item.textContent.includes('does not document:'));
          assert(gapWarning.compareDocumentPosition(card) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'grounding gaps must appear before the current cue so they are seen before speaking');
          await bundle.module.act(async () => { assert(press(window, window.document.body, 'Enter', { ctrlKey: true }), 'Ctrl+Enter must advance from a supported question'); await flush(); });
          assert(nextCalls === 1 && window.document.activeElement === window.document.querySelector('textarea'), 'next-question shortcut must await main and focus the new field');
          assert(window.document.querySelector('textarea').value === '', 'next question clears the old question');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window live UX: likely questions submit canonical text and edit preserves supported or unsupported questions',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let update; const calls = []; let nextCalls = 0;
        const unplanned = { ...DISPLAY, plan: null };
        window.interviewAPI = { getBrief: async () => unplanned, onBriefUpdated: callback => { update = callback; return () => undefined; }, close: async () => true,
          submitQuestion: async question => { calls.push(question); return DISPLAY; }, nextQuestion: async () => { nextCalls += 1; return unplanned; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const prepared = window.document.querySelector('[aria-label="Likely questions"]');
          await bundle.module.act(async () => { prepared.querySelector('button').click(); await flush(); });
          assert(calls.join() === DISPLAY.briefing.likelyQuestions[0], 'likely questions without prepared cards must send the suggested question without rewriting it');
          await bundle.module.act(async () => { button(window, 'Edit question').click(); await flush(); });
          assert(nextCalls === 1 && window.document.querySelector('textarea').value === DISPLAY.plan.question, 'editing must explicitly unlock through main and preserve the supported question for typo correction');
          const unsupported = { ...DISPLAY, plan: { status: 'unsupported', question: 'retenton?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } };
          await bundle.module.act(async () => { update(unsupported); await flush(); });
          assert(window.document.body.textContent.includes('retenton?'), 'unsupported state must retain the rejected question visibly');
          // Live glanceability: one short chip is visible; the long explanation is collapsed behind "Why?".
          const noAnswer = window.document.querySelector('.interview-no-answer');
          assert(noAnswer.querySelector('.glance-chip').textContent === 'No prepared answer · answer freely', 'unsupported state must lead with a short glanceable chip');
          const why = noAnswer.querySelector('details.glance-why');
          assert(why && !why.open && why.textContent.includes('No saved evidence matches.'), 'the long explanation must stay available but collapsed');
          assert(noAnswer.querySelector('.question-actions button'), 'actions stay visible outside the collapsed explanation');
          await bundle.module.act(async () => { button(window, 'Edit question').click(); await flush(); });
          assert(nextCalls === 2 && window.document.querySelector('textarea').value === 'retenton?' && window.document.activeElement === window.document.querySelector('textarea'), 'unsupported typo correction must preserve and focus the entered text');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window live UX: copy retains source attribution and missing-evidence warnings, and reports unavailable clipboard',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let copied = '';
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        window.interviewAPI = { getBrief: async () => DISPLAY, onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          await bundle.module.act(async () => { button(window, 'Copy cues').click(); await flush(); });
          assert(copied.includes(DISPLAY.plan.question) && copied.includes(DISPLAY.plan.steps[0].cue) && copied.includes(DISPLAY.plan.steps[1].cue) && copied.includes('Product Manager · Acme'), 'copy must preserve all saved cues and their attribution');
          assert(copied.includes('does not document: lesson learned') && copied.includes('Do not fill that gap'), 'copy must retain the grounding gap warning');
          assert(window.document.body.textContent.includes('Copied saved cues.'), 'successful copy must be acknowledged');
          window.navigator.clipboard.writeText = async () => { throw new Error('private clipboard failure'); };
          await bundle.module.act(async () => { button(window, 'Copy cues').click(); await flush(); });
          assert(window.document.body.textContent.includes('Select the saved cues and press ⌘/Ctrl+C.') && !window.document.body.textContent.includes('private clipboard failure'), 'clipboard refusal must show a fast path-free manual action');
          const css = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
          assert(css.includes(':focus-visible') && css.includes('position: sticky') && css.includes('.evidence-card p { font-size: 17px'), 'compact reading must keep visible keyboard focus, readable active cue, and reachable controls while scrolling');
          assert(!window.document.querySelector('main').hasAttribute('aria-live'), 'reference content must not all be announced again when a cue changes');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window live UX: follow-up is explicit, keeps the current rail, maps fixed errors and submits only once',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const followUps = []; let rejectFollowUp; let resolveFollowUp;
        window.interviewAPI = { getBrief: async () => DISPLAY, onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => { throw new Error('wrong route'); },
          followUpQuestion: value => { followUps.push(value); return new Promise((resolve, reject) => { resolveFollowUp = resolve; rejectFollowUp = reject; }); }, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          await bundle.module.act(async () => { button(window, 'Follow-up').click(); await flush(); });
          const input = window.document.querySelector('#interview-follow-up');
          assert(window.document.activeElement === input && window.document.querySelector('.evidence-rail'), 'follow-up entry must focus without clearing the saved example');
          await bundle.module.act(async () => { setQuestion(window, input, 'What did you learn?'); await flush(); });
          await bundle.module.act(async () => { press(window, input, 'Enter'); press(window, input, 'Enter'); await flush(); });
          assert(followUps.length === 1 && followUps[0] === 'What did you learn?' && input.disabled, 'follow-up Enter must invoke the dedicated context-preserving API once');
          await bundle.module.act(async () => { rejectFollowUp(new Error('Interview follow-up is invalid.')); await flush(); });
          assert(window.document.querySelector('.evidence-rail') && window.document.querySelector('[role="alert"]')?.textContent.includes('choose Next question for a new topic'), 'rejected follow-up must retain evidence and explain how to change topics');
          assert(window.document.querySelector('#interview-follow-up').value === 'What did you learn?', 'rejected follow-up must preserve the text for retry');
          assert(!input.disabled && window.document.activeElement === input, 'rejected follow-up must restore focus after its disabled input has been re-enabled');
          await bundle.module.act(async () => { button(window, 'Find follow-up evidence').click(); await flush(); resolveFollowUp({ ...DISPLAY, plan: { ...DISPLAY.plan, question: 'Original example · What did you learn?' } }); await flush(); });
          assert(!window.document.querySelector('#interview-follow-up') && window.document.body.textContent.includes('Original example · What did you learn?'), 'successful follow-up must consume the returned grounded display and close the field');
          assert(window.document.activeElement === window.document.querySelector('.evidence-card h2'), 'successful follow-up must focus the cue rather than restore the old input');
          await bundle.module.act(async () => { button(window, 'Follow-up').click(); await flush(); button(window, 'Cancel follow-up').click(); await flush(); });
          assert(!window.document.querySelector('#interview-follow-up') && window.document.activeElement === window.document.querySelector('.evidence-card h2'), 'cancel follow-up must restore focus to the current cue');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  ...[
    { view: 'saved cues', display: DISPLAY, headingSelector: '.evidence-card h2' },
    { view: 'prepared answer card', display: { ...DISPLAY, answerCard: ANSWER_CARD }, headingSelector: '.spoken-answer h2' },
  ].flatMap(({ view, display, headingSelector }) => [
    {
      name: `interview window ${view}: rejected next question restores the follow-up field even on repeated immediate failures`,
      async run() {
        await withDom(async window => {
          const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
          let rejectNext;
          window.interviewAPI = { getBrief: async () => display, onBriefUpdated: () => () => undefined, close: async () => true,
            nextQuestion: () => new Promise((resolve, reject) => { rejectNext = reject; }), setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            const heading = window.document.querySelector(headingSelector);
            await bundle.module.act(async () => { button(window, 'Follow-up').click(); await flush(); });
            const input = window.document.querySelector('#interview-follow-up');
            await bundle.module.act(async () => { setQuestion(window, input, 'What did you learn?'); await flush(); });
            await bundle.module.act(async () => { button(window, 'Next question').click(); await flush(); });
            assert(input.disabled, 'advancing must disable the open follow-up field while pending');
            button(window, 'Close').focus();
            await bundle.module.act(async () => { rejectNext(new Error('advance failed')); await flush(); });
            assert(!input.disabled && window.document.activeElement === input, 'a rejected next question must refocus the follow-up after React re-enables it');
            assert(input.value === 'What did you learn?' && window.document.querySelector(headingSelector) === heading && window.document.querySelector('.evidence-rail'), 'a rejected advance must preserve the typed follow-up, answer, and saved rail');
            assert(window.document.querySelector('[role="alert"]')?.textContent.includes('could not advance'), 'the failed advance must remain actionable');
            window.interviewAPI.nextQuestion = async () => { throw new Error('advance failed'); };
            for (let attempt = 0; attempt < 2; attempt += 1) {
              button(window, 'Next question').focus();
              await bundle.module.act(async () => { button(window, 'Next question').click(); await flush(); });
              assert(!input.disabled && window.document.activeElement === input && input.value === 'What did you learn?', 'identical immediate advance failures must each restore the enabled follow-up field');
            }
          } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
        });
      },
    },
    {
      name: `interview window ${view}: cancelling a rejected follow-up clears its alert and restores answer focus`,
      async run() {
        await withDom(async window => {
          const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
          window.interviewAPI = { getBrief: async () => display, onBriefUpdated: () => () => undefined, close: async () => true,
            followUpQuestion: async () => { throw new Error('Interview follow-up is invalid.'); }, setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            const heading = window.document.querySelector(headingSelector);
            await bundle.module.act(async () => { button(window, 'Follow-up').click(); await flush(); });
            const input = window.document.querySelector('#interview-follow-up');
            await bundle.module.act(async () => { setQuestion(window, input, 'What did you learn?'); await flush(); });
            await bundle.module.act(async () => { press(window, input, 'Enter'); await flush(); });
            assert(window.document.querySelector('[role="alert"]') && window.document.activeElement === input, 'a rejected follow-up must show its error and remain editable');
            button(window, 'Cancel follow-up').focus();
            await bundle.module.act(async () => { button(window, 'Cancel follow-up').click(); await flush(); });
            assert(!window.document.querySelector('[role="alert"]'), 'cancelling must remove the stale follow-up error above the valid answer');
            assert(!window.document.querySelector('#interview-follow-up') && window.document.querySelector(headingSelector) === heading && window.document.activeElement === heading, 'cancelling must close the field and return focus to the preserved answer');
          } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
        });
      },
    },
    {
      name: `interview window ${view}: Cmd and Ctrl+Enter submit a focused typed follow-up and advance everywhere else`,
      async run() {
        await withDom(async window => {
          const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
          const followUps = []; let resolveFollowUp; let update; let nextCalls = 0;
          const unplanned = { ...display, plan: null, answerCard: null };
          window.interviewAPI = { getBrief: async () => display, onBriefUpdated: callback => { update = callback; return () => undefined; }, close: async () => true,
            followUpQuestion: value => { followUps.push(value); return new Promise(resolve => { resolveFollowUp = resolve; }); },
            nextQuestion: async () => { nextCalls += 1; return unplanned; }, setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            for (const modifier of ['metaKey', 'ctrlKey']) {
              await bundle.module.act(async () => { button(window, 'Follow-up').click(); await flush(); });
              const input = window.document.querySelector('#interview-follow-up');
              const value = `What did you learn? (${modifier})`;
              await bundle.module.act(async () => { setQuestion(window, input, value); await flush(); });
              assert(window.document.activeElement === input, 'the follow-up field must have keyboard focus');
              assert(!press(window, input, 'Enter', { shiftKey: true }), 'Shift+Enter must keep multiline follow-up entry');
              assert(!press(window, input, 'Enter', { [modifier]: true, isComposing: true }), 'composing modifier+Enter must not route a request');
              assert(!press(window, input, 'Enter', { [modifier]: true, repeat: true }), 'repeated modifier+Enter must not route a request');
              const before = followUps.length;
              await bundle.module.act(async () => {
                assert(press(window, input, 'Enter', { [modifier]: true }), 'modifier+Enter must submit the focused typed follow-up');
                press(window, input, 'Enter', { [modifier]: true });
                await flush();
              });
              assert(followUps.length === before + 1 && followUps[before] === value && nextCalls === 0, 'same-tick shortcuts must invoke the dedicated follow-up API exactly once without advancing');
              assert(input.disabled && input.value === value && window.document.querySelector(headingSelector) && window.document.querySelector('.evidence-rail'), 'a pending follow-up must retain the typed text, answer, and rail');
              assert(window.document.querySelector('#interview-follow-up-help').textContent.includes('⌘/Ctrl+Enter') && window.document.querySelector('nav + .keyboard-help').textContent.includes('follow-up'), 'local and global keyboard help must explain the follow-up shortcut');
              await bundle.module.act(async () => { resolveFollowUp(display); await flush(); });
              assert(!window.document.querySelector('#interview-follow-up') && window.document.activeElement === window.document.querySelector(headingSelector), 'successful shortcut submission must close the field and focus the returned answer');
            }
            const submitted = followUps.length;
            for (const [index, scenario] of [
              { value: '', target: 'input', modifier: 'ctrlKey' },
              { value: ' \n ', target: 'input', modifier: 'metaKey' },
              { value: 'Keep this follow-up draft', target: 'button', modifier: 'ctrlKey' },
            ].entries()) {
              await bundle.module.act(async () => { update(display); await flush(); });
              await bundle.module.act(async () => { button(window, 'Follow-up').click(); await flush(); });
              const input = window.document.querySelector('#interview-follow-up');
              await bundle.module.act(async () => { setQuestion(window, input, scenario.value); await flush(); });
              const target = scenario.target === 'input' ? input : button(window, 'Next question');
              target.focus();
              await bundle.module.act(async () => { assert(press(window, target, 'Enter', { [scenario.modifier]: true }), 'modifier+Enter must still advance for empty follow-ups or focus elsewhere'); await flush(); });
              assert(nextCalls === index + 1 && followUps.length === submitted, 'empty or unfocused follow-ups must keep the global next-question action');
              const question = window.document.querySelector('#interview-question');
              assert(question?.value === '' && window.document.activeElement === question && !window.document.querySelector('.evidence-rail') && !window.document.querySelector('.spoken-answer'), 'a successful global shortcut must unlock the next question and focus its empty field');
            }
          } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
        });
      },
    },
  ]),
  {
    name: 'interview window live UX: rejected lookup restores enabled input focus and unsupported lookup focuses its recovery action',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let rejectQuestion; let resolveQuestion;
        window.interviewAPI = { getBrief: async () => ({ ...DISPLAY, plan: null }), onBriefUpdated: () => () => undefined, close: async () => true,
          submitQuestion: () => new Promise((resolve, reject) => { resolveQuestion = resolve; rejectQuestion = reject; }), nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const input = window.document.querySelector('textarea');
          await bundle.module.act(async () => { button(window, 'Find saved evidence').click(); await flush(); });
          assert(input.disabled, 'the pending lookup must disable its input');
          button(window, 'Close').focus();
          await bundle.module.act(async () => { rejectQuestion(new Error('Interview Window snapshot is unavailable.')); await flush(); });
          assert(!input.disabled && window.document.activeElement === input, 'failed lookup must restore input focus after React commits pending=false');
          // Immediate repeated failures can be batched without a pending=true render.
          window.interviewAPI.submitQuestion = async () => { throw new Error('Interview Window snapshot is unavailable.'); };
          button(window, 'Find saved evidence').focus();
          await bundle.module.act(async () => { button(window, 'Find saved evidence').click(); await flush(); });
          assert(window.document.activeElement === input, 'a repeated identical immediate rejection must still restore focus');
          window.interviewAPI.submitQuestion = () => new Promise(resolve => { resolveQuestion = resolve; });
          await bundle.module.act(async () => { button(window, 'Find saved evidence').click(); await flush(); });
          await bundle.module.act(async () => { resolveQuestion({ ...DISPLAY, plan: { status: 'unsupported', question: 'retenton?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } }); await flush(); });
          assert(window.document.activeElement === button(window, 'Edit question'), 'unsupported lookup must focus a usable typo-recovery action');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window live UX: missing narrow bridge and a null submit return show recovery immediately',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          assert(window.document.querySelector('[role="alert"]')?.textContent.includes('Retry, or close this window'), 'missing preload must show an actionable error instead of loading forever');
          await bundle.module.act(async () => { button(window, 'Retry').click(); await flush(); });
          assert(window.document.querySelector('[role="alert"]'), 'retry without preload must stay a visible safe error');
          await bundle.module.act(async () => root.unmount());
          window.interviewAPI = { getBrief: async () => ({ ...DISPLAY, plan: null }), onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => null, nextQuestion: async () => null, setAlwaysOnTop: async () => true };
          root = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          await bundle.module.act(async () => { button(window, 'Find saved evidence').click(); await flush(); });
          assert(window.document.querySelector('[role="alert"]')?.textContent.includes('session has ended'), 'null submit must retire the stale display visibly');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window entry: branch-selected lazy views do not eagerly import the canvas App',
    run() {
      const source = fs.readFileSync(path.resolve('src/main.jsx'), 'utf8');
      // One lazy() wrapping a ternary of two imports made the bundler emit a single preload list (the App's),
      // so the packaged interview window never loaded its own stylesheet. Each view needs its own lazy().
      assert(!source.includes('lazy(() => isInterviewWindow'), 'entry must not share one lazy boundary between both views');
      assert(source.includes("typeof window.interviewAPI?.getBrief === 'function'"), 'the child route must require its narrow preload bridge, not only a query flag');
      assert(source.includes("? lazy(() => import('./interview-window/InterviewWindowApp.jsx'))"), 'interview child must be lazy-loaded on the interview branch');
      assert(source.includes(": lazy(() => import('./App.jsx'))"), 'canvas App must be lazy-loaded on the canvas branch');
      assert(!source.includes("import App from './App.jsx'"), 'entry must not eagerly import the canvas App into the interview child');
      assert(!source.includes("import InterviewWindowApp from './interview-window/InterviewWindowApp.jsx'"), 'entry must not eagerly import the child into the canvas view');
    },
  },
  {
    name: 'interview window render: fixed evidence rail keeps one current marker and accepts update events',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let update;
        let nextCalls = 0;
        window.interviewAPI = { getBrief: async () => DISPLAY, onBriefUpdated: callback => { update = callback; return () => { update = null; }; }, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => { nextCalls += 1; return { ...DISPLAY, plan: null }; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const rail = window.document.querySelector('[aria-label="Saved evidence rail"]');
          assert(rail && rail.children.length === 2, 'supported plan must render its complete fixed rail in canonical order');
          assert([...rail.children].map(item => item.textContent).join('\n').includes('Improved onboarding conversion.') && [...rail.children].map(item => item.textContent).join('\n').includes('Reviewed retention weekly.'), 'every cue must remain in canonical order inside the expandable full rail');
          assert([...rail.children].filter(item => item.getAttribute('aria-current') === 'step').length === 1 && rail.children[0].getAttribute('aria-current') === 'step', 'exactly first step must be current initially');
          assert(window.document.body.textContent.includes('Use saved details.'), 'supported plan disclosure must remain visible with the fixed evidence rail');
          assert(window.document.body.textContent.includes('Role themes') && window.document.body.textContent.includes('Source warnings'), 'briefing must label reference sections');
          assert(window.document.body.textContent.includes('Submitted application wording — reference, not career evidence') && window.document.body.textContent.includes('Replace the bundle after editing its documents.'), 'application wording must be identified as reference and disclose the need to refresh an edited bundle');
          const citations = window.document.querySelector('[aria-label="Research citations"]');
          assert(citations?.textContent.includes(DISPLAY.briefing.sources[0].sourceUrl)
            && citations.textContent.includes('Source date: 2026-10-08')
            && citations.querySelectorAll('a').length === 0,
          'the briefing must visibly render canonical research citations as inert text, never a navigation link');
          const css = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
          assert(css.includes('.citation-url') && css.includes('overflow-wrap: anywhere'), 'long inert citation URLs must wrap inside the narrow child window');
          const next = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Next');
          await bundle.module.act(async () => { next.click(); await flush(); });
          assert([...rail.children].filter(item => item.getAttribute('aria-current') === 'step').length === 1 && rail.children[1].getAttribute('aria-current') === 'step', 'Next must move marker without reordering the fixed rail');
          await bundle.module.act(async () => { update({ ...DISPLAY, plan: { ...DISPLAY.plan, currentStep: 1 } }); await flush(); });
          assert(rail.children[1].getAttribute('aria-current') === 'step', 'main-process update event must safely replace display state');
          const nextQuestion = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Next question');
          await bundle.module.act(async () => { nextQuestion.click(); await flush(); });
          assert(nextCalls === 1 && !window.document.querySelector('[aria-label="Saved evidence rail"]'), 'Next question must await the narrow main-owned transition rather than clear locally');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: initial marker follows main state and missing brief has alert, retry, and close affordances',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let requests = 0; let closed = false;
        window.interviewAPI = { getBrief: async () => { requests += 1; return requests === 1 ? { ...DISPLAY, plan: { ...DISPLAY.plan, currentStep: 1 } } : null; }, onBriefUpdated: () => () => undefined, close: async () => { closed = true; }, submitQuestion: async () => DISPLAY, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const rail = window.document.querySelector('[aria-label="Saved evidence rail"]');
          assert(rail.children[1].getAttribute('aria-current') === 'step', 'initial main-provided current step must initialize the marker');
          await bundle.module.act(async () => { root.unmount(); await flush(); });
          window.interviewAPI.getBrief = async () => { throw new Error('unavailable'); };
          const retryRoot = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { retryRoot.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          assert(window.document.querySelector('[role="alert"]')?.textContent.includes('could not load'), 'failed initial brief must be visibly reported');
          const close = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Close');
          await bundle.module.act(async () => { close.click(); await flush(); });
          assert(closed, 'failed initial load must still offer Close');
          await bundle.module.act(async () => retryRoot.unmount());
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: question submit consumes its returned display when the update event is delayed',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unplanned = { ...DISPLAY, plan: null };
        window.interviewAPI = {
          getBrief: async () => unplanned,
          // Deliberately retain the callback without invoking it: the invoke
          // response itself must be enough to render the returned rail.
          onBriefUpdated: () => () => undefined,
          close: async () => true,
          submitQuestion: async () => DISPLAY,
          nextQuestion: async () => ({ ...DISPLAY, plan: null }),
          setAlwaysOnTop: async () => true,
        };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const submit = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Find saved evidence');
          await bundle.module.act(async () => { submit.click(); await flush(); });
          assert(window.document.querySelector('[aria-label="Saved evidence rail"]'),
            'the returned submit display must render even before a brief-updated event arrives');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: arrow keys scroll the briefing when no supported rail is shown',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unsupported = { ...DISPLAY, plan: { status: 'unsupported', question: 'Why?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } };
        let update;
        window.interviewAPI = { getBrief: async () => unsupported, onBriefUpdated: callback => { update = callback; return () => { update = null; }; }, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const press = key => {
          const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
          window.document.body.dispatchEvent(event);
          return event.defaultPrevented;
        };
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          assert(window.document.body.textContent.includes('No saved evidence matches.'), 'unsupported state should render');
          assert(!press('ArrowDown') && !press('ArrowUp'), 'an unsupported plan must not swallow arrow-key scrolling');
          await bundle.module.act(async () => { update(DISPLAY); await flush(); });
          let prevented = false;
          await bundle.module.act(async () => { prevented = press('ArrowDown'); await flush(); });
          const rail = window.document.querySelector('[aria-label="Saved evidence rail"]');
          assert(prevented && rail.children[1].getAttribute('aria-current') === 'step', 'a supported rail keeps arrow-key step navigation');
          assert(!press(window, window.document.querySelector('.interview-briefing summary'), 'ArrowDown'), 'the briefing must retain keyboard scrolling even while a supported rail is present');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: a failed submit explains what failed, and only an invalid question gets the validation text',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unplanned = { ...DISPLAY, plan: null };
        const wrap = reason => new Error(`Error invoking remote method 'interview-window:submit-question': Error: ${reason}`);
        const attempt = async failure => {
          window.interviewAPI = { getBrief: async () => unplanned, onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => { throw failure; }, nextQuestion: async () => unplanned, setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            const form = window.document.querySelector('form');
            await bundle.module.act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush(); });
            return window.document.querySelector('form [role="alert"]')?.textContent || '';
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        try {
          const invalid = await attempt(wrap('Interview question is invalid.'));
          assert(invalid === 'Enter a short interview question (up to 2,000 characters).', `an invalid question keeps the validation text, got: ${invalid}`);
          const preload = await attempt(new TypeError('Interview question must be a bounded string.'));
          assert(preload === invalid, `the preload guard is an invalid question too, got: ${preload}`);
          const snapshot = await attempt(wrap('Interview Window snapshot is unavailable.'));
          const ended = await attempt(wrap('Interview session is not available.'));
          const noExample = await attempt(wrap('Interview example is not available.'));
          const raw = await attempt(new Error("EACCES: permission denied, open '/Users/someone/Library/Application Support/app/x.json'"));
          assert(/career evidence/u.test(snapshot) && !/short interview question/u.test(snapshot), `an unreadable snapshot must not read as a bad question, got: ${snapshot}`);
          assert(/session has ended/u.test(ended) && !/short interview question/u.test(ended), `a retired session must say so, got: ${ended}`);
          assert(noExample === 'Choose a saved example before asking a follow-up.', 'a missing follow-up anchor must give a fixed action without exposing IPC details');
          assert(/could not be checked/u.test(raw) && !/Users|EACCES/u.test(raw), `an unknown failure stays generic and never echoes the raw error, got: ${raw}`);
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: the always-on-top checkbox follows the window state main reports and reverts when main does not apply a change',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const mount = async api => {
          window.interviewAPI = { getBrief: async () => ({ ...DISPLAY, plan: null }), onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => DISPLAY, setAlwaysOnTop: async () => true, ...api };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          return root;
        };
        const box = () => window.document.querySelector('.pin input[type=checkbox]');
        try {
          // A normal round trip applies each change in main.
          const calls = [];
          let root = await mount({ setAlwaysOnTop: async value => { calls.push(value); return true; } });
          assert(box().checked === false, 'a window that was never pinned loads unchecked');
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === true, 'a pin that main applied stays checked');
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === false && calls.join() === 'true,false', `an unpin that main applied stays unchecked, calls: ${calls}`);
          await bundle.module.act(async () => root.unmount());
          // A reloaded page re-reads the native pin from main instead of defaulting to unchecked.
          root = await mount({ getBrief: async () => ({ ...DISPLAY, plan: null, alwaysOnTop: true }) });
          assert(box().checked === true, 'a page loaded while the window is pinned must show it pinned');
          await bundle.module.act(async () => root.unmount());
          // Main answers false when it did not apply the change: the box must not claim otherwise.
          root = await mount({ setAlwaysOnTop: async () => false });
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === false, 'a refused pin must revert the checkbox');
          await bundle.module.act(async () => root.unmount());
          // A failed unpin leaves the window pinned, so the box returns to checked (not to a hard-coded false).
          root = await mount({ getBrief: async () => ({ ...DISPLAY, plan: null, alwaysOnTop: true }), setAlwaysOnTop: async () => { throw new Error('ipc failed'); } });
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === true, 'a rejected unpin must restore the checked state');
          await bundle.module.act(async () => root.unmount());
          // A page that first failed to load restores the pin when Retry succeeds.
          let requests = 0;
          root = await mount({ getBrief: async () => { requests += 1; if (requests === 1) throw new Error('unavailable'); return { ...DISPLAY, plan: null, alwaysOnTop: true }; } });
          const retry = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Retry');
          await bundle.module.act(async () => { retry.click(); await flush(); });
          assert(box().checked === true, 'Retry must also restore the pin from main');
          await bundle.module.act(async () => root.unmount());
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: Next question after the session ended shows the missing-brief alert instead of loading forever',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unsupported = { ...DISPLAY, plan: { status: 'unsupported', question: 'Why?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } };
        const attempt = async (shown, buttonLabel) => {
          let closed = false;
          // Main answers null to next-question when the sender has no session.
          window.interviewAPI = { getBrief: async () => shown, onBriefUpdated: () => () => undefined, close: async () => { closed = true; }, submitQuestion: async () => DISPLAY, nextQuestion: async () => null, setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            const button = [...window.document.querySelectorAll('button')].find(item => item.textContent === buttonLabel);
            await bundle.module.act(async () => { button.click(); await flush(); });
            const labels = [...window.document.querySelectorAll('button')].map(item => item.textContent);
            const close = [...window.document.querySelectorAll('button')].filter(item => item.textContent === 'Close').pop();
            await bundle.module.act(async () => { close.click(); await flush(); });
            return { alert: window.document.querySelector('[role="alert"]')?.textContent || '', text: window.document.body.textContent, labels, closed, rail: !!window.document.querySelector('[aria-label="Saved evidence rail"]') };
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        try {
          for (const [label, shown, buttonLabel] of [['supported rail', DISPLAY, 'Next question'], ['unsupported banner', unsupported, 'Enter another question']]) {
            const result = await attempt(shown, buttonLabel);
            assert(/session has ended/u.test(result.alert), `${label}: a null next-question answer must say the session ended, got: ${result.alert}`);
            assert(!result.text.includes('Loading prepared brief') && !result.rail, `${label}: the window must not fall back to the loading state or keep a stale rail`);
            assert(result.labels.includes('Retry') && result.labels.includes('Close') && result.closed, `${label}: the alert keeps Retry and Close`);
          }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: a rejected Next question is visible while the rail or unsupported banner is shown',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unsupported = { ...DISPLAY, plan: { status: 'unsupported', question: 'Why?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } };
        try {
          for (const [label, shown, buttonLabel] of [['supported rail', DISPLAY, 'Next question'], ['unsupported banner', unsupported, 'Enter another question']]) {
            let update;
            window.interviewAPI = { getBrief: async () => shown, onBriefUpdated: callback => { update = callback; return () => { update = null; }; }, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => { throw new Error('ipc failed'); }, setAlwaysOnTop: async () => true };
            const root = bundle.module.createRoot(window.document.getElementById('root'));
            try {
              await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
              assert(!window.document.querySelector('[role="alert"]'), `${label}: no alert before anything fails`);
              const button = [...window.document.querySelectorAll('button')].find(item => item.textContent === buttonLabel);
              await bundle.module.act(async () => { button.click(); await flush(); });
              assert(window.document.querySelector('[role="alert"]')?.textContent.includes('could not advance'), `${label}: a rejected Next question must be visible`);
              assert(window.document.body.textContent.includes(shown.plan.status === 'supported' ? 'Locked question' : 'No saved evidence matches.'), `${label}: the current plan stays shown`);
              // The next main-process display replaces the plan, so the message must not go stale.
              await bundle.module.act(async () => { update({ ...DISPLAY, plan: { ...DISPLAY.plan, currentStep: 1 } }); await flush(); });
              assert(!window.document.querySelector('[role="alert"]'), `${label}: a new display clears the message`);
            } finally { await bundle.module.act(async () => root.unmount()); }
          }
          // A load error left from a failed first attempt does not linger over the rail once Retry succeeds.
          let requests = 0;
          window.interviewAPI = { getBrief: async () => { requests += 1; if (requests === 1) throw new Error('unavailable'); return DISPLAY; }, onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            assert(window.document.querySelector('[role="alert"]')?.textContent.includes('could not load'), 'the failed first load is reported');
            const retry = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Retry');
            await bundle.module.act(async () => { retry.click(); await flush(); });
            assert(window.document.querySelector('[aria-label="Saved evidence rail"]') && !window.document.querySelector('[role="alert"]'), 'a successful Retry must not leave the earlier load error over the rail');
          } finally { await bundle.module.act(async () => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: Retry after the session ended keeps saying the session ended',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let ended = false;
        // Once main reports the session gone, get-brief answers null too.
        window.interviewAPI = { getBrief: async () => (ended ? null : DISPLAY), onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => { ended = true; return null; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const click = async label => { const target = [...window.document.querySelectorAll('button')].find(item => item.textContent === label); await bundle.module.act(async () => { target.click(); await flush(); await flush(); }); };
          await click('Next question');
          assert(/session has ended/u.test(window.document.querySelector('[role="alert"]')?.textContent || ''), 'the session-ended alert is shown after Next question');
          await click('Retry');
          const alert = window.document.querySelector('[role="alert"]')?.textContent || '';
          assert(/session has ended/u.test(alert) && !/prepared brief/u.test(alert), `a retry that still finds no session must keep the session-ended explanation, got: ${alert}`);
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
];
