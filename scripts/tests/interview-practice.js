import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { withTimeout } from './fixtures/practice-connector/harness.js';
import { PRACTICE_CODE_RE, newPracticeCode, orderPracticeQuestions, practiceCodeHash, validatePracticeFeedback } from '../../electron/ipc/interviewQaPractice.js';
import { findInterviewPracticeSession, listInterviewPracticeSessions, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPractice, saveInterviewPracticeSession } from '../../electron/ipc/interviewQaStore.js';
import { createInterviewPracticeRegistry } from '../../electron/ipc/interviewPracticeRegistry.js';

async function userData(run) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-'));
  try { await run(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
const feedbackPayload = code => ({
  session: code, overall: { score: 7, summary: 'Solid call; the opening was stiff.' },
  planned: [{ question: 'Tell me about yourself.', asked: true, askedAs: 'Walk me through your path so far.', score: 8, covered: 'Hit the headline and the example.', adapted: 'Adjusted fine.', improve: 'Tighten the ending.', extension: 'Mention the on-call rotation you ran.' }, { question: 'Why Discord?', asked: false, score: 1 }],
  moments: [{ kind: 'curveball', prompt: 'If voice went down tomorrow, what would you ship?', score: 5, note: 'Froze for a bit.' }],
  communication: { pace: 'Good', filler: 'Many "like"s' }, priorities: ['Curveballs', 'Shorter intro'],
  transcript: [{ role: 'interviewer', text: 'Hi, can you hear me?' }, { role: 'candidate', text: 'Loud and clear.' }],
});

export default [
  { name: 'practice feedback: bounded, typed, and rejected with a reason the chat can fix', async run() {
    const ok = validatePracticeFeedback(feedbackPayload('PRACTICE-X'));
    assert.equal(ok.overall.score, 7); assert.equal(ok.planned.length, 2); assert.equal(ok.planned[1].askedAs, ''); assert.equal(ok.moments[0].kind, 'curveball');
    assert.equal(ok.planned[0].extension, 'Mention the on-call rotation you ran.'); assert.equal(ok.planned[1].extension, '');
    assert.equal(ok.planned[1].score, null, 'a placeholder score on an unasked question is dropped');
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), planned: [{ question: 'q', asked: true, extension: 'x'.repeat(601) }] }), /planned\[0\]\.extension/u);
    assert.deepEqual(ok.communication, { pace: 'Good', clarity: '', structure: '', confidence: '', filler: 'Many "like"s' });
    assert.equal(ok.transcript.length, 2);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), overall: { score: 11, summary: 's' } }), /overall\.score/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), moments: [{ kind: 'rant', prompt: 'x' }] }), /moments\[0\]\.kind/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), priorities: ['a', 'b', 'c', 'd', 'e', 'f'] }), /priorities/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), overall: { score: 5, summary: 'bad\u0007char' } }), /overall\.summary/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), planned: [{ asked: true }] }), /planned\[0\]/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), transcript: [{ role: 'user', text: 'x' }] }), /transcript\[0\]\.role/u);
  } },
  { name: 'practice feedback: optional callId and delivery notes validate, and bad values are rejected', async run() {
    const base = validatePracticeFeedback(feedbackPayload('PRACTICE-X'));
    assert.deepEqual(Object.keys(base), ['overall', 'planned', 'moments', 'communication', 'priorities', 'transcript'], 'an existing payload keeps exactly its old keys');
    const ok = validatePracticeFeedback({ ...feedbackPayload('PRACTICE-X'), callId: 'call-3_A', delivery: {
      summary: ' Steady at 130 words per minute. ', pace: ' 130 words per minute ', pauses: 'Two over a second', fillers: 'Four, down from nine',
      confidence: 'Even', interruptions: 'One', typedAnswers: 'One typed number', fillerCount: 4, wordsPerMinute: 130.5,
    } });
    assert.equal(ok.callId, 'call-3_A');
    assert.deepEqual(ok.delivery, { summary: 'Steady at 130 words per minute.', pace: '130 words per minute', pauses: 'Two over a second', fillers: 'Four, down from nine', confidence: 'Even', interruptions: 'One', typedAnswers: 'One typed number', fillerCount: 4, wordsPerMinute: 130.5 });
    assert.deepEqual(validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 'Fine.' } }).delivery, { summary: 'Fine.' }, 'everything but the summary is optional');
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), callId: 'bad id' }), /callId/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), callId: 'x'.repeat(65) }), /callId/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), callId: 7 }), /callId/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: {} }), /delivery\.summary/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', fillerCount: -1 } }), /delivery\.fillerCount/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', fillerCount: 1.5 } }), /delivery\.fillerCount/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', wordsPerMinute: 'fast' } }), /delivery\.wordsPerMinute/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: { summary: 's', pace: 'x'.repeat(5000) } }), /delivery\.pace/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), delivery: 'fine' }), /delivery must be an object/u);
  } },
  { name: 'practice store: planned order, armed session found by code hash, feedback with history', async run() {
    await userData(async dir => {
      await saveInterviewPractice({ userDataPath: dir, nodeId: 'h', practice: { order: ['Tell me about yourself.', 'Why Discord?', 'bad\u0001'] } });
      let saved = await loadInterviewPractice({ userDataPath: dir, nodeId: 'h' });
      assert.deepEqual(saved.order, ['Tell me about yourself.', 'Why Discord?']); assert.equal(saved.session, null);
      assert.equal(await loadInterviewPractice({ userDataPath: dir, nodeId: 'nobody' }), null);
      const hash = practiceCodeHash('PRACTICE-A');
      await saveInterviewPracticeSession({ userDataPath: dir, nodeId: 'h', session: { codeHash: hash, status: 'armed', armedAt: new Date().toISOString(), company: 'Discord' } });
      const found = await findInterviewPracticeSession({ userDataPath: dir, codeHash: hash });
      assert.equal(found.nodeId, 'h'); assert.equal(found.session.status, 'armed');
      assert.equal(await findInterviewPracticeSession({ userDataPath: dir, codeHash: practiceCodeHash('PRACTICE-B') }), null);
      await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: validatePracticeFeedback(feedbackPayload('x')), receivedAt: '2026-10-30T01:00:00.000Z' });
      await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: { ...validatePracticeFeedback(feedbackPayload('x')), overall: { score: 9, summary: 'Better.' } }, receivedAt: '2026-10-30T02:00:00.000Z' });
      saved = await loadInterviewPractice({ userDataPath: dir, nodeId: 'h' });
      assert.equal(saved.feedback.overall.score, 9); assert.equal(saved.history.length, 1); assert.equal(saved.history[0].overall.score, 7);
      assert.equal(saved.session.status, 'finished'); assert.deepEqual(saved.order, ['Tell me about yourself.', 'Why Discord?'], 'the plan survives feedback');
      assert.equal(saved.feedback.session.company, 'Discord');
      assert.equal(await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: validatePracticeFeedback(feedbackPayload('x')), codeHash: hash }), null, 'a finished session refuses a second write for its code');
      assert.equal((await listInterviewPracticeSessions({ userDataPath: dir })).length, 1);
    });
  } },
  { name: 'practice registry: arm once, accept feedback once, refuse unknown, duplicate and expired codes', async run() {
    await userData(async dir => {
      let clock = Date.parse('2026-10-30T10:00:00Z');
      let scans = 0;
      const counted = { listInterviewPracticeSessions: async args => { scans += 1; return listInterviewPracticeSessions(args); }, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPracticeSession, updateInterviewPracticeSession: (await import('../../electron/ipc/interviewQaStore.js')).updateInterviewPracticeSession };
      const registry = createInterviewPracticeRegistry({ userDataPath: dir, now: () => clock, store: counted });
      const events = []; registry.subscribe(event => events.push(event));
      const code = await registry.arm({ nodeId: 'h', company: 'Discord', role: 'PE', questionCount: 2 });
      assert.match(code, PRACTICE_CODE_RE);
      assert.equal((await registry.check(code)).status, 'armed');
      assert.equal((await registry.check('PRACTICE-ZZZZZZZZZZZZZZZZZZZZ')).status, 'unknown');
      for (let index = 0; index < 20; index += 1) await registry.check(`PRACTICE-${'Q'.repeat(19)}${'ABCDEFGHJKLMNPQRSTUV'[index]}`);
      assert.equal(scans, 1, 'unknown codes never make the store rescan the disk');
      await assert.rejects(registry.arm({ nodeId: 'h' }), /already in progress/u);
      assert.equal((await registry.status('h')).session.status, 'armed');
      assert.equal((await registry.status('h')).session.codeHash, undefined, 'the renderer view never carries the code hash');
      const rejected = await registry.finish(code, { overall: {} });
      assert.equal(rejected.status, 'rejected'); assert.match(rejected.note, /overall/u);
      assert.equal((await registry.finish('PRACTICE-ZZZZZZZZZZZZZZZZZZZZ', { overall: {} })).status, 'unknown_session', 'an unknown code is reported before the payload is judged');
      const race = await Promise.all([registry.finish(code, feedbackPayload(code)), registry.finish(code, feedbackPayload(code))]);
      assert.deepEqual(race.map(item => item.status).sort(), ['accepted', 'duplicate'], 'two racing finishes store exactly once');
      assert.match(race.find(item => item.status === 'accepted').note, /Stay in character/u, 'the accepted note keeps the interviewer in character');
      assert.equal((await registry.finish(code, feedbackPayload(code))).status, 'duplicate');
      assert.deepEqual(events.map(event => event.kind), ['armed', 'feedback']);
      assert.equal((await registry.status('h')).history.length, 0);
      const view = await registry.status('h');
      assert.equal(view.session.status, 'finished'); assert.equal(view.feedback.overall.score, 7);
      // A second registry (app restart) still resolves a persisted session from disk.
      const other = createInterviewPracticeRegistry({ userDataPath: dir, now: () => clock });
      const code2 = await registry.arm({ nodeId: 'h', company: 'Discord' });
      assert.equal((await other.check(code2)).status, 'armed');
      clock += 4 * 60 * 60_000;
      assert.equal((await other.check(code2)).status, 'expired');
      assert.equal((await other.finish(code2, feedbackPayload(code2))).status, 'expired');
      const code3 = await registry.arm({ nodeId: 'h' });
      await registry.cancel('h');
      assert.equal((await registry.finish(code3, feedbackPayload(code3))).status, 'cancelled');
      // A late cancel (stale UI) never overwrites a finished session.
      const code4 = await registry.arm({ nodeId: 'h' });
      assert.equal((await registry.finish(code4, feedbackPayload(code4))).status, 'accepted');
      const late = events.length;
      await registry.cancel('h');
      assert.equal((await registry.status('h')).session.status, 'finished', 'cancel after finish keeps the finished session');
      assert.equal(events.length, late, 'no cancelled notification for a finished session');
      assert.equal((await registry.finish(code4, feedbackPayload(code4))).status, 'duplicate');
    });
  } },
  { name: 'practice feedback view: memorized answer first, optional extension second and only when present', async run() {
    await withDom(async window => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-render-'));
      const entry = path.join(directory, 'PracticeProbe.jsx');
      const controller = new AbortController();
      let bundle;
      try {
        await fs.promises.writeFile(entry, `import React from 'react';\nimport { FeedbackView } from ${JSON.stringify(path.resolve('src/components/InterviewPracticePanel.jsx'))};\nexport function PracticeProbe({ feedback }) { return <FeedbackView feedback={feedback} />; }\n`);
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PracticeProbe, { feedback: validatePracticeFeedback(feedbackPayload('x')) })); await new Promise(resolve => setTimeout(resolve, 0)); });
        const view = window.document.querySelector('[data-testid="practice-feedback"]');
        const memorized = [...view.querySelectorAll('section[aria-label="Memorized answer"]')];
        const extensions = [...view.querySelectorAll('details.practice-extension')];
        assert.equal(memorized.length, 2, 'every planned question gets a memorized-answer section');
        assert.equal(extensions.length, 1, 'only the question with extension material gets the optional section');
        assert.ok(memorized[0].textContent.includes('Hit the headline and the example.'));
        assert.ok(extensions[0].textContent.includes('Mention the on-call rotation you ran.'));
        assert.ok(extensions[0].textContent.includes('Say this only if you can back it with a real example.'));
        assert.ok(memorized[0].compareDocumentPosition(extensions[0]) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the memorized section comes before the optional extension');
        assert.ok(extensions[0].closest('li') === memorized[0].closest('li'), 'both sections belong to the same question');
        assert.ok(view.textContent.indexOf('Work on first') < view.textContent.indexOf('Memorized answer'), 'priorities lead the report');
        await bundle.module.act(async () => { root.unmount(); });
      } finally { controller.abort(); await bundle?.dispose(); await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  } },
  { name: 'practice panel source: the Claude-chat practice UI and its IPC are gone, the in-app call and feedback view stay', async run() {
    const source = await fs.promises.readFile(path.resolve('src/components/InterviewPracticePanel.jsx'), 'utf8');
    assert.equal(source.includes('Practice in Claude chat'), false, 'no Claude-chat practice heading');
    assert.equal(source.includes('Start practice interview'), false, 'no Claude-chat start button');
    assert.equal(source.includes('onInterviewPracticeUpdated'), false, 'no Claude-chat subscription');
    assert.equal(source.includes('connectorUrl'), false, 'no connector URL box');
    assert.doesNotMatch(source, /\b(?:load|cancel|start)InterviewPractice\b/u, 'the panel never calls the Claude-chat IPC');
    assert.equal(/import \{[^}]*\bCopy\b[^}]*\} from 'lucide-react'/u.test(source), false, 'the unused Copy icon import is gone');
    assert(source.includes('Start practice call'), 'the in-app call button stays');
    assert(source.includes('Past calls'), 'past calls stay');
    assert.match(source, /export function FeedbackView/u, 'FeedbackView keeps its named export');
    assert.match(source, /export default InterviewPracticePanel/u);
  } },
  { name: 'practice panel render: the call starts with no connector, no Claude-chat API and no session', async run() {
    await withDom(async window => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-panel-'));
      const entry = path.join(directory, 'PracticePanelProbe.jsx');
      const controller = new AbortController();
      let bundle;
      try {
        await fs.promises.writeFile(entry, `import React from 'react';\nimport { InterviewPracticePanel } from ${JSON.stringify(path.resolve('src/components/InterviewPracticePanel.jsx'))};\nexport function PanelProbe(props) { return <InterviewPracticePanel {...props} />; }\n`);
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
        const started = [];
        window.electronAPI = { startPracticeCall: async args => { started.push(args); return { success: true }; } };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const props = { nodeId: 'helper-1', briefRecordId: 'c'.repeat(64), snapshotId: 'd'.repeat(64), canonicalJobUrl: 'https://jobs.example/1', ready: true };
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PanelProbe, props)); await new Promise(resolve => setTimeout(resolve, 0)); });
        const panel = () => window.document.querySelector('section[aria-label="Practice interview"]');
        assert.ok(panel(), 'the panel renders when only the in-app call API exists');
        assert.equal(panel().textContent.includes('Practice in Claude chat'), false, 'no Claude-chat practice UI is rendered');
        const button = [...panel().querySelectorAll('button')].find(item => item.textContent.trim() === 'Start practice call');
        assert.ok(button, 'the Start practice call button renders');
        assert.equal(button.disabled, false, 'the call is not gated on connector readiness or a Claude-chat session');
        await bundle.module.act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
        assert.equal(started.length, 1, 'clicking the button starts the in-app call');
        assert.equal(started[0].nodeId, 'helper-1'); assert.equal(started[0].canonicalJobUrl, 'https://jobs.example/1');
        delete window.electronAPI.startPracticeCall;
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PanelProbe, props)); await new Promise(resolve => setTimeout(resolve, 0)); });
        assert.equal(panel(), null, 'without the in-app call API there is nothing to practise');
        await bundle.module.act(async () => { root.unmount(); });
      } finally { controller.abort(); await bundle?.dispose(); await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  } },
  { name: 'practice codes: one-shot, well formed and stored only as a hash', async run() {
    const code = newPracticeCode();
    assert.match(code, PRACTICE_CODE_RE);
    assert.notEqual(newPracticeCode(), code, 'every run arms a fresh one-shot code');
    assert.notEqual(practiceCodeHash(code), code, 'the code is never stored in the clear');
    assert.notEqual(practiceCodeHash(code), practiceCodeHash(newPracticeCode()), 'a hash names exactly one code');
  } },
  { name: 'practice plan order: saved order first, then any card the plan does not know yet', async run() {
    const ordered = orderPracticeQuestions([{ question: 'B?' }, { question: 'A?' }, { question: 'a?' }, { question: 'C?' }], ['A?', 'Missing?', 'C?']);
    assert.deepEqual(ordered.map(card => card.question), ['A?', 'C?', 'B?']);
  } },
];
