import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glanceCueOf, withoutRecentEmployer } from '../../src/utils/interviewGlanceCue.js';
import { approachReminderFailure, generateInterviewApproaches, interviewApproachPrompt } from '../../electron/ipc/interviewAnswerApproach.js';
import { interviewAnswerBankPrompt, interviewLastRole } from '../../electron/ipc/interviewAnswerBank.js';
import { fillInterviewQaApproaches, fillInterviewQaFromPreparation, loadInterviewQa, loadInterviewQaLiveCards, addInterviewQaCard, saveInterviewQaCard } from '../../electron/ipc/interviewQaStore.js';
import { attachInterviewLiveCards, cardsOf, projectInterviewDisplay } from '../../electron/interviewWindow.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';

const HEADLINE = 'As Engineer at Acme School, I split the reporting rebuild into weekly releases.';
const statement = text => ({ text, evidenceIds: ['career-1'], quotes: [] });
const card = () => ({ id: 'pressure', question: 'How do you work under pressure?', variants: [], headline: statement(HEADLINE),
  bullets: [{ stage: 'point', ...statement('At Acme School, I fixed the failing import first.') }], example: statement('We tested it.'), extensions: [],
  consistency: { consistentWithResume: false, resumeQuote: '' }, thinEvidence: true });
const role = (roleId, employer, endDate, startDate = '2019-01') => ({ kind: 'career', id: `career-${roleId}`, roleId, text: `Built reporting tools at ${employer}.`,
  roleContext: { title: 'Engineer', employer, startDate, endDate } });
async function userData(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-approach-'));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

export default [
  { name: 'interview approach: a reminder is generic practice and can never describe the candidate', run() {
    assert.equal(approachReminderFailure('Split work into small tasks'), null);
    assert.equal(approachReminderFailure('Ask what matters most first.'), null, 'a final period is tolerated and removed');
    for (const refused of ['I split work into small tasks', 'Say how we shipped it', 'Cut the backlog by 40 percent', 'Use Jira for every task', 'Prioritize', 'Plan first; then act',
      'Break the work down into many very small separate pieces every time', 'Line one\nline two', '']) {
      assert.notEqual(approachReminderFailure(refused), null, `${JSON.stringify(refused)} must be refused`);
    }
  } },
  { name: 'interview approach: the model may only point at an existing prepared line as the example', async run() {
    const units = [{ id: 'a', question: 'How do you work under pressure?', lines: [{ id: 'headline[0]', text: HEADLINE }, { id: 'example[0]', text: 'We tested it.' }] },
      { id: 'b', question: 'Walk me through a project.', lines: [] }, { id: 'c', question: 'How do you handle disagreement?', lines: [] }];
    const prompts = [];
    const kept = await generateInterviewApproaches({ units, callText: async (prompt, options) => {
      prompts.push({ prompt, options });
      return { cards: [
        { id: 'a', reminders: [{ text: 'Split work into small tasks.', exampleLine: 'headline[0]' }, { text: 'Fix the riskiest part first', exampleLine: 'headline[0]' },
          { text: 'I stayed calm at Acme', exampleLine: '' }, { text: 'Say what will slip', exampleLine: 'made-up' }, { text: 'Check in with the team', exampleLine: '' }] },
        { id: 'b', reminders: [] },
        { id: 'c', reminders: [{ text: 'Listen before answering', exampleLine: '' }, { text: 'We agreed in 2 days', exampleLine: '' }] },
        { id: 'unknown', reminders: [{ text: 'Ask a clear question', exampleLine: '' }, { text: 'Name the tradeoff', exampleLine: '' }] },
      ] };
    } });
    assert.deepEqual(kept.get('a'), [{ text: 'Split work into small tasks', example: HEADLINE }, { text: 'Fix the riskiest part first', example: '' }, { text: 'Say what will slip', example: '' }],
      'a line is used once, a made-up id links nothing, a first-person reminder is dropped, and at most three are kept');
    assert.deepEqual(kept.get('b'), [], 'a question that is not about how the person works gets none');
    assert.deepEqual(kept.get('c'), [], 'a single surviving reminder is not an approach');
    assert(!kept.has('unknown'));
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].options.claudeStage, 'qa-approach-reminders');
    assert(prompts[0].prompt === interviewApproachPrompt(units) && prompts[0].prompt.includes(HEADLINE) && /NEVER describe the candidate/u.test(prompts[0].prompt));
  } },
  { name: 'interview approach: reminders are saved once per card, survive a refill, and follow the person\'s edits', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: { cards: [card()], evidence: [role('r1', 'Old Health', '2021-06'), role('r2', 'Acme School', '2024-08')] } });
      const asked = [];
      const first = await fillInterviewQaApproaches({ userDataPath: dir, nodeId: 'h', generate: async units => {
        asked.push(...units);
        return new Map(units.map(unit => [unit.id, [{ text: 'Split work into small tasks', example: HEADLINE }, { text: 'Say what will slip', example: 'A line that is not on the card.' }]]));
      } });
      assert.deepEqual(first, { requested: 1, saved: 1 });
      assert.deepEqual(asked[0].lines.map(line => line.id), ['headline[0]', 'bullets[0]', 'example[0]']);
      const [stored] = await loadInterviewQaLiveCards({ userDataPath: dir, nodeId: 'h' });
      assert.deepEqual(stored.approach, [{ text: 'Split work into small tasks', example: HEADLINE }, { text: 'Say what will slip', example: '' }], 'an example that is not a current line of the card is not kept');
      assert.equal(stored.recentEmployer, 'Acme School', 'the most recent employer is remembered for the live card');
      const qa = await loadInterviewQa({ userDataPath: dir, nodeId: 'h' });
      const shown = [...qa.foundation.cards, ...qa.company.cards][0];
      assert.deepEqual(shown.approach, stored.approach);
      assert.equal(shown.recentEmployer, 'Acme School');
      const again = await fillInterviewQaApproaches({ userDataPath: dir, nodeId: 'h', generate: async () => { throw new Error('every card was already considered'); } });
      assert.deepEqual(again, { requested: 0, saved: 0 });
      // The person's own list replaces the generated one, and an emptied list stays empty.
      await saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: shown.scope, card: { ...shown, approach: [{ text: 'My own reminder', example: '' }, { text: '  ', example: '' }] } });
      assert.deepEqual((await loadInterviewQaLiveCards({ userDataPath: dir, nodeId: 'h' }))[0].approach, [{ text: 'My own reminder', example: '' }]);
      await saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: shown.scope, card: { ...shown, approach: [] } });
      const cleared = await fillInterviewQaApproaches({ userDataPath: dir, nodeId: 'h', generate: async () => { throw new Error('a cleared list must not be refilled'); } });
      assert.deepEqual(cleared, { requested: 0, saved: 0 });
      // A question the person adds themself, with no answer, gets reminders on the next Prepare.
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'How do you handle stress?' } });
      const added = await fillInterviewQaApproaches({ userDataPath: dir, nodeId: 'h', generate: async units => new Map(units.map(unit => [unit.id, [{ text: 'Name the pressure aloud', example: '' }, { text: 'Pick one next step', example: '' }]])) });
      assert.deepEqual(added, { requested: 1, saved: 1 });
      assert.deepEqual((await loadInterviewQaLiveCards({ userDataPath: dir, nodeId: 'h' })).find(item => item.question === 'How do you handle stress?').approach.map(item => item.text), ['Name the pressure aloud', 'Pick one next step']);
    });
  } },
  { name: 'interview approach: reminders and the recent employer reach the live window without changing the sealed card', run() {
    const fixture = createInterviewWindowE2EFixture();
    const sealed = fixture.bank.cards.find(item => item.id === 'leadership');
    const stored = { ...structuredClone(sealed), approach: [{ text: 'Give credit by name', example: sealed.headline.text }], recentEmployer: 'Acme School' };
    attachInterviewLiveCards(fixture.bank, fixture.bank.cards.map(item => (item.id === 'leadership' ? stored : structuredClone(item))));
    assert.equal(cardsOf(fixture.bank).find(item => item.id === 'leadership'), sealed, 'reminders must not turn an unedited card into an edited one');
    const shown = projectInterviewDisplay({ brief: fixture.brief, snapshotId: fixture.snapshot.snapshotId, currentStep: 0, answerBank: fixture.bank,
      answerCard: cardsOf(fixture.bank).find(item => item.id === 'leadership') }).answerCard;
    assert.deepEqual(JSON.parse(JSON.stringify(shown.approach)), [{ text: 'Give credit by name', example: sealed.headline.text }]);
    assert.equal(shown.recentEmployer, 'Acme School');
  } },
  { name: 'interview last role: the most recent role leads the choices and the prompt, and its employer is left unsaid on the card', run() {
    assert.deepEqual(interviewLastRole([role('r1', 'Old Health', '2021-06'), role('r2', 'Acme School', '2024-08')]), { roleId: 'r2', employer: 'Acme School', title: 'Engineer' });
    assert.equal(interviewLastRole([role('r1', 'Old Health', '2021-06'), role('r2', 'Now Co', 'Present')]).roleId, 'r2');
    assert.equal(interviewLastRole([role('r1', 'Old Health', '2021-06'), role('r2', 'Now Co', '')]).roleId, 'r2', 'a started role with no end date is the current one');
    assert.equal(interviewLastRole([{ kind: 'research', text: 'x' }, role('r1', 'Undated', '', '')]), null);
    const evidence = [role('r1', 'Old Health', '2021-06'), role('r2', 'Acme School', '2024-08')];
    const prompt = interviewAnswerBankPrompt({ brief: { roleThemes: [] }, bundle: { listingText: '' }, evidence });
    assert(/MOST RECENT ROLE FIRST/u.test(prompt) && prompt.includes('"Engineer at Acme School"') && prompt.includes('"r2"'), 'the prompt must name the most recent role');
    const ranked = JSON.parse(/HOST RANKED SELECTION[^\n]*\n(.*)\n/u.exec(prompt)[1])[0].ranked;
    assert.deepEqual(ranked.map(item => [item.evidenceId, item.mostRecentRole === true]), [['career-r2', true], ['career-r1', false]], 'equally fitting evidence from the most recent role is offered first');
    assert(!/MOST RECENT ROLE FIRST/u.test(interviewAnswerBankPrompt({ brief: { roleThemes: [] }, bundle: { listingText: '' }, evidence: [evidence[1]] })), 'a single-role career needs no preference');
    assert.equal(glanceCueOf(HEADLINE, undefined, 'Acme School'), 'split reporting rebuild into weekly releases');
    assert.equal(glanceCueOf(HEADLINE, 'Acme School: weekly releases', 'acme school'), 'weekly releases');
    assert.equal(glanceCueOf('At Old Health, I built pipelines.', undefined, 'Acme School'), 'Old Health: built pipelines', 'an earlier role keeps its employer');
    assert.equal(withoutRecentEmployer('Acme Schools: weekly releases', 'Acme School'), 'Acme Schools: weekly releases');
    assert.equal(withoutRecentEmployer('Acme School', 'Acme School'), 'Acme School');
  } },
];
