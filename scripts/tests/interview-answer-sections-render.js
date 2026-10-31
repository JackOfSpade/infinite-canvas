import path from 'node:path';
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

const CARD = {
  id: 'guide', question: 'Tell me about a project.', headline: 'I simplified a team guide.',
  headlineEvidenceIds: ['career-guide'],
  bullets: [
    { text: 'The guide was difficult to follow.', stage: 'situation', evidenceIds: ['career-guide'] },
    { text: 'I tested the revised guide with the team.', stage: 'action', evidenceIds: ['career-guide'] },
    { text: 'The team adopted the revised guide.', stage: 'result', evidenceIds: ['career-guide'] },
  ],
  example: { text: 'I tested the guide against a checklist.', evidenceIds: ['career-guide'] },
  evidence: [{ id: 'career-guide', sourceLabel: 'Saved guide project', quote: 'I tested the revised guide with the team using a checklist.' },
    { id: 'career-support', sourceLabel: 'Support handbook project', quote: 'I interviewed support staff about confusing handbook steps and recorded their feedback.' },
    { id: 'career-release', sourceLabel: 'Release review project', quote: 'I compared release checklists with engineering and documented the tradeoffs.' }],
  optionalExtension: [
    { id: 'support-feedback', text: 'I interviewed support staff about confusing handbook steps.', exampleHook: 'Support handbook', sourceLabel: 'Support handbook project', evidenceIds: ['career-support'] },
    { id: 'release-tradeoffs', text: 'I compared release checklists with engineering and documented the tradeoffs.', exampleHook: 'Release review', sourceLabel: 'Release review project', evidenceIds: ['career-release'] },
  ],
};
const DISPLAY = { version: 1, snapshotId: 'a'.repeat(64), question: CARD.question,
  answerCard: CARD, plan: null, matching: { mode: 'auto', effectiveMode: 'recall', approximate: false },
  briefing: { role: { title: 'Engineer', company: 'Example' }, preparedQuestions: [CARD.question] } };

async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function mounted(overrides, run) {
  await withDom(async window => {
    const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
    let update;
    window.interviewAPI = { getBrief: async () => DISPLAY, onBriefUpdated: callback => { update = callback; return () => undefined; },
      close: async () => true, setAlwaysOnTop: async () => true, setLatencyMode: async mode => ({ ...DISPLAY, matching: { ...DISPLAY.matching, mode, effectiveMode: 'recall' } }), ...overrides };
    const root = bundle.module.createRoot(window.document.getElementById('root'));
    const act = async callback => bundle.module.act(async () => { await callback(); await flush(); });
    try {
      await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)));
      await run({ window, act, update: value => update(value) });
    } finally { await act(() => root.unmount()); await bundle.dispose(); }
  });
}

function preview(card = CARD, confidence = 0.736) {
  return { id: `guess-${card.id}`, cardId: card.id, card, confidence, transcript: 'Tell me about the team', updatedAt: 1 };
}
const NEXT_CARD = { ...CARD, id: 'support', question: 'How do you handle support?', headline: 'I clarified a support handbook.',
  bullets: [{ text: 'I interviewed support staff.', stage: 'action', evidenceIds: ['career-support'] }],
  example: { text: 'I recorded confusing handbook steps.', evidenceIds: ['career-support'] } };
function button(window, label) { return [...window.document.querySelectorAll('button')].find(item => item.textContent === label); }
function type(window, input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}
function addStyles(window) {
  const style = window.document.createElement('style');
  style.textContent = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
  window.document.head.append(style);
  return style.sheet;
}

export default [
  {
    name: 'interview preview: provisional answer promotes in place with disclosures, focus, scroll and typed draft intact',
    async run() {
      const empty = { ...DISPLAY, question: '', answerCard: null, preview: null };
      await mounted({ getBrief: async () => empty }, async ({ window, act, update }) => {
        const input = window.document.querySelector('#interview-question');
        await act(() => type(window, input, 'An unfinished question draft'));
        input.focus();
        let focusCalls = 0;
        const focus = window.HTMLElement.prototype.focus;
        window.HTMLElement.prototype.focus = function (...args) { focusCalls += 1; return focus.apply(this, args); };
        await act(() => update({ ...empty, preview: preview() }));
        const card = window.document.querySelector('main > .spoken-answer');
        const example = card.querySelector('.spoken-example');
        const extension = card.querySelector('.optional-extension');
        assert(card.classList.contains('provisional-answer') && card.querySelector('.preview-badge').textContent === 'Likely · 74%', 'an unlocked guess must visibly state its rounded likelihood and have provisional styling');
        assert(card.querySelector('.answer-headline-text').textContent === CARD.headline && [...card.querySelectorAll('.spoken-bullets li > span:not(.answer-stage):not(.answer-citation-refs)')].map(item => item.textContent).join('|') === CARD.bullets.map(item => item.text).join('|'), 'the provisional main surface must use the complete prepared headline and bullets');
        assert(!example.open && !extension.open && !window.document.querySelector('.coming-up'), 'the initial preview must use the regular collapsed sections, not the compact secondary panel');
        assert(window.document.activeElement === input && input.value === 'An unfinished question draft' && focusCalls === 0, 'a preview appearing in the question-entry state must not focus anything or discard the question draft');
        await act(() => example.querySelector('summary').click());
        await act(() => extension.querySelector('summary').click());
        const summary = extension.querySelector('summary');
        summary.focus();
        card.scrollTop = 29;
        const page = window.document.scrollingElement || window.document.documentElement;
        page.scrollTop = 41;
        const live = window.document.querySelector('.preview-announcement');
        const firstAnnouncement = live.textContent;
        const mutations = [];
        const observer = new window.MutationObserver(records => mutations.push(...records));
        observer.observe(live, { childList: true, subtree: true, characterData: true });
        focusCalls = 0;
        await act(() => update({ ...empty, preview: { ...preview(CARD, 0.91), transcript: 'Tell me about the guide you simplified', updatedAt: 2 } }));
        assert(live.getAttribute('aria-live') === 'polite' && live.getAttribute('aria-atomic') === 'true' && firstAnnouncement === live.textContent && mutations.length === 0, 'confidence and partial-transcript ticks must not mutate the polite announcement');
        assert(card.querySelector('.preview-badge').textContent === 'Likely · 91%' && window.document.activeElement === summary && focusCalls === 0, 'confidence must update visibly without refocusing a disclosure or heading');
        observer.disconnect();
        await act(() => update({ ...DISPLAY, preview: null }));
        assert(window.document.querySelector('main > .spoken-answer') === card && card.querySelector('.spoken-example') === example && card.querySelector('.optional-extension') === extension, 'locking the same cardId must preserve the exact prepared-answer and disclosure DOM nodes');
        assert(!card.classList.contains('provisional-answer') && !card.querySelector('.preview-badge') && example.open && extension.open, 'promotion must only remove provisional treatment, keeping expanded sections');
        assert(window.document.activeElement === summary && focusCalls === 0 && card.scrollTop === 29 && page.scrollTop === 41, 'same-card promotion must not move focus or reset card or page scroll');
        assert(window.document.querySelector('#interview-manual-question').value === 'An unfinished question draft', 'the normal locked replacement form must retain the question typed during the preview');
        window.HTMLElement.prototype.focus = focus;
      });
    },
  },
  {
    name: 'interview preview: switching and clearing an unlocked guess preserve the entry form and announce only cardId changes',
    async run() {
      const empty = { ...DISPLAY, question: '', answerCard: null };
      await mounted({ getBrief: async () => empty }, async ({ window, act, update }) => {
        const input = window.document.querySelector('#interview-question');
        await act(() => type(window, input, 'Still writing my question'));
        input.focus();
        await act(() => update({ ...empty, preview: preview() }));
        const live = window.document.querySelector('.preview-announcement');
        const first = live.textContent;
        assert(first === `Likely prepared answer: ${CARD.headline}. Provisional answer.`, 'the first guessed card must be announced as provisional in text');
        await act(() => update({ ...empty, preview: preview(NEXT_CARD, 0.82) }));
        assert(window.document.querySelector('main > .spoken-answer .answer-headline-text').textContent === NEXT_CARD.headline && live.textContent === `Likely prepared answer: ${NEXT_CARD.headline}. Provisional answer.` && live.textContent !== first, 'a different cardId must replace the speculative content and announce the new identity');
        assert(window.document.activeElement === input && input.value === 'Still writing my question', 'switching speculative identities must leave focus and the typed question alone');
        const card = window.document.querySelector('main > .spoken-answer');
        const summary = card.querySelector('.spoken-example summary');
        await act(() => summary.click());
        summary.focus();
        await act(() => update({ ...empty, preview: preview(CARD) }));
        assert(window.document.querySelector('main > .spoken-answer') === card && window.document.activeElement === summary && summary.parentElement.open, 'switching a provisional identity must also preserve a keyboard reader on an expanded card disclosure');
        input.focus();
        await act(() => update({ ...empty, preview: null }));
        assert(!window.document.querySelector('.spoken-answer') && !window.document.querySelector('.coming-up') && !live.textContent, 'an abstained unlocked preview must disappear cleanly');
        assert(window.document.querySelector('#interview-question') === input && input.value === 'Still writing my question' && window.document.activeElement === input, 'clearing a guess must not replace or reset the entry form');
      });
    },
  },
  {
    name: 'interview preview: Coming up is above the untouched locked card, expands fully and never changes clipboard content',
    async run() {
      await mounted({}, async ({ window, act, update }) => {
        let copied;
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        await act(() => button(window, 'Copy answer').click());
        const lockedCopy = copied;
        const card = window.document.querySelector('main > .spoken-answer');
        const markup = card.outerHTML;
        const headline = card.querySelector('h2');
        await act(() => update({ ...structuredClone(DISPLAY), preview: preview(NEXT_CARD, 0.74) }));
        const panel = window.document.querySelector('.coming-up');
        assert(panel.getAttribute('aria-label') === 'Coming up' && panel.querySelector('.preview-label').textContent === 'Coming up · Likely 74%', 'a different upcoming card must have an explicit provisional panel label');
        assert(panel.querySelector('.coming-up-content h2').textContent === NEXT_CARD.headline && [...panel.querySelectorAll('.coming-up-content li')].map(item => item.textContent).join('|') === NEXT_CARD.bullets.map(item => item.text).join('|'), 'the compact panel must contain the upcoming headline and every bullet');
        assert(panel.compareDocumentPosition(card) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the preview panel must precede, not replace or reorder, the locked answer');
        assert(window.document.querySelector('main > .spoken-answer') === card && card.outerHTML === markup && card.querySelector('h2') === headline, 'a speculative card must not mutate or remount the locked card');
        const full = panel.querySelector('.preview-full-card');
        assert(!full.open && full.querySelector('summary').textContent === 'Full prepared answer', 'the full upcoming answer must start collapsed behind an explicit control');
        await act(() => full.querySelector('summary').click());
        assert(full.open && full.querySelector('.spoken-example p').textContent.startsWith(NEXT_CARD.example.text) && full.querySelector('.optional-extension') && full.querySelectorAll('.answer-evidence li').length === NEXT_CARD.evidence.length, 'expanding Coming up must expose the same full prepared-card layout, optional points and exact evidence');
        const live = window.document.querySelector('.preview-announcement');
        const announcement = live.textContent;
        const fullSummary = full.querySelector('summary');
        fullSummary.focus();
        await act(() => update({ ...DISPLAY, preview: preview(NEXT_CARD, 0.93) }));
        assert(window.document.querySelector('.coming-up') === panel && full.open && window.document.activeElement === fullSummary && live.textContent === announcement && panel.querySelector('.preview-label').textContent === 'Coming up · Likely 93%', 'a secondary confidence tick must preserve expanded content and focus without repeating the announcement');
        const nextGuess = { ...NEXT_CARD, id: 'release', headline: 'I clarified a release checklist.' };
        const exampleSummary = full.querySelector('.spoken-example summary');
        exampleSummary.focus();
        await act(() => update({ ...DISPLAY, preview: preview(nextGuess) }));
        assert(window.document.querySelector('.coming-up') === panel && full.open && window.document.activeElement === exampleSummary && live.textContent === `Coming up: ${nextGuess.headline}. Provisional answer.`, 'a new secondary cardId must announce its identity while preserving focused full-preview disclosure controls');
        await act(() => button(window, 'Copy answer').click());
        assert(copied === lockedCopy && !copied.split('\n').includes(NEXT_CARD.headline) && !copied.split('\n').includes(NEXT_CARD.bullets[0].text), 'Copy answer must be byte-for-byte the locked answer, never the upcoming headline or bullets');
        await act(() => update({ ...DISPLAY, preview: preview(CARD) }));
        assert(!window.document.querySelector('.coming-up') && !window.document.querySelector('.preview-announcement').textContent && window.document.querySelector('main > .spoken-answer') === card && card.outerHTML === markup, 'a preview equal to the locked cardId must render and announce nothing extra');
        await act(() => update({ ...DISPLAY, preview: preview(NEXT_CARD) }));
        await act(() => update({ ...DISPLAY, preview: null }));
        assert(!window.document.querySelector('.coming-up') && window.document.querySelector('main > .spoken-answer') === card && card.outerHTML === markup, 'clearing a secondary preview must leave the exact locked card untouched');
        await act(() => update({ ...DISPLAY, question: NEXT_CARD.question, answerCard: NEXT_CARD, preview: null }));
        assert(!window.document.querySelector('.coming-up') && window.document.querySelector('main > .spoken-answer .answer-headline-text').textContent === NEXT_CARD.headline, 'a newly locked different card must replace the old answer and remove the speculative panel');
      });
    },
  },
  {
    name: 'interview preview: confidence ticks, identity switches and clearing never close a follow-up or disturb either draft or keyboard focus',
    async run() {
      await mounted({}, async ({ window, act, update }) => {
        const card = window.document.querySelector('main > .spoken-answer');
        const replacement = window.document.querySelector('#interview-manual-question');
        await act(() => type(window, replacement, 'An unfinished replacement'));
        await act(() => button(window, 'Follow-up').click());
        const followUp = window.document.querySelector('#interview-follow-up');
        await act(() => type(window, followUp, 'What did I learn from the project?'));
        followUp.focus(); followUp.setSelectionRange(5, 9);
        let focusCalls = 0;
        const focus = window.HTMLElement.prototype.focus;
        window.HTMLElement.prototype.focus = function (...args) { focusCalls += 1; return focus.apply(this, args); };
        const third = { ...NEXT_CARD, id: 'release', headline: 'I clarified a release checklist.' };
        for (const guess of [preview(NEXT_CARD), preview(NEXT_CARD, 0.95), preview(third, 0.88), null]) {
          await act(() => update({ ...structuredClone(DISPLAY), preview: guess }));
          assert(window.document.querySelector('#interview-follow-up') === followUp && followUp.value === 'What did I learn from the project?' && !followUp.disabled, 'every speculative update must retain the same open, enabled follow-up and its text');
          assert(window.document.activeElement === followUp && followUp.selectionStart === 5 && followUp.selectionEnd === 9 && focusCalls === 0, 'speculation must not call focus or reset a draft caret');
          assert(window.document.querySelector('#interview-manual-question') === replacement && replacement.value === 'An unfinished replacement' && window.document.querySelector('main > .spoken-answer') === card, 'both independent drafts and the locked answer must survive speculative churn');
        }
        // Also protect focus on non-input controls, where a refocus-to-heading
        // regression would not be masked by the existing typing guard.
        await act(() => button(window, 'Cancel follow-up').click());
        const summary = card.querySelector('.optional-extension summary');
        summary.focus(); focusCalls = 0;
        await act(() => update({ ...DISPLAY, preview: preview(NEXT_CARD) }));
        assert(window.document.activeElement === summary && focusCalls === 0, 'a preview must leave a keyboard reader on a locked-card disclosure as well as on text inputs');
        window.HTMLElement.prototype.focus = focus;
      });
    },
  },
  {
    name: 'interview preview: compact panel has an internally scrolling geometry budget and keeps listening and navigation pinned at 440x680',
    async run() {
      const long = { ...NEXT_CARD, headline: 'A long upcoming prepared answer '.repeat(6), bullets: Array.from({ length: 12 }, (_, index) => ({ text: `Upcoming cue ${index}: ${'saved detail '.repeat(12)}`, stage: 'action', evidenceIds: ['career-guide'] })) };
      await mounted({ getBrief: async () => ({ ...DISPLAY, preview: preview(long) }) }, async ({ window, act }) => {
        Object.defineProperties(window, { innerWidth: { configurable: true, value: 440 }, innerHeight: { configurable: true, value: 680 } });
        addStyles(window);
        const panel = window.document.querySelector('.coming-up');
        const scroll = panel.querySelector('.coming-up-scroll');
        const card = window.document.querySelector('main > .spoken-answer');
        const strip = window.document.querySelector('.call-audio-live');
        const nav = window.document.querySelector('nav');
        const style = element => window.getComputedStyle(element);
        const number = (element, property) => Number.parseFloat(style(element).getPropertyValue(property));
        const cap = number(panel, 'max-height');
        const scrollCap = number(scroll, 'max-height');
        const label = panel.querySelector('.preview-label');
        const total = scrollCap + number(label, 'line-height') + number(label, 'margin-bottom') + number(panel, 'padding-top') + number(panel, 'padding-bottom') + number(panel, 'border-top-width') + number(panel, 'border-bottom-width');
        assert(window.innerWidth === 440 && window.innerHeight === 680 && cap > 0 && cap <= 168 && total <= cap, 'the panel border-box budget, including its label and scrollport, must be capped at 168px at the compact viewport');
        assert(scrollCap > 0 && scrollCap <= 128 && style(scroll).overflowY === 'auto' && style(scroll).overscrollBehavior === 'contain', 'arbitrarily long upcoming headlines, bullets and expanded content must scroll internally without chaining to the page');
        assert(style(strip).position === 'fixed' && style(nav).position === 'fixed' && style(nav).flexWrap === 'nowrap', 'listening and bottom navigation must remain fixed and single-row with a Coming up panel present');
        assert(card.querySelector('.answer-headline-text').textContent === CARD.headline && panel.compareDocumentPosition(card) & window.Node.DOCUMENT_POSITION_FOLLOWING && style(card).display !== 'none' && style(card.querySelector('h2')).visibility !== 'hidden', 'the capped panel must precede a still-visible locked headline rather than hiding it');
        const full = panel.querySelector('.preview-full-card');
        await act(() => full.querySelector('summary').click());
        assert(full.open && number(panel, 'max-height') === cap && number(scroll, 'max-height') === scrollCap && scroll.contains(full), 'expanding the full preview must stay inside the same fixed panel geometry budget');
        assert(style(window.document.querySelector('main')).overflowAnchor === 'none', 'preview insertion and removal must not trigger page scroll anchoring');
      });
    },
  },
  {
    name: 'interview preview: transitions stay under 150ms, reduced motion disables them, and preview theme colours are tokenized',
    async run() {
      await mounted({ getBrief: async () => ({ ...DISPLAY, answerCard: null, question: '', preview: preview() }) }, async ({ window }) => {
        const sheet = addStyles(window);
        const rules = [...sheet.cssRules];
        const rule = selector => rules.find(item => item.selectorText === selector);
        assert(window.getComputedStyle(window.document.querySelector('.provisional-answer')).borderStyle === 'dashed', 'provisional content must have a distinct dashed border as well as the visible Likely text');
        const animation = rule('.coming-up-content').style.getPropertyValue('animation');
        const transition = rule('.interview-window .spoken-answer').style.getPropertyValue('transition');
        assert(animation === 'interview-preview-arrive 120ms ease-out' && transition === 'background-color 120ms ease-out, border-color 120ms ease-out', 'card switches must use only short opacity/colour effects, not animated layout or scrolling');
        const reduced = rules.find(item => item.conditionText === '(prefers-reduced-motion: reduce)' && [...item.cssRules].some(child => child.selectorText === '.interview-window .spoken-answer'));
        const overrides = [...reduced.cssRules];
        assert(overrides.find(item => item.selectorText === '.interview-window .spoken-answer')?.style.getPropertyValue('transition') === 'none' && overrides.find(item => item.selectorText === '.interview-window .provisional-answer, .coming-up-content')?.style.getPropertyValue('animation') === 'none', 'the reduced-motion media rule must disable both the promotion transition and speculative-entry animation');
        const light = rules.find(item => item.conditionText === '(prefers-color-scheme: light)');
        const dark = rules.find(item => item.selectorText === '.interview-window' && item.style.getPropertyValue('--preview-surface'));
        assert(dark && [...light.cssRules].some(item => item.selectorText === '.interview-window' && item.style.getPropertyValue('--preview-surface') !== dark.style.getPropertyValue('--preview-surface')) && rule('.coming-up').style.getPropertyValue('background') === 'var(--preview-surface)', 'light and dark preview surfaces must use shared theme tokens rather than a hard-coded panel colour');
      });
    },
  },
  {
    name: 'interview answer sections: memorized answer leads and optional grounded extension starts collapsed',
    async run() {
      await mounted({ getBrief: async () => ({ ...DISPLAY, briefing: { ...DISPLAY.briefing, preparedCards: [{ id: CARD.id, question: CARD.question }] } }) }, async ({ window, act }) => {
        let copied;
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        const prepared = window.document.querySelector('[aria-label="Your prepared answer"]');
        const optional = window.document.querySelector('[aria-label="Optional extension"]');
        assert(window.document.querySelector('main').dataset.answerLayout === 'recall' && !window.document.querySelector('.continuation-guidance'), 'the default automatic layout must show the normal two sections before slow latency is measured');
        assert(prepared.querySelector('.answer-headline-text').textContent === CARD.headline && prepared.querySelectorAll('.spoken-bullets li').length === 3, 'the first section must contain the memorized headline and all recall bullets');
        for (const selector of ['.answer-layout-control', '.call-audio', '.other-prepared-answers']) {
          assert(prepared.compareDocumentPosition(window.document.querySelector(selector)) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'answer layout, listening details and other saved answers must follow the primary speaking surface');
        }
        assert(prepared.compareDocumentPosition(optional) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the optional section must follow the memorized answer');
        assert(optional.tagName === 'DETAILS' && !optional.open && optional.querySelector('summary').textContent === 'Optional extension', 'additional points must start behind a separate optional disclosure');
        assert(optional.querySelector('.extension-caution').textContent === 'Optional, bring in only if you can back it with an example', 'optional points must explain the human example requirement');
        assert(optional.querySelectorAll('.extension-points li').length === 2, 'the optional section must show multiple separately prepared points');
        for (const point of CARD.optionalExtension) {
          assert(!prepared.textContent.includes(point.text) && optional.textContent.includes(point.text) && optional.textContent.includes(`Example hook: ${point.exampleHook}`), 'additional material must stay separate and retain its concrete example hook');
        }
        await act(() => optional.querySelector('summary').click());
        assert(optional.open, 'the user can explicitly reveal additional points');
        await act(() => optional.querySelector('.extension-points .answer-citation-ref').click());
        const exact = window.document.querySelector('.answer-evidence');
        assert(exact.open && exact.contains(window.document.activeElement) && window.document.activeElement.textContent.includes(CARD.evidence[1].quote), 'an optional point must open and focus its own exact additional career source');
        await act(() => [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Copy answer').click());
        assert(copied.indexOf('Your prepared answer') < copied.indexOf(CARD.headline) && copied.indexOf('Optional extension') > copied.indexOf(CARD.bullets[2].text), 'copied text must preserve the memorized and optional sections in order');
        assert(copied.includes('Optional, bring in only if you can back it with an example') && CARD.optionalExtension.every(point => copied.includes(point.text) && copied.includes(`Example hook: ${point.exampleHook}`)), 'clipboard must retain the optional caution, both short points and their concrete example hooks');
        assert(copied.includes(`${CARD.optionalExtension[0].text} [2]`) && copied.includes(`${CARD.optionalExtension[1].text} [3]`), 'copied extension points must cite their own additional evidence');
      });
    },
  },
  {
    name: 'interview answer sections: prepared concrete example remains in section A beside independent extensions',
    async run() {
      await mounted({}, async ({ window, act }) => {
        let copied;
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        assert(window.document.querySelector('.prepared-answer-recall .spoken-example').textContent.includes(CARD.example.text) && !window.document.querySelector('.optional-extension').textContent.includes(CARD.example.text), 'the prepared concrete example must stay with memorized material while optional points add different evidence');
        await act(() => [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Copy answer').click());
        assert(copied.split(CARD.example.text).length === 2 && copied.indexOf(`Concrete example: ${CARD.example.text}`) < copied.indexOf('Optional extension'), 'copy must include the prepared example once before the optional section');
      });
    },
  },
  {
    name: 'interview answer sections: measured continuation layout preserves data and manual Recall overrides it',
    async run() {
      const calls = [];
      await mounted({ getBrief: async () => ({ ...DISPLAY, matching: { ...DISPLAY.matching, effectiveMode: 'continuation', p50Ms: 2800 } }),
        setLatencyMode: async mode => { calls.push(mode); return { ...DISPLAY, matching: { ...DISPLAY.matching, mode, effectiveMode: 'recall' } }; } }, async ({ window, act }) => {
        const card = window.document.querySelector('.spoken-answer');
        const visibleBullets = () => [...window.document.querySelectorAll('.spoken-bullets li > span:not(.answer-stage):not(.answer-citation-refs)')].map(item => item.textContent);
        assert(card.dataset.answerLayout === 'continuation' && window.document.querySelector('.continuation-guidance').textContent.includes('your own words'), 'slow automatic mapping must explain that the person can keep speaking');
        assert(visibleBullets().join('|') === [CARD.bullets[1].text, CARD.bullets[2].text, CARD.bullets[0].text].join('|'), 'continuation must put actions and outcomes before background without rewriting any memorized point');
        assert(window.document.activeElement === card.querySelector('.prepared-answer-recall > .eyebrow'), 'continuation must focus the section start, keeping glanceable cues in view');
        const select = window.document.querySelector('#interview-answer-layout');
        assert([...select.options].map(option => option.value).join(',') === 'auto,recall', 'Keep going must remain automatic rather than a manually selectable layout');
        await act(() => { select.value = 'recall'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
        assert(calls.join() === 'recall' && window.document.querySelector('.spoken-answer').dataset.answerLayout === 'recall' && select.value === 'recall', 'manual layout choice must use the restricted API and display the returned preference');
        assert(visibleBullets().join('|') === CARD.bullets.map(item => item.text).join('|') && !window.document.querySelector('.continuation-guidance'), 'Recall must restore memorized order using the identical card data');
      });
    },
  },
  {
    name: 'interview answer sections: continuation visual order keeps Concrete example after the action cues and headline',
    async run() {
      await mounted({ getBrief: async () => ({ ...DISPLAY, matching: { ...DISPLAY.matching, effectiveMode: 'continuation' } }) }, async ({ window }) => {
        const style = window.document.createElement('style');
        style.textContent = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
        window.document.head.append(style);
        const section = window.document.querySelector('.prepared-answer-recall');
        const children = [...section.children];
        const visual = [...children].sort((left, right) => Number(window.getComputedStyle(left).order || 0) - Number(window.getComputedStyle(right).order || 0));
        const bullets = section.querySelector('.spoken-bullets');
        const headline = section.querySelector('h2');
        const example = section.querySelector('.spoken-example');
        assert(window.getComputedStyle(section).display === 'flex' && window.getComputedStyle(section).flexDirection === 'column', 'the regression must exercise the continuation flex layout');
        assert(visual.indexOf(bullets) < visual.indexOf(headline) && visual.indexOf(headline) < visual.indexOf(example), 'the action cues must lead, followed by the recall headline and then Concrete example');
        assert(!example.open && example.textContent.includes(CARD.example.text), 'ordering must preserve the original collapsed concrete example and its evidence');
      });
    },
  },
  {
    name: 'interview answer sections: approximate fallback stays visible and a new question collapses extension again',
    async run() {
      await mounted({}, async ({ window, act, update }) => {
        await act(() => window.document.querySelector('.optional-extension summary').click());
        assert(window.document.querySelector('.optional-extension').open, 'the prior question can have its extension open');
        await act(() => update({ ...DISPLAY, question: 'What did you learn?', matching: { ...DISPLAY.matching, approximate: true } }));
        const status = window.document.querySelector('.approximate-match');
        assert(status?.getAttribute('role') === 'status' && status.textContent === 'Approximate · fallback matching', 'the deterministic fallback must have a visible approximate label');
        assert(!window.document.querySelector('.optional-extension').open, 'a new question must not inherit an expanded secondary section');
        await act(() => update({ ...DISPLAY, answerCard: { ...CARD, optionalExtension: [] } }));
        const prepared = window.document.querySelector('[aria-label="Your prepared answer"]');
        assert(!window.document.querySelector('.optional-extension') && !window.document.body.textContent.includes('No additional grounded points'), 'a card with no extension must omit the optional section and absence filler');
        assert(prepared.querySelector('.spoken-example').textContent.includes(CARD.example.text), 'the existing card example belongs to the prepared answer when no extension exists');
        let copied;
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        await act(() => [...window.document.querySelectorAll('button')].find(button => button.textContent === 'Copy answer').click());
        assert(!copied.includes('Optional extension') && !copied.includes('Optional, bring in only') && copied.includes(`Concrete example: ${CARD.example.text}`), 'copy must omit the empty section and keep the grounded example in the prepared answer');
      });
    },
  },
];
