import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as writeVerify from '../../electron/ipc/applicationWriteVerify.js';
import { claudeCliArgs, claudeStageProfile, CLAUDE_STAGE_PROFILES } from '../../electron/ipc/claudeApplicationRunner.js';
import {
  APPLICATION_STAGE_PROFILES, careerChangedFindingErrors, careerFactFindingErrors, careerInflationRules, careerWritingStageProfile,
} from '../../electron/ipc/careerWritingCore.js';
import { goldenDocuments, goldenFindings, goldenListing, goldenState } from '../fixtures/career-writing-core-golden-source.mjs';

// Captured from applicationWriteVerify.js / claudeApplicationRunner.js BEFORE
// the shared core extraction: application prompts and validator text must stay
// byte-identical now that they delegate to careerWritingCore.
const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/career-writing-core-golden.json', import.meta.url), 'utf8'));

export default [
  { name: 'career writing core: application fact-check and fact-correction prompts are byte-identical to the pre-extraction capture', run() {
    const cases = [['fact-check', { targetCompany: 'Discord' }], ['fact-check-nocompany', { targetCompany: '' }], ['fact-recheck', { targetCompany: 'Acme' }], ['fact-correction', {}], ['fact-correction-corrections', { corrections: ['fact-check-unchanged: b-1 still contains "x".'] }]];
    for (const [name, extra] of cases) {
      const stage = name.startsWith('fact-check') ? 'fact-check' : name.startsWith('fact-recheck') ? 'fact-recheck' : 'fact-correction';
      const prompt = writeVerify.writeVerifyPrompt({ stage, state: goldenState(writeVerify), sourcePrompt: 'SOURCE', posting: 'POSTING', hand: 'HAND', envelope: { protocol: 1 }, listingEvidence: goldenListing, ...extra });
      assert.equal(prompt, golden[name], `${name} prompt changed`);
    }
  } },
  { name: 'career writing core: application finding validators and transitions keep their exact error text', run() {
    const docs = goldenDocuments();
    assert.deepEqual(writeVerify.writeVerifyFactFindingErrors(goldenFindings, docs), golden.findingErrors);
    assert.deepEqual([undefined, null, 'x'].map(value => writeVerify.writeVerifyFactFindingErrors(value, docs)), golden.findingErrorsShape);
    assert.deepEqual(writeVerify.writeVerifyFactFindingErrors(Array.from({ length: 25 }, () => ({ id: 'zz', claim: 'c', reason: 'r' })), docs), golden.findingErrorsMany);
    assert.deepEqual(writeVerify.writeVerifyChangedFindingErrors([{ id: 'b-1', claim: 'Built reliable services.' }, { id: 'b-1', claim: 'gone' }, { id: 'nope', claim: 'x' }], docs), golden.changedErrors);
    assert.deepEqual([[0, false, 0, 2], [0, true, 0, 2], [2, true, 0, 2], [2, true, 1, 2], [1, true, 0, 3]].map(([priorRound, failed, factIndex, rankedCount]) => writeVerify.factCorrectionTransition({ priorRound, failed, factIndex, rankedCount })), golden.transitions);
  } },
  { name: 'career writing core: application stage profiles and CLI arguments are unchanged; Q&A stages are additive', run() {
    for (const [stage, profile] of Object.entries(golden.stageProfiles)) assert.deepEqual(claudeStageProfile(stage), profile, stage);
    assert.deepEqual(claudeCliArgs({}), golden.cliArgs);
    assert.deepEqual(claudeCliArgs({ model: 'opus', effort: 'xhigh', sessionId: 's1' }), golden.cliArgsOpus);
    const research = claudeCliArgs({ model: 'opus', effort: 'high', tools: 'WebSearch,WebFetch' });
    assert.deepEqual(research.slice(research.indexOf('--tools'), research.indexOf('--tools') + 4), ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'], 'research tools are offered and allowed; nothing else');
    assert(!golden.cliArgs.includes('--allowedTools'), 'application runs never allow tools');
    assert.equal(CLAUDE_STAGE_PROFILES, APPLICATION_STAGE_PROFILES, 'the application runner reads the shared table');
    assert.deepEqual(careerWritingStageProfile('qa-write'), { model: 'opus', effort: 'xhigh' });
    assert.equal(careerWritingStageProfile('qa-fact-check'), careerWritingStageProfile('fact-check'), 'Q&A checks use the application fact-check profile object');
    assert.deepEqual(careerWritingStageProfile('qa-fact-correction'), careerWritingStageProfile('fact-correction'));
  } },
  { name: 'career writing core: the shared finding contract works over any unit text lookup (interview card claims)', run() {
    const units = { 'cards[0].headline': 'I built the hub with React and Django.', 'cards[0].bullets[0]': 'We migrated the data over three months.' };
    const unitText = id => (typeof id === 'string' && Object.hasOwn(units, id) ? units[id] : null);
    assert.deepEqual(careerFactFindingErrors([], unitText), []);
    assert.deepEqual(careerFactFindingErrors([{ id: 'cards[0].headline', claim: 'I built the hub', reason: 'The source says the hub was co-built.' }], unitText), []);
    const errors = careerFactFindingErrors([{ id: 'cards[9].headline', claim: 'x', reason: 'r' }, { id: 'cards[0].bullets[0]', claim: 'We migrated the data in three months', reason: 'r' }], unitText);
    assert.match(errors[0], /^fact-finding-unit: findings\[0\]\.id "cards\[9\]\.headline" is not a unit id/u);
    assert.match(errors[1], /^fact-finding-span: findings\[1\]\.claim .* is not a verbatim span of unit cards\[0\]\.bullets\[0\]: its first 21 of 36 characters appear/u);
    assert.deepEqual(careerChangedFindingErrors([{ id: 'cards[0].headline', claim: 'I built the hub' }], unitText), ['fact-check-unchanged: cards[0].headline still contains "I built the hub".']);
    assert.match(careerInflationRules('"Discord"'), /^List only actual inflation of ownership, scope, metrics, dates, tools or employment\. .*"Discord", unless "Discord" is one of the résumé role companies\./u);
  } },
];
