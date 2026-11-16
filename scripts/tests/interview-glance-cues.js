import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fallbackGlanceCue, glanceCueOf } from '../../src/utils/interviewGlanceCue.js';
import { generateInterviewGlanceCues, glanceCueFailure, interviewGlanceCuePrompt, needsGlanceCue } from '../../electron/ipc/interviewAnswerCues.js';
import { fillInterviewQaCues, fillInterviewQaFromPreparation, loadInterviewQaLiveCards, saveInterviewQaCard } from '../../electron/ipc/interviewQaStore.js';
import { careerWritingStageProfile } from '../../electron/ipc/careerWritingCore.js';
import { attachInterviewLiveCards, cardsOf, projectInterviewDisplay } from '../../electron/interviewWindow.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';

const HEADLINE = 'As Software Engineer at Thompson School District, I built a full-stack web app from scratch.';
const BULLET = 'At Horizon Health Alliance, I built Python ETL pipelines that ran scanned medical documents through OCR.';
const statement = text => ({ text, evidenceIds: ['career-1'], quotes: [] });
const card = () => ({ id: 'project', question: 'Walk me through a project.', variants: [], headline: statement(HEADLINE),
  bullets: [{ stage: 'point', ...statement(BULLET) }], example: statement('We tested it.'), extensions: [{ id: 'x1', ...statement('I maintained the district reporting dashboards for about 40 schools.') }],
  consistency: { consistentWithResume: true, resumeQuote: '' }, thinEvidence: false });
async function userData(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-cues-'));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

export default [
  { name: 'interview glance cues: a line without a saved cue loses its sentence scaffolding and nothing else', run() {
    assert.equal(fallbackGlanceCue(HEADLINE), 'Thompson School District: built full-stack web app from scratch');
    assert.equal(fallbackGlanceCue(BULLET), 'Horizon Health Alliance: built Python ETL pipelines that ran scanned medical documents through OCR');
    assert.equal(fallbackGlanceCue('At Acme, we rebuilt the billing service.'), 'Acme: we rebuilt billing service', 'shared work must keep its we');
    assert.equal(fallbackGlanceCue('We tested the guide.'), 'We tested guide');
    assert.equal(fallbackGlanceCue('I am a product engineer.'), 'product engineer');
    assert.equal(glanceCueOf(HEADLINE, ' Thompson: full-stack web app '), 'Thompson: full-stack web app', 'a saved cue wins');
    assert.equal(glanceCueOf(HEADLINE, ''), fallbackGlanceCue(HEADLINE));
  } },
  { name: 'interview glance cues: a cue is kept only when it is shorter and uses only words of its own line', run() {
    assert.equal(glanceCueFailure('Thompson School District: full-stack web app, from scratch', HEADLINE), null);
    assert.equal(glanceCueFailure('Horizon: Python ETL pipelines · OCR documents', BULLET), null);
    assert.match(glanceCueFailure('Thompson: led full-stack web app', HEADLINE), /adds/u, 'a new verb is a new claim');
    assert.match(glanceCueFailure('Horizon: Python ETL, 40% faster OCR', BULLET), /adds/u, 'a new number is a new claim');
    assert.equal(glanceCueFailure('one two three four five six seven eight nine ten', HEADLINE), 'too long');
    assert.equal(glanceCueFailure('We tested it today', 'We tested it.'), 'not shorter than its line');
    assert.equal(glanceCueFailure('a\nb', HEADLINE), 'empty or multi-line');
    assert(needsGlanceCue(HEADLINE) && !needsGlanceCue('We tested it.'));
  } },
  { name: 'interview glance cues: generation keeps valid cues, drops invalid ones singly and runs on its own stage', async run() {
    const calls = [];
    const warnings = [];
    const cues = await generateInterviewGlanceCues({
      units: [{ id: 'a', text: HEADLINE }, { id: 'b', text: BULLET }, { id: 'short', text: 'We tested it.' }],
      logWarning: message => warnings.push(message),
      callText: async (prompt, opts) => { calls.push({ prompt, opts }); return { cues: [
        { id: 'a', cue: 'Thompson School District: full-stack web app' }, { id: 'b', cue: 'Horizon: led the OCR platform' },
        { id: 'unknown', cue: 'x' }, { id: 'a', cue: 'Thompson: web app' }] }; },
    });
    assert.deepEqual([...cues], [['a', 'Thompson School District: full-stack web app']]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.claudeStage, 'qa-glance-cues');
    assert(!calls[0].prompt.includes('We tested it.'), 'a line that is already short is not sent');
    assert(calls[0].prompt === interviewGlanceCuePrompt([{ id: 'a', text: HEADLINE }, { id: 'b', text: BULLET }]));
    assert.equal(warnings.length, 1);
    assert.deepEqual(careerWritingStageProfile('qa-glance-cues'), { model: 'opus', effort: 'low' });
  } },
  { name: 'interview glance cues: stored lines gain cues once, edits discard them and a changed line never takes a stale cue', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: { cards: [card()] } });
      const asked = [];
      const first = await fillInterviewQaCues({ userDataPath: dir, nodeId: 'h', wants: needsGlanceCue, generate: async units => {
        asked.push(...units);
        return new Map(units.map(unit => [unit.id, unit.text === HEADLINE ? 'Thompson: full-stack web app' : unit.text === BULLET ? 'Horizon: Python ETL, OCR' : 'dashboards, about 40 schools']));
      } });
      assert.deepEqual(first, { requested: 3, saved: 3 }, 'the short example needs no cue');
      assert(asked.every(unit => Object.keys(unit).join() === 'id,text'));
      const [stored] = await loadInterviewQaLiveCards({ userDataPath: dir, nodeId: 'h' });
      assert.equal(stored.headline.cue, 'Thompson: full-stack web app');
      assert.equal(stored.bullets[0].cue, 'Horizon: Python ETL, OCR');
      assert.equal(stored.extensions[0].cue, 'dashboards, about 40 schools');
      assert.equal(stored.example.cue, undefined);
      const second = await fillInterviewQaCues({ userDataPath: dir, nodeId: 'h', wants: needsGlanceCue, generate: async () => { throw new Error('nothing is missing'); } });
      assert.deepEqual(second, { requested: 0, saved: 0 });
      // An edit made while cues are being written: the new text keeps no cue.
      const scope = stored.scope;
      await saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope, card: { id: stored.id, question: stored.question, headline: 'My own much longer headline about the district web application work.', bullets: [], example: '' } });
      const raced = await fillInterviewQaCues({ userDataPath: dir, nodeId: 'h', wants: needsGlanceCue, generate: async units => {
        await saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope, card: { id: stored.id, question: stored.question, headline: 'A different headline written during the cue call for this card.', bullets: [], example: '' } });
        return new Map(units.map(unit => [unit.id, 'district web application']));
      } });
      assert.deepEqual(raced, { requested: 1, saved: 0 });
      const [after] = await loadInterviewQaLiveCards({ userDataPath: dir, nodeId: 'h' });
      assert.equal(after.headline.cue, undefined);
    });
  } },
  { name: 'interview glance cues: saved cues reach the live window for an unedited sealed card and for an edited one', run() {
    const fixture = createInterviewWindowE2EFixture();
    const sealed = fixture.bank.cards.find(item => item.id === 'leadership');
    const stored = structuredClone(sealed);
    stored.headline.cue = 'headline reminder';
    stored.bullets[0].cue = 'first bullet reminder';
    stored.example.cue = 'example reminder';
    const project = bank => projectInterviewDisplay({ brief: fixture.brief, snapshotId: fixture.snapshot.snapshotId, currentStep: 0, answerBank: bank,
      answerCard: cardsOf(bank).find(item => item.id === 'leadership') }).answerCard;
    attachInterviewLiveCards(fixture.bank, fixture.bank.cards.map(item => (item.id === 'leadership' ? stored : structuredClone(item))));
    assert.equal(cardsOf(fixture.bank).find(item => item.id === 'leadership'), sealed, 'a cue must not turn an unedited card into an edited one');
    const shown = project(fixture.bank);
    assert.equal(shown.headline, sealed.headline.text);
    assert.equal(shown.headlineCue, 'headline reminder');
    assert.equal(shown.bullets[0].cue, 'first bullet reminder');
    assert.equal(shown.bullets[1]?.cue, undefined);
    assert.equal(shown.example.cue, 'example reminder');
    assert(shown.optionalExtension.every(item => item.cue === undefined));
    const edited = { ...structuredClone(stored), author: 'user', headline: { text: 'My own headline.', evidenceIds: [], quotes: [], cue: 'own reminder' } };
    attachInterviewLiveCards(fixture.bank, fixture.bank.cards.map(item => (item.id === 'leadership' ? edited : structuredClone(item))));
    const overlay = project(fixture.bank);
    assert.equal(overlay.headline, 'My own headline.');
    assert.equal(overlay.headlineCue, 'own reminder');
    assert.equal(overlay.bullets[0].cue, 'first bullet reminder');
    attachInterviewLiveCards(fixture.bank, []);
    assert.equal(project(fixture.bank).headlineCue, undefined);
  } },
];
