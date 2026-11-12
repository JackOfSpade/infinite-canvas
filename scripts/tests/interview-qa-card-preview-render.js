import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { exactInterviewAnswerMatch } from '../../src/utils/interviewAnswerMatching.js';

async function flush() { await Promise.resolve(); await Promise.resolve(); }
const SNAPSHOT = 'a'.repeat(64);

const FOUNDATION = { id: 'f1', scope: 'foundation', question: 'Tell me about yourself.', variants: ['Introduce yourself.'], headline: 'I am a product engineer.', bullets: [{ stage: 'action', text: 'I shipped a dashboard.' }], example: 'I shipped a dashboard for support.', extensions: [], origin: 'catalog', source: null, author: 'generated', status: 'ready' };
const COMPANY = { id: 'c1', scope: 'company', question: 'How do you prioritize work?', variants: [], headline: 'I rank work by impact.', bullets: [{ stage: 'point', text: 'I rank by impact.' }, { stage: 'action', text: 'I wrote a ranking rubric.' }, { text: '   ' }], example: '', extensions: [], origin: 'disclosed', source: null, author: 'generated', status: 'ready' };
const FIXTURE = () => ({ foundation: { status: 'partial', cards: [FOUNDATION] }, company: { status: 'partial', company: 'Acme', cards: [COMPANY], foundationLinks: [] } });

function type(window, input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

async function withBundled(entry, run) {
  return withDom(async window => {
    const bundle = await bundleComponent(path.resolve(entry), {});
    const act = async callback => bundle.module.act(async () => { await callback(); await flush(); });
    try { return await run({ window, act, module: bundle.module }); }
    finally { await bundle.module.act(async () => { await flush(); }); await bundle.dispose(); }
  });
}

function matchingTests() {
  const nearMiss = { id: 'near', question: 'Tell me about your own goals.' };
  const cards = [FOUNDATION, COMPANY, nearMiss];
  const result = question => exactInterviewAnswerMatch(question, cards);
  return [
    {
      name: 'interview card preview: exact matching normalizes case, whitespace and a trailing question mark',
      run() {
        const matched = result('  TELL ME   about yourself?  ');
        assert(matched.status === 'match' && matched.card === FOUNDATION, `case, spacing and '?' must match the foundation card, got ${JSON.stringify(matched.status)}`);
        assert(result('introduce yourself').status === 'match' && result('Introduce yourself.').card === FOUNDATION, 'a non-empty variant must match its card');
        assert(result('how do you prioritize work?').card === COMPANY, 'the company card must match its own question');
      },
    },
    {
      name: 'interview card preview: exact matching abstains on ambiguity, misses a changed word and ignores blank questions',
      run() {
        const ambiguous = exactInterviewAnswerMatch('tell me about yourself', [FOUNDATION, { id: 'duplicate', question: 'Tell me about yourself.' }]);
        assert(ambiguous.status === 'ambiguous' && ambiguous.cards.length === 2, `two cards with the same normalized question must be ambiguous, got ${ambiguous.status}`);
        const missing = result('Tell me about yourself and your goals.');
        assert(missing.status === 'none' && missing.card === undefined, `one changed word must not match exactly, got ${missing.status}`);
        assert(result('   ').status === 'empty', 'a blank question must be empty');
        assert(result(null).status === 'empty', 'a non-string question must be empty');
      },
    },
    {
      name: 'interview card preview: the same stored id in both scopes counts as two distinct cards',
      run() {
        const shared = { id: 'shared', question: 'How do you handle conflict?' };
        const scoped = exactInterviewAnswerMatch('How do you handle conflict?', [shared, { ...shared, scope: 'company' }]);
        assert(scoped.status === 'ambiguous' && scoped.cards.length === 2 && scoped.cards[0] !== scoped.cards[1], 'matching must key distinct cards by object identity, not by id');
        const alone = exactInterviewAnswerMatch('How do you handle conflict?', [shared]);
        assert(alone.status === 'match' && alone.card === shared, 'a single card must still match on its own');
      },
    },
  ];
}

function projectionTests() {
  return [{
    name: 'interview card preview: qaCardToDisplayCard mirrors the live window projection',
    async run() {
      await withBundled('src/components/InterviewQaCardPreview.jsx', ({ module }) => {
        const card = {
          id: 'c9', question: 'How do you plan?', headline: 'I plan in weekly slices.',
          bullets: [{ stage: 'situation', text: 'Planning was ad hoc.' }, { text: 'I wrote the plan.' }, { text: '  ' }],
          example: 'I planned a launch.', extensions: [{ text: 'Extension A.' }, { text: ' ' }, { id: 'kept', text: 'Extension B.', evidenceIds: ['ev-2'] }],
          consistency: { consistentWithResume: true, resumeQuote: 'Planned launches.' },
          source: { url: 'https://jobs.example.test/plan', date: '2026-10-08', quote: 'Plan weekly.' },
          author: 'user', origin: 'catalog',
        };
        const projection = module.qaCardToDisplayCard(card, 'foundation');
        assert(projection.id === 'c9' && projection.question === 'How do you plan?', 'the card identity and question must be carried over');
        assert(projection.headline === 'I plan in weekly slices.' && JSON.stringify(projection.headlineEvidenceIds) === '[]', 'a string headline must project as text with no citations');
        const bullets = JSON.stringify(projection.bullets);
        assert(bullets === JSON.stringify([{ stage: 'situation', text: 'Planning was ad hoc.', evidenceIds: [] }, { stage: 'point', text: 'I wrote the plan.', evidenceIds: [] }]), `bullets must drop blank text and default the stage to point, got ${bullets}`);
        assert(JSON.stringify(projection.example) === JSON.stringify({ text: 'I planned a launch.', evidenceIds: [] }), 'a string example must project as text with no citations');
        const extensions = JSON.stringify(projection.optionalExtension);
        assert(extensions === JSON.stringify([{ id: 'ext-1', text: 'Extension A.', exampleHook: '', sourceLabel: '', evidenceIds: [] }, { id: 'kept', text: 'Extension B.', exampleHook: '', sourceLabel: '', evidenceIds: ['ev-2'] }]), `extensions must keep stored ids and skip blanks, got ${extensions}`);
        assert(JSON.stringify(projection.consistency) === JSON.stringify({ consistentWithResume: true, resumeQuote: 'Planned launches.' }), 'consistency must be carried over');
        assert(JSON.stringify(projection.evidence) === '[]' && projection.scope === 'foundation' && projection.origin === 'catalog' && projection.author === 'user' && projection.status === 'ready', 'the editor projection has no sealed evidence and reports an answered card as ready');
        assert(JSON.stringify(projection.source) === JSON.stringify({ url: 'https://jobs.example.test/plan', date: '2026-10-08', quote: 'Plan weekly.' }), 'a stored source must be carried over');
        const empty = module.qaCardToDisplayCard({ id: 'e1', question: 'Q?', headline: '  ', bullets: [{ text: ' ' }], example: '' }, 'company');
        assert(empty.status === 'empty' && empty.scope === 'company' && empty.author === 'generated', 'an unanswered catalog card must be empty');
        const disclosed = module.qaCardToDisplayCard({ id: 'd1', question: 'Q?', origin: 'disclosed' }, 'company');
        assert(disclosed.status === 'needs-prep' && disclosed.source === null, 'an unanswered disclosed card must need prep');
        const bulletOnly = module.qaCardToDisplayCard({ id: 'b1', question: 'Q?', bullets: [{ text: 'Only bullet.' }] }, 'company');
        assert(bulletOnly.status === 'ready', 'any non-blank bullet must make the card ready');
      });
    },
  }];
}

async function withPanel(run) {
  return withDom(async window => {
    const bundle = await bundleComponent(path.resolve('src/components/InterviewQaPanel.jsx'), {});
    window.electronAPI = { loadInterviewQa: async () => FIXTURE() };
    const root = bundle.module.createRoot(window.document.getElementById('root'));
    const act = async callback => bundle.module.act(async () => { await callback(); await flush(); });
    const wait = async ms => bundle.module.act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); await flush(); });
    try {
      await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewQaPanel, { nodeId: 'interview-helper', snapshotId: SNAPSHOT })));
      await wait(10);
      return await run({ window, act, wait });
    } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
  });
}

const TESTER_LABEL = 'Preview on the interview card';
const NO_MATCH = "No exact match. The live window's AI matching may still choose a card.";

function panelTests() {
  return [{
    name: 'interview card preview: the Q&A dialog previews exact matches and the card being edited',
    async run() {
      await withPanel(async ({ window, act }) => {
        const dialog = () => window.document.querySelector('[role="dialog"]');
        const open = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Edit Q&A');
        await act(() => open.click());
        assert(dialog()?.getAttribute('aria-modal') === 'true', 'Edit Q&A must open the modal dialog');
        const tester = dialog().querySelector(`section[aria-label="${TESTER_LABEL}"]`);
        assert(tester?.querySelector('h3').textContent === TESTER_LABEL, 'the dialog must show the match tester above the sections');
        assert(tester.querySelector('p').textContent === 'Exact question and variant matching only; the live window also uses AI matching.', 'the tester must say that only exact matching is previewed');
        const status = () => tester.querySelector('p[role="status"]').textContent;
        const preview = () => tester.querySelector('[data-testid="interview-card-preview"]');
        const input = tester.querySelector('textarea[placeholder="Type the question as the interviewer would ask it"]');
        assert(input && status() === '' && !preview(), 'a blank question must show no status text and no preview');
        await act(() => type(window, input, '  introduce   yourself? '));
        assert(status() === 'Exact match: Tell me about yourself. · Foundation', `a variant must report the exact match, got ${status()}`);
        assert(preview().classList.contains('interview-window') && preview().classList.contains('interview-card-preview'), 'the preview must render inside the window-scoped preview box');
        assert(preview().querySelector('.spoken-answer h2').textContent === 'I am a product engineer.', `the preview headline must match the window, got ${preview().querySelector('.spoken-answer h2').textContent}`);
        assert(preview().querySelectorAll('.spoken-bullets li').length === 1, 'the foundation preview must show its single bullet');
        await act(() => type(window, input, 'How do you prioritize work?'));
        assert(status() === 'Exact match: How do you prioritize work? · Acme', `the company scope must be labelled, got ${status()}`);
        assert(preview().querySelectorAll('.spoken-bullets li').length === 2, 'the company preview must drop the blank bullet');
        await act(() => type(window, input, 'How do you rank ideas by effort?'));
        assert(status() === NO_MATCH, `an unmatched question must explain the exact-only result, got ${status()}`);
        assert(!preview(), 'an unmatched question must not render a preview card');
        const article = [...dialog().querySelectorAll('article')].find(item => item.getAttribute('aria-label') === 'Tell me about yourself.');
        await act(() => [...article.querySelectorAll('button')].find(item => item.textContent === 'Edit').click());
        const form = dialog().querySelector('form[aria-label="Edit Tell me about yourself."]');
        const section = form.querySelector('section[aria-label="Interview card preview"]');
        assert(section?.querySelector('h4').textContent === 'On the interview card', 'the card form must head its live preview');
        assert(section.querySelector('.spoken-answer h2').textContent === 'I am a product engineer.', 'the card form preview must start from the saved draft');
        const headline = [...form.querySelectorAll('label')].find(item => item.textContent.startsWith('Headline')).querySelector('textarea');
        await act(() => type(window, headline, 'I lead platform reliability.'));
        assert(section.querySelector('.spoken-answer h2').textContent === 'I lead platform reliability.', `the card form preview must follow the draft headline, got ${section.querySelector('.spoken-answer h2').textContent}`);
        assert(status() === NO_MATCH, 'editing a card must not change the tester question');
      });
    },
  }, {
    name: 'interview card preview: an ambiguous exact match lists the cards instead of previewing one',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/components/InterviewQaPanel.jsx'), {});
        window.electronAPI = { loadInterviewQa: async () => ({ foundation: { status: 'partial', cards: [FOUNDATION] }, company: { status: 'partial', company: 'Acme', cards: [COMPANY, { ...COMPANY, id: 'c2', question: 'Tell me about yourself.' }], foundationLinks: [] } }) };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const act = async callback => bundle.module.act(async () => { await callback(); await flush(); });
        try {
          await act(() => root.render(bundle.module.React.createElement(bundle.module.InterviewQaPanel, { nodeId: 'interview-helper', snapshotId: SNAPSHOT })));
          await bundle.module.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); await flush(); });
          await act(() => [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Edit Q&A').click());
          const tester = window.document.querySelector(`[role="dialog"] section[aria-label="${TESTER_LABEL}"]`);
          const input = tester.querySelector('textarea[placeholder="Type the question as the interviewer would ask it"]');
          await act(() => type(window, input, 'Tell me about yourself.'));
          assert(tester.querySelector('p[role="status"]').textContent === 'Matches 2 cards exactly — the live window will not pick one:', `an ambiguous question must be announced, got ${tester.querySelector('p[role="status"]').textContent}`);
          assert([...tester.querySelectorAll('li')].map(item => item.textContent).join('|') === 'Tell me about yourself.|Tell me about yourself.', 'every matching card question must be listed');
          assert(!tester.querySelector('[data-testid="interview-card-preview"]'), 'an ambiguous question must not preview any card');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  }];
}

function noteTests() {
  return [{
    name: 'interview card preview: the evidence note appears only for a card that cites evidence',
    async run() {
      await withBundled('src/components/InterviewQaCardPreview.jsx', async ({ window, act, module }) => {
        const root = module.createRoot(window.document.getElementById('root'));
        try {
          await act(() => root.render(module.React.createElement(module.InterviewCardPreview, { card: { ...FOUNDATION, headline: { text: 'Headline with a citation.', evidenceIds: ['ev-1'] } }, scope: 'foundation' })));
          const box = window.document.querySelector('[data-testid="interview-card-preview"]');
          assert(box.querySelector('.spoken-answer h2').textContent === 'Headline with a citation.', 'an object headline must project from its text');
          const note = box.parentElement.lastElementChild;
          assert(note.textContent === 'Cited evidence quotes appear in the live window.', `the evidence note must explain the quotes the editor cannot show, got ${note.textContent}`);
          await act(() => root.render(module.React.createElement(module.InterviewCardPreview, { card: FOUNDATION, scope: 'foundation' })));
          assert(!window.document.body.textContent.includes('Cited evidence quotes appear'), 'a card with no citation ids must not show the evidence note');
        } finally { await act(() => root.unmount()); }
      });
    },
  }];
}

export default [...matchingTests(), ...projectionTests(), ...noteTests(), ...panelTests()];
