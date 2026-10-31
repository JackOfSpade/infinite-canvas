import path from 'node:path';
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

const EMPTY = { version: 1, snapshotId: 'a'.repeat(64), question: '', plan: null, answerCard: null, briefing: { role: { title: 'Engineer', company: 'Example' } } };
const ANSWER = { ...EMPTY, question: 'Tell me about a project.', plan: { status: 'supported', question: 'Tell me about a project.', currentStep: 0, message: '', missingComponents: [], steps: [{ id: 'project', label: 'PROJECT', cue: 'Built a saved example.', roleAttribution: 'Engineer · Example' }] } };
const IDLE = { status: 'idle', transcript: '', question: '', errorCode: null, message: '' };
const LISTENING = { ...IDLE, status: 'listening' };

async function flush() { await Promise.resolve(); await Promise.resolve(); }
function button(window, label) { return [...window.document.querySelectorAll('button')].find(item => item.textContent === label); }
function type(window, input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

async function withInterview(overrides, run, setup = () => {}) {
  await withDom(async window => {
    setup(window);
    const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
    let audioUpdate; let briefUpdate; let unsubscribed = false;
    window.interviewAPI = {
      getBrief: async () => EMPTY,
      onBriefUpdated: callback => { briefUpdate = callback; return () => { briefUpdate = null; }; },
      getListeningState: async () => IDLE,
      onListeningUpdated: callback => { audioUpdate = callback; return () => { audioUpdate = null; unsubscribed = true; }; },
      startListening: async () => LISTENING,
      stopListening: async () => IDLE,
      useTranscriptQuestion: async () => ANSWER,
      submitQuestion: async () => ANSWER,
      nextQuestion: async () => EMPTY,
      close: async () => true,
      setAlwaysOnTop: async () => true,
      ...overrides,
    };
    const root = bundle.module.createRoot(window.document.getElementById('root'));
    const act = async fn => bundle.module.act(async () => { await fn(); await flush(); });
    try {
      await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)));
      await run({ window, act, updateAudio: value => audioUpdate(value), updateBrief: value => briefUpdate(value), unmount: () => root.unmount(), unsubscribed: () => unsubscribed });
    } finally { await act(() => root.unmount()); await bundle.dispose(); }
  });
}

export default [
  {
    name: 'interview call audio UI: startup is cancellable and late initial/start replies cannot restore listening after Stop',
    async run() {
      let initial; let started; let stops = 0;
      await withInterview({ getListeningState: () => new Promise(resolve => { initial = resolve; }), startListening: () => new Promise(resolve => { started = resolve; }), stopListening: async () => { stops += 1; return IDLE; } }, async ({ window, act }) => {
        const input = window.document.querySelector('#interview-question');
        await act(() => button(window, 'Listen').click());
        assert(button(window, 'Stop listening') && !input.disabled, 'preparing must expose a one-click Stop while typed entry stays usable');
        assert(window.document.body.textContent.includes('Preparing on-device speech'), 'preparing must explain the first-use speech/permission wait');
        await act(() => initial(IDLE));
        assert(button(window, 'Stop listening'), 'an old status request must not hide a pending capture');
        await act(() => button(window, 'Stop listening').click());
        await act(() => started(LISTENING));
        assert(stops === 1 && button(window, 'Listen') && !button(window, 'Stop listening'), 'a late start reply after Stop must remain idle');
        assert(!window.document.querySelector('[aria-label="Live transcript"]'), 'stopping clears the live transcript');
      });
    },
  },
  {
    name: 'interview call audio UI: transcript stays separate from typing and override invokes the main-owned question once',
    async run() {
      const calls = []; let use; let stops = 0;
      await withInterview({ useTranscriptQuestion: (...args) => { calls.push(args); return new Promise(resolve => { use = resolve; }); }, stopListening: async () => { stops += 1; return IDLE; } }, async ({ window, act, updateAudio }) => {
        const input = window.document.querySelector('#interview-question');
        await act(() => type(window, input, 'My typed fallback'));
        input.focus();
        await act(() => updateAudio({ ...LISTENING, transcript: 'Walk me through your project.', question: 'Walk me through your project.' }));
        assert(window.document.activeElement === input && input.value === 'My typed fallback' && !input.disabled, 'live words must neither replace a typed draft nor move focus');
        assert(window.document.querySelector('[aria-label="Live transcript"]').textContent === 'Walk me through your project.', 'the compact transcript must show the received words');
        assert(window.document.querySelector('.call-audio-status').textContent === 'Listening' && button(window, 'Stop listening'), 'active capture must always disclose Listening and offer Stop');
        await act(() => { button(window, 'Use this question').click(); button(window, 'Checking transcript…')?.click(); });
        assert(calls.length === 1 && calls[0].length === 0, 'the override must ask main to use its own transcript without renderer text or duplicate requests');
        await act(() => use(ANSWER));
        assert(window.document.querySelector('.evidence-card')?.textContent.includes('Built a saved example.'), 'override must apply the local matcher display even if the update event is delayed');
        assert(window.document.querySelector('#interview-manual-question') && button(window, 'Stop listening'), 'a locked answer retains both typing and Stop');
        assert(stops === 0, 'prioritizing the answer must preserve the mounted audio panel and ongoing listening session');
      });
    },
  },
  {
    name: 'interview call audio UI: capture errors leave the locked answer and typed replacement fully usable',
    async run() {
      const calls = [];
      await withInterview({ getBrief: async () => ANSWER, startListening: async () => { throw new Error('private /Users/example/audio-file'); }, nextQuestion: async () => { calls.push('next'); return EMPTY; }, submitQuestion: async value => { calls.push(value); return { ...ANSWER, question: value, plan: { ...ANSWER.plan, question: value } }; } }, async ({ window, act, updateAudio }) => {
        await act(() => button(window, 'Listen').click());
        assert(window.document.querySelector('.call-audio-error')?.textContent.includes('Listening is unavailable') && !window.document.body.textContent.includes('/Users/'), 'a rejected IPC must show a fixed path-free capture error');
        const permission = 'Allow system audio access in System Settings, then retry Listen.';
        await act(() => updateAudio({ ...IDLE, status: 'error', errorCode: 'permission-denied', message: permission }));
        assert(window.document.querySelector('.call-audio-error').textContent === permission, 'the fixed main-owned permission action must be shown');
        const input = window.document.querySelector('#interview-manual-question');
        assert(input && !input.disabled && window.document.querySelector('.evidence-card'), 'a capture error must preserve the answer and immediately available typed fallback');
        await act(() => type(window, input, 'How do you prioritize your work?'));
        await act(() => button(window, 'Use typed question').click());
        assert(calls.join('|') === 'How do you prioritize your work?', `typed replacement must submit atomically without clearing the locked card first, got ${calls}`);
        assert(window.document.querySelector('.current-question-text').textContent === 'How do you prioritize your work?', 'the typed replacement must become the locked question');
      });
    },
  },
  {
    name: 'interview call audio UI: an automatic card preserves a question draft and its keyboard focus',
    async run() {
      await withInterview({}, async ({ window, act, updateBrief }) => {
        const input = window.document.querySelector('#interview-question');
        await act(() => type(window, input, 'A question I am still typing'));
        input.focus();
        await act(() => updateBrief(ANSWER));
        const replacement = window.document.querySelector('#interview-manual-question');
        assert(replacement.value === 'A question I am still typing' && window.document.activeElement === replacement, 'an automatic card must carry an unfinished draft to the replacement form and restore its caret focus');
        await act(() => updateBrief({ ...ANSWER, question: 'A later remote question' }));
        assert(replacement.value === 'A question I am still typing' && window.document.activeElement === replacement, 'later automatic cards must not steal focus or erase the manual draft');
      });
    },
  },
  {
    name: 'interview call audio UI: listening notices remain visible and incomplete or oversized transcript previews cannot be submitted',
    async run() {
      await withInterview({}, async ({ window, act, updateAudio }) => {
        const message = 'This turn is too long to use safely. Type the complete question below.';
        await act(() => updateAudio({ ...LISTENING, transcript: 'A clipped preview of a long turn…', question: '', message }));
        assert(window.document.querySelector('.call-audio-help[role="status"]')?.textContent === message, 'listening must show the fixed abstention reason rather than silently leaving an old card');
        assert(button(window, 'Use this question')?.disabled, 'an incomplete or oversized preview without a complete main-owned question must not be submitable');
        assert(!window.document.querySelector('#interview-question').disabled && button(window, 'Stop listening'), 'abstention must preserve immediate typing and Stop');
        await act(() => updateAudio({ ...LISTENING, transcript: 'What did you learn?', question: 'What did you learn?', message: 'No confident prepared answer match.' }));
        assert(!button(window, 'Use this question').disabled && window.document.querySelector('.call-audio-help').textContent === 'No confident prepared answer match.', 'a complete bounded endpoint may enable override while its lookup notice remains visible');
      });
    },
  },
  {
    name: 'interview call audio UI: locked-card listening strip keeps the last transcript line, notices and errors pinned at 440x680',
    async run() {
      await withInterview({ getBrief: async () => ANSWER }, async ({ window, act, updateAudio }) => {
        const strip = window.document.querySelector('.call-audio-live');
        assert(window.innerWidth === 440 && window.innerHeight === 680 && window.getComputedStyle(strip).position === 'fixed', 'the compact listening surface must be pinned even when its full panel follows a long answer');
        await act(() => updateAudio({ ...LISTENING, transcript: 'Earlier words.\nWhat did you learn?', question: 'What did you learn?', message: 'Transcript ready. Use this question to choose it.' }));
        window.document.querySelector('.evidence-card h2').focus();
        assert(strip.contains(window.document.querySelector('[aria-label="Live transcript"]')) && strip.querySelector('[aria-label="Live transcript"]').textContent === 'What did you learn?', 'the fixed strip must show the newest transcript line even after answer focus');
        assert(strip.querySelector('.call-audio-help').textContent === 'Transcript ready. Use this question to choose it.' && strip.contains(button(window, 'Use this question')), 'the notice and explicit question action must share the pinned strip');
        const transcriptStyle = window.getComputedStyle(strip.querySelector('.call-audio-transcript'));
        assert(transcriptStyle.whiteSpace === 'nowrap' && transcriptStyle.textOverflow === 'ellipsis', 'a long last line must truncate without expanding the strip');
        await act(() => updateAudio({ ...IDLE, status: 'error', message: 'Audio capture stopped. Retry Listen.' }));
        assert(strip.querySelector('[role="alert"]').textContent === 'Audio capture stopped. Retry Listen.', 'a capture failure must stay in the same pinned surface while the card remains locked');
        assert(!strip.contains(window.document.querySelector('.call-audio-guidance')), 'permissions details must remain outside the compact pinned surface');
      }, window => {
        Object.defineProperties(window, { innerWidth: { configurable: true, value: 440 }, innerHeight: { configurable: true, value: 680 } });
        const style = window.document.createElement('style');
        style.textContent = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
        window.document.head.append(style);
      });
    },
  },
  {
    name: 'interview call audio UI: narrow saved-cue controls stay on one row and reserve measured strip and nav heights',
    async run() {
      const observed = new Set(); let resize; let navHeight = 49; let stripHeight = 118;
      await withInterview({}, async ({ window, act, updateBrief }) => {
        const main = window.document.querySelector('main');
        assert(!main.style.getPropertyValue('--answer-nav-height'), 'an unlocked view must not retain a locked navigation inset');
        await act(() => updateBrief(ANSWER));
        const nav = main.querySelector('nav');
        const strip = main.querySelector('.call-audio-live');
        assert(window.innerWidth === 360 && window.getComputedStyle(nav).flexWrap === 'nowrap' && window.getComputedStyle(nav).overflowX === 'auto', 'the five saved-cue actions must remain one scrollable row at the minimum width');
        assert([...nav.querySelectorAll('button')].map(item => item.textContent).join('|') === 'Previous|Next|Follow-up|Next question|Copy cues', 'the narrow rail must retain every existing control');
        assert(observed.has(nav) && observed.has(strip) && main.style.getPropertyValue('--answer-nav-height') === '49px' && main.style.getPropertyValue('--listening-strip-height') === '118px', 'a card arriving during listening must begin observing and reserving both actual control heights');
        navHeight = 65; stripHeight = 156;
        await act(() => resize());
        assert(main.style.getPropertyValue('--answer-nav-height') === '65px' && main.style.getPropertyValue('--listening-strip-height') === '156px', 'font, notice, scrollbar and window-size changes must update bottom spacing');
        const css = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
        assert(css.includes('padding-bottom: calc(var(--answer-nav-height) + var(--listening-strip-height) + 32px)') && css.includes('scroll-margin-block: 16px calc(var(--answer-nav-height, 58px) + var(--listening-strip-height, 0px) + 24px)'), 'page end and focused fields must both clear the measured fixed controls');
      }, window => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
        const style = window.document.createElement('style');
        style.textContent = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
        window.document.head.append(style);
        const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
        window.HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.matches('nav')) return { height: navHeight };
          if (this.matches('.call-audio-live')) return { height: stripHeight };
          return originalRect.call(this);
        };
        window.ResizeObserver = class {
          constructor(callback) { resize = callback; }
          observe(element) { observed.add(element); }
          disconnect() { observed.clear(); }
        };
      });
    },
  },
  {
    name: 'interview call audio UI: ignored Use this question preserves the locked card and shows feedback across background transcript updates',
    async run() {
      const message = 'This transcript has no complete question. Edit it below.';
      await withInterview({ getBrief: async () => ANSWER, getListeningState: async () => ({ ...LISTENING, transcript: 'leadership', question: 'leadership' }), useTranscriptQuestion: async () => ({ ignored: true, reason: 'no-complete-question', message }) }, async ({ window, act, updateAudio }) => {
        const card = window.document.querySelector('.evidence-card');
        const input = window.document.querySelector('#interview-manual-question');
        await act(() => type(window, input, 'My unfinished replacement'));
        await act(() => button(window, 'Use this question').click());
        assert(window.document.querySelector('.evidence-card') === card && input.value === 'My unfinished replacement', 'an ignored transcript action must not apply the ignored object as a display or erase a manual draft');
        assert(window.document.querySelector('.call-audio-live [role="alert"]')?.textContent === message && button(window, 'Use this question'), 'the explicit action must show its reason inline and remain available to retry');
        await act(() => updateAudio({ ...LISTENING, transcript: 'Some later background audio', question: 'Some later background audio' }));
        assert(window.document.querySelector('.call-audio-live [role="alert"]')?.textContent === message, 'background listening updates must not silently dismiss the result of an explicit action');
      });
    },
  },
  {
    name: 'interview call audio UI: Stop preserves a pending explicit question result and teardown releases listening',
    async run() {
      let use; let stops = 0;
      await withInterview({ getListeningState: async () => ({ ...LISTENING, transcript: 'Tell me about a project.', question: 'Tell me about a project.' }), useTranscriptQuestion: () => new Promise(resolve => { use = resolve; }), stopListening: async () => { stops += 1; return IDLE; } }, async ({ window, act, unmount, unsubscribed }) => {
        await act(() => button(window, 'Use this question').click());
        await act(() => button(window, 'Stop listening').click());
        await act(() => use(ANSWER));
        assert(window.document.querySelector('.evidence-card')?.textContent.includes('Built a saved example.') && window.document.querySelector('#interview-manual-question'), 'the explicit question must still display its answer after Stop');
        assert(button(window, 'Listen') && !button(window, 'Stop listening') && !window.document.querySelector('[aria-label="Live transcript"]'), 'finishing the explicit request must leave capture idle and its stopped transcript cleared');
        const guidance = window.document.querySelector('.call-audio-guidance').textContent;
        assert(guidance.includes('automatically advances cards') && guidance.includes('Screen & System Audio Recording') && guidance.includes('no screen images') && guidance.includes('restart later'), 'consent and permission guidance must explain automation, screen-category wording and user-directed restart');
        await act(unmount);
        assert(unsubscribed() && stops === 2, 'unmount must detach status events and release the native listener');
      });
    },
  },
  {
    name: 'interview call audio UI: Stop preserves an ignored explicit question explanation inline',
    async run() {
      let use;
      const message = 'This transcript has no complete question. Edit it below.';
      await withInterview({ getBrief: async () => ANSWER, getListeningState: async () => ({ ...LISTENING, transcript: 'leadership', question: 'leadership' }), useTranscriptQuestion: () => new Promise(resolve => { use = resolve; }) }, async ({ window, act }) => {
        const card = window.document.querySelector('.evidence-card');
        const input = window.document.querySelector('#interview-manual-question');
        await act(() => type(window, input, 'An unfinished typed draft'));
        await act(() => button(window, 'Use this question').click());
        await act(() => button(window, 'Stop listening').click());
        await act(() => use({ ignored: true, reason: 'no-complete-question', message }));
        assert(window.document.querySelector('.call-audio-live [role="alert"]')?.textContent === message, 'stopping capture must not silently discard the explanation for an explicit question request');
        assert(window.document.querySelector('.evidence-card') === card && input.value === 'An unfinished typed draft', 'an ignored question after Stop must retain the locked card and unfinished draft');
        assert(button(window, 'Listen') && !button(window, 'Stop listening'), 'the ignored request result must not restore audio capture');
      });
    },
  },
];
