import path from 'node:path';
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { fallbackGlanceCue as cue } from '../../src/utils/interviewGlanceCue.js';

const CARD = {
  id: 'guide', question: 'Tell me about a project.', headline: 'I simplified a team guide.', headlineCue: 'team guide, simplified',
  bullets: [{ text: 'I tested the revised guide with the whole team.', stage: 'action', cue: 'tested with team' }, { text: 'The team adopted the revised guide.', stage: 'result' }],
  example: { text: 'I tested the guide against a checklist.' },
  optionalExtension: [{ id: 'x', text: 'I interviewed support staff about confusing handbook steps.' }],
  evidence: [{ id: 'e1', sourceLabel: 'Saved guide project', quote: 'Private exact evidence quote.' }],
  consistency: { consistentWithResume: false, resumeQuote: 'Private resume wording.' }, thinEvidence: true,
};
const NEXT = { ...CARD, id: 'support', question: 'How do you handle support?', headline: 'I clarified a support handbook.', headlineCue: undefined,
  bullets: [{ text: 'I interviewed support staff.' }], example: { text: '' } };
const DISPLAY = { version: 1, question: '', answerCard: null, plan: null, preview: null, matching: { mode: 'auto', approximate: false },
  briefing: { role: { title: 'Engineer', company: 'Example' }, preparedQuestions: [CARD.question], preparedCards: [{ id: CARD.id, question: CARD.question }], likelyQuestions: ['A likely question?'] } };

async function flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
async function mounted(api, run) {
  await withDom(async window => {
    const bundle = await bundleComponent(path.resolve('src/interview-window/CueCardApp.jsx'), {});
    let update; let listening;
    const calls = [];
    window.interviewAPI = { getBrief: async () => DISPLAY, onBriefUpdated: callback => { update = callback; return () => { calls.push('brief-off'); }; },
      onListeningUpdated: callback => { listening = callback; return () => { calls.push('listening-off'); }; },
      startListening: async () => { calls.push('start'); return { status: 'listening' }; }, stopListening: async () => { calls.push('stop'); return { status: 'idle' }; }, ...api };
    const root = bundle.module.createRoot(window.document.getElementById('root'));
    const act = async callback => bundle.module.act(async () => { await callback(); await flush(); });
    let live = true;
    const unmount = async () => { if (live) { live = false; await act(() => root.unmount()); } };
    try {
      await act(() => root.render(bundle.module.React.createElement(bundle.module.CueCardApp)));
      await run({ window, act, calls, unmount, update: value => update(value), listening: value => listening(value) });
    } finally { await unmount(); await bundle.dispose(); }
  });
}
const main = window => window.document.querySelector('main.cue-card');
const lines = window => [...main(window).querySelectorAll('.glance-cue')].map(item => item.textContent);

export default [
  { name: 'cue card: blank until a question is recognised, then only the cues for it', async run() {
    await mounted({}, async ({ window, act, update }) => {
      assert(main(window) && main(window).textContent === '' && main(window).children.length === 0, 'before any question the card must be completely blank');
      await act(() => update({ ...DISPLAY, question: CARD.question, answerCard: CARD }));
      assert(lines(window).join('|') === ['team guide, simplified', 'tested with team', cue(CARD.bullets[1].text)].join('|'), 'the card must show the saved cue, or the trimmed line, for its first three prepared lines and no more');
      assert(main(window).textContent === lines(window).join(''), 'the card must contain no text other than its cues');
      for (const hidden of [cue(CARD.example.text), CARD.question, 'Example', 'Action', 'Result', 'Thin evidence', 'prepared answer', CARD.optionalExtension[0].text, cue(CARD.optionalExtension[0].text), 'Private', 'Listening', 'A likely question?', 'Engineer']) {
        assert(!window.document.body.textContent.includes(hidden), `the card must not show ${hidden}`);
      }
      assert(!window.document.querySelector('button, input, textarea, select, a, details, summary, nav, header, form, [role="status"], [role="alert"]'), 'the card must contain nothing to click, type into or read as status');
      const list = main(window).querySelector('ul.spoken-bullets');
      assert(!main(window).querySelector('h1, h2, h3') && [...list.children].map(item => item.className).join('|') === 'answer-headline|answer-point|answer-point' && !list.querySelector('ul'), 'lines that share no topic must be sibling bullets, never nested under the headline');
      assert(main(window).querySelector('.answer-headline > .glance-cue').title === CARD.headline, 'the full line stays available as a hover title only');
    });
  } },
  { name: 'cue card: a how-do-you-work card shows its approach reminders, nesting only the real example of each', async run() {
    const APPROACH = { ...CARD, id: 'pressure', recentEmployer: 'Acme School', headline: 'As Engineer at Acme School, I split the rebuild into weekly releases.', headlineCue: undefined,
      approach: [{ text: 'Split work into small tasks', example: 'As Engineer at Acme School, I split the rebuild into weekly releases.' }, { text: 'Say what will slip', example: 'I tested the revised guide with the whole team.' }, { text: 'Ask for help early', example: 'A line no longer on the card.' }, { text: 'A fourth reminder', example: '' }] };
    await mounted({ getBrief: async () => ({ ...DISPLAY, question: 'How do you work under pressure?', answerCard: APPROACH }) }, async ({ window, act, update }) => {
      const list = () => main(window).querySelector('ul.spoken-bullets');
      const shape = () => [...list().children].map(item => `${item.className}:${item.querySelector(':scope > .glance-cue').textContent}>${[...item.querySelectorAll('ul > li')].map(line => line.textContent).join('+')}`).join('|');
      assert(shape() === 'answer-approach:Split work into small tasks>split rebuild into weekly releases|answer-approach:Say what will slip>|answer-approach:Ask for help early>', `at most three reminders are the bullets; only the first real example nests, without the recent employer, got ${shape()}`);
      assert(!main(window).textContent.includes('tested with team'), 'prepared lines that illustrate no reminder stay off the card');
      await act(() => update({ ...DISPLAY, answerCard: { id: 'stress', question: 'How do you handle stress?', status: 'empty', headline: '', bullets: [], example: { text: '' }, approach: [{ text: 'Name the pressure aloud', example: '' }, { text: 'Pick one next step', example: '' }] } }));
      assert(lines(window).join('|') === 'Name the pressure aloud|Pick one next step', 'reminders show even when the card has no prepared answer');
      await act(() => update({ ...DISPLAY, answerCard: { ...CARD, recentEmployer: 'Acme School', headlineCue: 'Acme School: team guide', bullets: [{ text: 'At Old Health, I built pipelines.' }], example: { text: '' } } }));
      assert(lines(window).join('|') === 'team guide|Old Health: built pipelines', 'a card without reminders is flat, and only the recent employer is left unsaid');
    });
  } },
  { name: 'cue card: an unprepared question shows live talking points until a card is recognised', async run() {
    await mounted({}, async ({ window, act, update }) => {
      await act(() => update({ ...DISPLAY, question: 'Tell me about a conflict between coworkers.', answerCard: null, talkingPoints: [{ text: 'Listen actively', sub: ['Hear each person separately first'] }, 'Focus on shared goal', { text: 'Agree next steps', sub: [] }, 'A fourth point'] }));
      const top = [...main(window).querySelector('ul.spoken-bullets').children];
      assert(top.map(item => item.querySelector(':scope > .glance-cue').textContent).join('|') === 'Listen actively|Focus on shared goal|Agree next steps', 'at most three main points are shown');
      assert(top.map(item => [...item.querySelectorAll('ul > li')].map(line => line.textContent).join('+')).join('|') === 'Hear each person separately first||', 'sub points sit under their own main point');
      assert(main(window).textContent === 'Listen activelyHear each person separately firstFocus on shared goalAgree next steps' && !main(window).querySelector('button, [role="status"]'), 'the points are the only text on the card');
      await act(() => update({ ...DISPLAY, answerCard: null, talkingPoints: ['Listen actively', 'Focus on shared goal'], preview: { id: 'p1', cardId: NEXT.id, card: NEXT, confidence: 0.8, transcript: 'How do you handle' } }));
      assert(lines(window)[0] === cue(NEXT.headline) && !main(window).textContent.includes('Listen actively'), 'a recognised card replaces the points');
      await act(() => update({ ...DISPLAY, answerCard: null }));
      assert(main(window).textContent === '', 'without points an unprepared question leaves the card blank');
    });
  } },
  { name: 'cue card: a confident guess mid-question replaces the last answer at once; unmatched or unprepared questions go blank', async run() {
    await mounted({ getBrief: async () => ({ ...DISPLAY, question: CARD.question, answerCard: CARD }) }, async ({ window, act, update }) => {
      assert(lines(window)[0] === 'team guide, simplified', 'the card restores the current answer on load');
      await act(() => update({ ...DISPLAY, question: CARD.question, answerCard: CARD, preview: { id: 'p1', cardId: NEXT.id, card: NEXT, confidence: 0.8, transcript: 'How do you handle' } }));
      assert(lines(window).join('|') === [cue(NEXT.headline), cue(NEXT.bullets[0].text)].join('|') && !window.document.body.textContent.includes('80') && !window.document.body.textContent.includes('Likely'), 'the guessed card must replace the previous cues with no label or confidence');
      await act(() => update({ ...DISPLAY, question: NEXT.question, answerCard: NEXT, preview: null }));
      assert(lines(window)[0] === cue(NEXT.headline), 'locking the guessed card keeps its cues');
      await act(() => update({ ...DISPLAY, question: 'Something else entirely?', answerCard: null, plan: { status: 'unsupported', question: 'Something else entirely?', steps: [], message: 'No saved evidence.' } }));
      assert(main(window).textContent === '', 'a question with no prepared answer must leave the card blank');
      await act(() => update({ ...DISPLAY, answerCard: null, plan: { status: 'supported', question: 'Q?', currentStep: 0, steps: [{ id: 's', label: 'Achievement', cue: 'Raw saved evidence line.' }] } }));
      assert(main(window).textContent === '', 'raw saved evidence must not appear on the card');
      await act(() => update({ ...DISPLAY, answerCard: { ...CARD, status: 'empty', headline: '', bullets: [], example: { text: '' } } }));
      assert(main(window).textContent === '', 'a matched question without an answer must leave the card blank');
    });
  } },
  { name: 'cue card: listening starts on open, is retried quietly, and stops on close with no visible status', async run() {
    let attempts = 0;
    const timers = [];
    await mounted({ startListening: async () => { attempts += 1; if (attempts === 1) throw new Error('capture failed with a private path'); return { status: 'listening' }; } }, async ({ window, act, calls, listening, unmount }) => {
      assert(attempts === 1 && main(window).textContent === '', 'opening the card must start listening, and a failure must show nothing');
      const pending = window.setTimeout; void pending;
      await act(() => new Promise(resolve => { timers.push(setTimeout(resolve, 3200)); }));
      assert(attempts === 2, 'a failed start must be retried without any user action');
      await act(() => listening({ status: 'error', errorCode: 'capture-failed', message: 'Audio stopped.' }));
      assert(main(window).textContent === '' && !window.document.querySelector('[role="alert"]'), 'a mid-call failure must not put any text on the card');
      await unmount();
      await flush();
      assert(calls.includes('stop') && calls.includes('listening-off') && calls.includes('brief-off'), 'closing the card must stop listening and release its subscriptions');
    });
    for (const timer of timers) clearTimeout(timer);
  } },
  { name: 'cue card: the stylesheet carries only the card', run() {
    const css = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
    assert(!/nav|button|textarea|call-audio|coming-up|optional-extension|answer-evidence/u.test(css), 'styles for removed controls must not linger');
  } },
];
