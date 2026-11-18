import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addInterviewQaCard, deleteInterviewQaCard, fillInterviewQaFromPreparation, isAnsweredCard, isFoundationQuestion,
  loadInterviewQa, loadInterviewQaLiveCards, saveInterviewQaCard,
} from '../../electron/ipc/interviewQaStore.js';
import { groundedDisclosures, mapInterviewDisclosures, validateDisclosureMapping } from '../../electron/ipc/interviewQaDisclosures.js';
import { createInterviewClaudeTransport, firstJsonObject, interviewClaudeStage, interviewStageMayOffload, INTERVIEW_RESEARCH_MAX_TURNS } from '../../electron/ipc/interviewClaudeTransport.js';
import { PARALLEL_RESEARCH_TOOLS, PARALLEL_EXHAUSTED_CODE, parallelBlocked, parallelExhaustedError, resetParallelLimit } from '../../electron/ipc/parallelSearch.js';
import { attachInterviewLiveCards, cardsOf } from '../../electron/interviewWindow.js';
import { planInterviewPracticeOrder, validatePracticeOrder } from '../../electron/ipc/interviewQaPractice.js';
import { applyInterviewFactFindings, factCheckInterviewCards, interviewCardUnits, interviewFactCheckPrompt } from '../../electron/ipc/interviewQaFactCheck.js';

const statement = (text, evidenceIds = ['career-1']) => ({ text, evidenceIds, quotes: [] });
const card = (id, question, headline) => ({
  id, question, variants: [], headline: statement(headline), bullets: [{ stage: 'point', ...statement(`${headline} bullet`) }],
  example: statement(`${headline} example`), extensions: [], consistency: { consistentWithResume: true, resumeQuote: '' }, thinEvidence: false,
});
const bank = (...cards) => ({ cards });
async function userData(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-qa-'));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

export default [
  { name: 'interview Q&A: foundation questions are the shared set; everything else is company-specific', run() {
    assert(isFoundationQuestion('Tell me about yourself.') && isFoundationQuestion('tell me about yourself'));
    assert(!isFoundationQuestion('Why are you interested in this company?'));
    assert(!isAnsweredCard({ headline: { text: '' }, bullets: [], example: { text: '  ' } }));
    assert(isAnsweredCard({ headline: { text: '' }, bullets: [{ text: 'x' }], example: { text: '' } }));
  } },
  { name: 'interview Q&A: preparation fills foundation (global) and company stores; foundation is shared across helpers', async run() {
    await userData(async dir => {
      const first = bank(card('intro', 'Tell me about yourself.', 'I build tools.'), card('why-company', 'Why are you interested in this company?', 'Discord reaches millions.'));
      const qa = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'helper-a', bank: first, company: 'Discord' });
      assert.deepEqual(qa.foundation.cards.map(item => item.question), ['Tell me about yourself.']);
      assert.deepEqual(qa.company.cards.map(item => item.question), ['Why are you interested in this company?']);
      assert.equal(qa.company.company, 'Discord');
      assert.equal(qa.foundation.status, 'ready');
      const other = await loadInterviewQa({ userDataPath: dir, nodeId: 'helper-b' });
      assert.deepEqual(other.foundation.cards.map(item => item.headline), ['I build tools.'], 'a second helper sees the same foundation set');
      assert.deepEqual(other.company.cards, [], 'company Q&A belongs to one helper');
      const stat = await fs.promises.stat(path.join(dir, 'interview-helper-qa', 'foundation.json'));
      assert.equal(stat.mode & 0o077, 0, 'store files are private');
    });
  } },
  { name: 'interview Q&A: fill-only never replaces a non-empty answer (generated or user) and respects tombstones', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: bank(card('intro', 'Tell me about yourself.', 'Original intro.'), card('why-role', 'Why are you interested in this role?', 'Original why.'), card('lead', 'Describe your approach to leadership.', 'Original lead.')) });
      const loaded = await loadInterviewQa({ userDataPath: dir, nodeId: 'h' });
      const why = loaded.company.cards.find(item => item.question === 'Why are you interested in this role?');
      await saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { ...why, headline: 'My own why.', bullets: [{ text: 'My own bullet.' }], example: '' } });
      const lead = loaded.company.cards.find(item => item.question === 'Describe your approach to leadership.');
      await deleteInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', cardId: lead.id });
      const again = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: bank(card('intro', 'Tell me about yourself.', 'NEW intro.'), card('why-role', 'Why are you interested in this role?', 'NEW why.'), card('lead', 'Describe your approach to leadership.', 'NEW lead.'), card('pressure', 'How do you work under pressure?', 'New pressure.')) });
      assert.equal(again.foundation.cards[0].headline, 'Original intro.', 'a generated answer is kept');
      const whyAfter = again.company.cards.find(item => item.question === 'Why are you interested in this role?');
      assert.equal(whyAfter.headline, 'My own why.'); assert.equal(whyAfter.author, 'user');
      assert(!again.company.cards.some(item => item.question === 'Describe your approach to leadership.'), 'a deleted question does not come back');
      assert(again.company.cards.some(item => item.question === 'How do you work under pressure?' && item.headline === 'New pressure.'), 'a new question is added');
    });
  } },
  { name: 'interview Q&A: empty cards get filled; disclosures become variants, foundation links or needs-prep cards', async run() {
    await userData(async dir => {
      const qa0 = await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'How do you work under pressure?', variants: [], headline: '', bullets: [], example: '', extensions: [] } });
      assert.equal(qa0.cards[0].status, 'empty');
      const mapping = [
        { question: 'Tell us about yourself and your background', sourceUrl: 'https://example.test/a', sourceDate: 'unknown', evidenceQuote: 'q', target: 'foundation', cardQuestion: 'Tell me about yourself.' },
        { question: 'Why Discord?', sourceUrl: 'https://example.test/b', sourceDate: '2026', evidenceQuote: 'q2', target: 'company', cardQuestion: 'Why are you interested in this company?' },
        { question: 'Design a rate limiter for chat messages.', sourceUrl: 'https://example.test/c', sourceDate: 'unknown', evidenceQuote: 'q3', target: 'none', cardQuestion: '' },
      ];
      const qa = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: bank(card('pressure', 'How do you work under pressure?', 'I prioritize.'), card('why-company', 'Why are you interested in this company?', 'Discord reaches millions.')), disclosureMapping: mapping });
      const pressure = qa.company.cards.find(item => item.question === 'How do you work under pressure?');
      assert.equal(pressure.headline, 'I prioritize.', 'an empty card is filled'); assert.equal(pressure.author, 'generated');
      const why = qa.company.cards.find(item => item.question === 'Why are you interested in this company?');
      assert(why.variants.includes('Why Discord?') && why.origin === 'disclosed' && why.source.url === 'https://example.test/b');
      const design = qa.company.cards.find(item => item.question === 'Design a rate limiter for chat messages.');
      assert.equal(design.status, 'needs-prep'); assert.equal(design.origin, 'disclosed');
      assert.deepEqual(qa.company.foundationLinks, [{ foundationQuestion: 'Tell me about yourself.', question: 'Tell us about yourself and your background', sourceUrl: 'https://example.test/a' }]);
      assert(!qa.company.cards.some(item => item.question === 'Tell us about yourself and your background'), 'a foundation-equivalent disclosure never duplicates into company Q&A');
      // A company mapping whose card did not survive becomes a needs-prep disclosed card.
      const orphan = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', bank: bank(), disclosureMapping: [
        { question: 'Why do you want to join Acme?', sourceUrl: 'https://example.test/d', sourceDate: 'unknown', evidenceQuote: 'q4', target: 'company', cardQuestion: 'Why Acme?' }] });
      const kept = orphan.company.cards.find(item => item.question === 'Why do you want to join Acme?');
      assert(kept, 'the disclosed question is not lost'); assert.equal(kept.status, 'needs-prep'); assert.equal(kept.origin, 'disclosed');
      assert.equal(kept.source.url, 'https://example.test/d');
    });
  } },
  { name: 'interview Q&A: a filled card never reuses an id already held by a different question', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'a', bank: bank(card('c3', 'Tell me about yourself.', 'By impact.')) });
      const second = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'b', bank: bank(card('c3', 'Walk me through a project.', 'I weighed options.')) });
      const ids = second.foundation.cards.map(item => item.id);
      assert.equal(new Set(ids).size, ids.length, 'card ids stay unique');
      const decision = second.foundation.cards.find(item => item.question === 'Walk me through a project.');
      const after = await deleteInterviewQaCard({ userDataPath: dir, nodeId: 'b', scope: 'foundation', cardId: decision.id });
      assert(after.cards.some(item => item.question === 'Tell me about yourself.'), 'deleting one card keeps the other');
    });
  } },
  { name: 'interview Q&A: re-preparing for another company drops the old company generated cards but keeps the person\'s own', async run() {
    await userData(async dir => {
      await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Acme', bank: bank(card('why', 'Why are you interested in this company?', 'Acme ships fast.')),
        disclosureMapping: [{ question: 'Tell us about you', sourceUrl: 'https://example.test/a', sourceDate: 'unknown', evidenceQuote: 'q', target: 'foundation', cardQuestion: 'Tell me about yourself.' }] });
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'My own note?', headline: 'Mine.' } });
      const next = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Globex', bank: bank(card('why', 'Why are you interested in this company?', 'Globex scales.')) });
      assert.equal(next.company.cards.find(item => item.question === 'Why are you interested in this company?').headline, 'Globex scales.', 'the new company answer replaces the old one');
      assert(next.company.cards.some(item => item.question === 'My own note?'), 'the person\'s card stays');
      assert.deepEqual(next.company.foundationLinks, []);
      // A spelling variant or a placeholder for the same company changes nothing.
      const same = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Globex, Inc.', bank: bank(card('why', 'Why are you interested in this company?', 'Other text.')),
        disclosureMapping: [{ question: 'Tell us about you', sourceUrl: 'https://example.test/a', sourceDate: 'unknown', evidenceQuote: 'q', target: 'foundation', cardQuestion: 'Tell me about yourself.' }] });
      assert.equal(same.company.cards.find(item => item.question === 'Why are you interested in this company?').headline, 'Globex scales.');
      const placeholder = await fillInterviewQaFromPreparation({ userDataPath: dir, nodeId: 'h', company: 'Unknown company', bank: bank() });
      assert.equal(placeholder.company.foundationLinks.length, 1, 'a placeholder company never resets links');
      assert.equal(placeholder.company.company, 'Globex, Inc.', 'a placeholder never overwrites a real name');
    });
  } },
  { name: 'interview Q&A: editing a card to another card\'s question is refused', async run() {
    await userData(async dir => {
      await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'First question?', headline: 'A.' } });
      const both = await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'Second question?', headline: 'B.' } });
      const second = both.cards.find(item => item.question === 'Second question?');
      await assert.rejects(saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { ...second, question: 'first question' } }), /already in this section/);
    });
  } },
  { name: 'interview Q&A: user edits are bounds-checked and stored without citations', async run() {
    await userData(async dir => {
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: '' } }), /Write a question/);
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'Q?', bullets: Array.from({ length: 7 }, () => 'b') } }), /at most 6/);
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'nope', card: { question: 'Q?' } }), /section is invalid/);
      await assert.rejects(saveInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { id: 'missing', question: 'Q?' } }), /no longer exists/);
      const added = await addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'What would you change about Discord?', headline: 'Faster onboarding.', bullets: ['One'], extensions: ['Extra'] } });
      assert.match(added.cards[0].id, /^user-[a-f0-9]{12}$/u);
      await assert.rejects(addInterviewQaCard({ userDataPath: dir, nodeId: 'h', scope: 'company', card: { question: 'what would you change about discord' } }), /already in this section/);
      const live = await loadInterviewQaLiveCards({ userDataPath: dir, nodeId: 'h' });
      assert.deepEqual(live[0].headline, { text: 'Faster onboarding.', evidenceIds: [], quotes: [] });
      assert.equal(live[0].scope, 'company');
    });
  } },
  { name: 'interview Q&A disclosures: only exact research substrings survive; AI mapping must name offered cards', async run() {
    const raw = 'Glassdoor https://www.glassdoor.com/x reports: "Why Discord?" was asked in 2025. Also "Design a rate limiter."';
    const kept = groundedDisclosures({ disclosures: [
      { question: 'Why Discord?', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: '2025', evidenceQuote: '"Why Discord?" was asked', kind: 'company' },
      { question: 'Why do you want Discord?', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: '2025', evidenceQuote: 'asked', kind: 'company' },
      { question: 'Design a rate limiter.', sourceUrl: 'https://invented.test/', sourceDate: 'unknown', evidenceQuote: 'Design', kind: 'technical' },
      { question: 'Design a rate limiter.', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: 'May 9', evidenceQuote: 'Also "Design', kind: 'weird' },
    ] }, raw);
    assert.deepEqual(kept.map(item => item.question), ['Why Discord?', 'Design a rate limiter.']);
    assert.equal(kept[1].sourceDate, 'unknown'); assert.equal(kept[1].kind, 'role');
    const privateRaw = 'See https://user:tok@h.example/q?s=1 and https://h.example/q?sessionId=a#f for "Q one?" and "Q two?"';
    const privateKept = groundedDisclosures({ disclosures: [
      { question: 'Q one?', sourceUrl: 'https://user:tok@h.example/q?s=1', sourceDate: 'unknown', evidenceQuote: 'Q one?' },
      { question: 'Q two?', sourceUrl: 'https://h.example/q?sessionId=a#f', sourceDate: 'unknown', evidenceQuote: 'Q two?' },
    ] }, privateRaw);
    assert.deepEqual(privateKept.map(item => [item.question, item.sourceUrl]), [['Q two?', 'https://h.example/q']], 'credentials are dropped; query and fragment are stripped');
    const context = { disclosures: kept, foundationQuestions: ['Tell me about yourself.'], companyQuestions: ['Why are you interested in this company?'] };
    assert.throws(() => validateDisclosureMapping({ mappings: [{ index: 0, target: 'company', cardQuestion: 'Why this company?' }, { index: 1, target: 'none', cardQuestion: '' }] }, context), /mapping-card/);
    assert.throws(() => validateDisclosureMapping({ mappings: [{ index: 0, target: 'none', cardQuestion: '' }] }, context), /mapping-missing/);
    const calls = [];
    const callText = async (prompt, opts) => { calls.push(opts); return calls.length === 1
      ? { disclosures: [{ question: 'Why Discord?', sourceUrl: 'https://www.glassdoor.com/x', sourceDate: '2025', evidenceQuote: '"Why Discord?" was asked', kind: 'company' }] }
      : { mappings: [{ index: 0, target: 'company', cardQuestion: 'Why are you interested in this company?' }] }; };
    const mapped = await mapInterviewDisclosures({ rawResearch: raw, ...context, callText });
    assert.deepEqual(mapped.map(item => [item.question, item.target, item.cardQuestion]), [['Why Discord?', 'company', 'Why are you interested in this company?']]);
    assert(calls.every(opts => opts.claudeStage === 'qa-disclosures'));
    assert.deepEqual(await mapInterviewDisclosures({ rawResearch: '', ...context, callText }), [], 'no research, no disclosures');
  } },
  { name: 'interview Claude transport: application stage profiles and same-session retry on rejection', async run() {
    assert.equal(interviewClaudeStage('interview-brief-research'), 'qa-research');
    assert.equal(interviewClaudeStage('interview-answer-bank', 'qa-fact-check'), 'qa-fact-check');
    assert.equal(interviewClaudeStage('interview-answer-bank'), 'qa-write');
    assert.deepEqual(firstJsonObject('Sure: {"a":"b}"} trailing'), { a: 'b}' });
    const runs = [];
    const research = [];
    let replies = ['not json', '{"ok":false}', '{"ok":true}'];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: replies.shift(), model: 'claude-opus-5-5' }; },
      runResearchStage: async args => { research.push(args); return { text: 'Research prose with https://x.test', model: 'claude-opus-5-5' }; } });
    const value = await transport.callText('PROMPT', { task: 'interview-answer-bank', responseSchema: { type: 'object' }, responseValidator: v => { if (!v.ok) throw new Error('not ok'); } });
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(runs.map(run => [run.model, run.effort, run.resume, run.tools]), [['opus', 'medium', false, ''], ['opus', 'medium', true, ''], ['opus', 'medium', true, '']]);
    assert.equal(new Set(runs.map(run => run.sessionId)).size, 1, 'retries stay in one Claude session');
    assert.match(runs[0].text, /REPLY FORMAT: one JSON object/u);
    assert.match(runs[2].text, /^YOUR PREVIOUS REPLY WAS REJECTED BY THE APP\..*\nnot ok$/su);
    runs.length = 0;
    assert.equal(await transport.callRaw('R', { task: 'interview-brief-research' }), 'Research prose with https://x.test');
    assert.equal(runs.length, 0, 'research never runs on the built-in runStage');
    assert.deepEqual([research[0].model, research[0].effort, research[0].tools], ['opus', 'high', [...PARALLEL_RESEARCH_TOOLS]]);
    runs.length = 0; replies = ['{}'];
    await transport.callText('C', { task: 'interview-answer-bank', claudeStage: 'qa-fact-check', responseSchema: { type: 'object' } });
    assert.deepEqual([runs[0].model, runs[0].effort, runs[0].tools], ['opus', 'high', '']);
    replies = ['bad', 'bad', 'bad'];
    await assert.rejects(transport.callText('X', { task: 'interview-answer-bank', responseSchema: { type: 'object' } }), error => /no JSON object/.test(error.message) && error.code === 'VALIDATION_FAILED');
  } },
  { name: 'interview window: live Q&A overlay keeps unedited sealed cards, shows user edits, and orders by store', run() {
    const sealedIntro = card('intro', 'Tell me about yourself.', 'Sealed intro.');
    const sealedWhy = card('why', 'Why are you interested in this role?', 'Sealed why.');
    const sealed = { cards: [sealedIntro, sealedWhy], evidence: [] };
    assert.deepEqual(cardsOf(sealed), sealed.cards, 'no store means the sealed cards');
    attachInterviewLiveCards(sealed, [
      { ...structuredClone(sealedIntro), scope: 'foundation', origin: 'catalog', author: 'generated' },
      { ...structuredClone(sealedWhy), headline: { text: 'My edited why.', evidenceIds: [], quotes: [] }, scope: 'company', origin: 'catalog', author: 'user' },
      { id: 'disclosed-1', question: 'Design a rate limiter.', headline: { text: '' }, bullets: [], example: { text: '' }, scope: 'company', origin: 'disclosed', source: { url: 'https://x.test' }, author: 'generated' },
    ]);
    const live = cardsOf(sealed);
    assert.equal(live[0], sealedIntro, 'an unedited generated card is the sealed object itself');
    assert.notEqual(live[1], sealedWhy); assert.equal(live[1].headline.text, 'My edited why.');
    assert.equal(live.length, 3);
    attachInterviewLiveCards(sealed, []);
    assert.deepEqual(cardsOf(sealed), sealed.cards, 'an empty store falls back to the sealed bank');
  } },
  { name: 'interview window: live Q&A ids stay unique across scopes and an extension trimmed by the fact-check stays trimmed', run() {
    const sealedWhy = { ...card('c3', 'Why Acme?', 'Acme ships fast.'), extensions: [{ id: 'x1', text: 'It saved 80 percent.', evidenceIds: [] }] };
    const sealed = { cards: [sealedWhy], evidence: [] };
    attachInterviewLiveCards(sealed, [
      { ...card('c3', 'Tell me about yourself.', 'Another helper intro.'), scope: 'foundation', origin: 'catalog', author: 'generated' },
      { ...structuredClone(sealedWhy), extensions: [], scope: 'company', origin: 'catalog', author: 'generated' },
    ]);
    const live = cardsOf(sealed);
    assert.equal(new Set(live.map(item => item.id)).size, 2, 'live ids are unique');
    assert.equal(live.find(item => item.id === 'c3').question, 'Why Acme?', 'the card matching its sealed question keeps the contested id');
    const why = live.find(item => item.question === 'Why Acme?');
    assert.notEqual(why, sealedWhy, 'a card whose extension was removed is not swapped back to the sealed object');
    assert.deepEqual(why.extensions, []);
  } },
  { name: 'interview Q&A fact-check: shared application contract over card units; flagged claims are removed, never rewritten', async run() {
    const cards = [card('intro', 'Tell me about yourself.', 'I led the platform team.'), { ...card('proj', 'Walk me through a project.', 'I built the hub.'), extensions: [{ id: 'x1', text: 'It saved 80 percent of costs.', evidenceIds: ['career-1'] }] }];
    const units = interviewCardUnits(cards);
    assert.deepEqual([...units.keys()], ['intro.headline', 'intro.bullets[0]', 'intro.example', 'proj.headline', 'proj.bullets[0]', 'proj.example', 'proj.extensions[0]']);
    const prompt = interviewFactCheckPrompt({ cards, evidence: [{ id: 'career-1', text: 'Built the hub with the team.' }, { id: 'unused', text: 'x' }], company: 'Discord' });
    assert.match(prompt, /List only actual inflation of ownership, scope, metrics, dates, tools or employment\./u);
    assert(prompt.includes('"Discord"') && prompt.includes('Built the hub with the team.') && !prompt.includes('"unused"'));
    const cleaned = applyInterviewFactFindings(cards, [{ id: 'intro.headline', claim: 'led' }, { id: 'proj.extensions[0]', claim: '80 percent' }, { id: 'nope', claim: 'x' }]);
    assert(!isAnsweredCard(cleaned[0]), 'a flagged headline empties the answer (user fills it)');
    assert.equal(cleaned[1].headline.text, 'I built the hub.'); assert.deepEqual(cleaned[1].extensions, []);
    let attempts = 0;
    const result = await factCheckInterviewCards({ cards, evidence: [], company: 'Discord', callText: async (text, opts) => {
      attempts += 1;
      const value = { findings: [{ id: 'proj.extensions[0]', checkId: 'metrics', claim: 'It saved 80 percent of costs.', quote: '', reason: 'No quote states a cost saving.' }] };
      opts.responseValidator(value); assert.equal(opts.claudeStage, 'qa-fact-check');
      return value;
    } });
    assert.equal(attempts, 1); assert.deepEqual(result.cards[1].extensions, []); assert.equal(result.findings.length, 1);
    await assert.rejects(factCheckInterviewCards({ cards, evidence: [], company: '', callText: async (text, opts) => { const value = { findings: [{ id: 'proj.headline', checkId: 'x', claim: 'I invented', quote: '', reason: 'r' }] }; opts.responseValidator(value); return value; } }), /fact-finding-span/);
  } },
  { name: 'interview practice: AI-planned order uses every question once with the introduction first', async run() {
    const questions = ['Why are you interested in this company?', 'Tell me about yourself.', 'Design a rate limiter.'];
    assert.deepEqual(validatePracticeOrder({ order: [1, 0, 2] }, questions), [1, 0, 2]);
    assert.throws(() => validatePracticeOrder({ order: [0, 1, 2] }, questions), /order-intro/);
    assert.throws(() => validatePracticeOrder({ order: [1, 0] }, questions), /order-permutation/);
    assert.throws(() => validatePracticeOrder({ order: [1, 1, 2] }, questions), /order-permutation/);
    const prompts = [];
    const ordered = await planInterviewPracticeOrder({ questions: [...questions, 'tell me about yourself'], company: 'Discord', callText: async (prompt, opts) => {
      prompts.push(prompt); assert.equal(opts.claudeStage, 'qa-practice-order');
      assert.throws(() => opts.responseValidator({ order: [2, 1, 0] }), /order-intro/);
      return { order: [1, 0, 2] };
    } });
    assert.deepEqual(ordered, ['Tell me about yourself.', 'Why are you interested in this company?', 'Design a rate limiter.']);
    assert.match(prompts[0], /an introduction first.*closing or reflective questions last/su, 'the plan asks for a natural interview arc');
    assert.deepEqual(await planInterviewPracticeOrder({ questions: ['Only one?'], callText: async () => { throw new Error('unused'); } }), ['Only one?']);
  } },
  { name: 'interview Q&A offload: a routed qa-brief is answered by the offload call with the handoff messages', async run() {
    const runs = []; const offloads = []; const stages = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: stage => (stage === 'qa-brief' ? { route: 'deepseek-flash', reasoning: 'medium' } : null),
      offloadCall: async args => { offloads.push(args); return { text: '{"ok":true}', model: 'deepseek-v4-flash', provider: 'offload' }; },
      onStage: info => stages.push(info) });
    const value = await transport.callText('PROMPT BODY', { claudeStage: 'qa-brief' });
    assert.deepEqual(value, { ok: true });
    assert.equal(runs.length, 0, 'Claude must not run for a routed answer');
    assert.equal(offloads.length, 1);
    assert.equal(offloads[0].route, 'deepseek-flash');
    assert.equal(offloads[0].reasoning, 'medium');
    assert.equal(offloads[0].tag, 'qa-brief');
    assert.deepEqual(offloads[0].messages.map(item => item.role), ['system', 'user']);
    assert.equal(offloads[0].messages[1].content, 'PROMPT BODY');
    assert.equal(stages[0].provider, 'offload');
    assert.equal(stages[0].route, 'deepseek-flash');
    await transport.callText('OTHER', { claudeStage: 'qa-write' });
    assert.equal(runs.length, 1, 'a stage without a table entry stays on Claude');
    assert.equal(stages[1].provider, 'claude');
  } },
  { name: 'interview Q&A offload: qa-research and qa-fact-* stages never route even with a table entry', async run() {
    const runs = [];
    const research = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: '{"ok":true}', model: 'claude-parallel' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => { throw new Error('offload must not be called'); } });
    for (const stage of ['qa-research', 'qa-fact-check', 'qa-fact-verify', 'qa-answer-entailment', 'qa-card-repair']) await transport.callText('P', { claudeStage: stage });
    assert.equal(runs.length, 4, 'research is not a runStage stage any more');
    assert.equal(research.length, 1);
    assert.deepEqual(research[0].tools, [...PARALLEL_RESEARCH_TOOLS]);
    assert.deepEqual(runs.map(run => run.tools), ['', '', '', '']);
    assert.equal(interviewStageMayOffload('qa-answer-entailment'), false);
    assert.equal(interviewStageMayOffload('qa-card-repair'), false);
    assert.equal(interviewStageMayOffload('qa-fact-recheck'), false);
    assert.equal(interviewStageMayOffload('career-file-to-text'), false, 'a verbatim copy of a personal file never routes to another provider');
    assert.equal(interviewStageMayOffload('qa-disclosures'), true);
    assert.equal(interviewStageMayOffload('qa-practice-order'), true);
  } },
  { name: 'interview Claude transport: typed-job stages use their own profiles; only typed-job-research gets Parallel tools and fails when Parallel is out', async run() {
    const runs = []; const research = [];
    const make = enabled => createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => enabled },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: 'Acme research', model: 'claude-parallel' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => { throw new Error('typed-job stages with no table entry must not route here'); } });
    const transport = make(true);
    // routeFor above answers every stage, so the stages that may offload would call offloadCall; check the gate directly.
    assert.equal(interviewStageMayOffload('typed-job-research'), false, 'research never routes');
    assert.equal(interviewStageMayOffload('typed-job-intake'), true);
    assert.equal(await transport.callRaw('R', { claudeStage: 'typed-job-research', task: 'interview-typed-job-research' }), 'Acme research');
    assert.deepEqual([research[0].model, research[0].effort, research[0].tools], ['opus', 'high', [...PARALLEL_RESEARCH_TOOLS]]);
    assert.equal(runs.length, 0, 'typed-job-research never runs on the built-in runStage');
    const noRoute = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; }, routeFor: () => null });
    for (const stage of ['typed-job-intake', 'typed-job-posting', 'typed-job-listing']) await noRoute.callText('P', { claudeStage: stage, responseSchema: { type: 'object' } });
    assert.deepEqual(runs.map(run => [run.model, run.effort, run.tools]), [['haiku', 'medium', ''], ['sonnet', 'low', ''], ['opus', 'medium', '']]);
    research.length = 0;
    await assert.rejects(make(false).callRaw('R', { claudeStage: 'typed-job-research' }), error => error.code === 'PARALLEL_SEARCH_EXHAUSTED');
    assert.equal(research.length, 0, 'no research session starts when Parallel is out');
  } },
  { name: 'interview Claude transport: career-file-to-text sends page images on the first message only and never offloads', async run() {
    const runs = [];
    const images = [{ label: 'resume.png', mimeType: 'image/png', data: 'AAAA' }];
    let replies = 0;
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); replies += 1; return { text: replies === 1 ? 'not json' : '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => { throw new Error('career-file-to-text must never offload'); },
      recordSample: sample => { assert.equal(JSON.stringify(sample).includes('AAAA'), false, 'image data is never recorded'); } });
    await transport.callText('Copy the text.', { claudeStage: 'career-file-to-text', task: 'career-file-to-text', pageImages: images, responseSchema: { type: 'object' } });
    assert.deepEqual(runs.map(run => [run.model, run.effort, run.tools]), [['sonnet', 'low', ''], ['sonnet', 'low', '']]);
    assert.deepEqual(runs[0].pageImages, images);
    assert.equal(runs[1].pageImages, undefined, 'a resumed correction round carries no image again');
  } },
  { name: 'interview Q&A offload: an OFFLOAD_ error fails the call loudly with its own code and Claude never answers a routed stage', async run() {
    const runs = []; let offloadCalls = 0;
    const make = code => createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-pro', reasoning: 'high' }),
      offloadCall: async () => { offloadCalls += 1; throw Object.assign(new Error(code), { code }); } });
    await assert.rejects(() => make('OFFLOAD_PROVIDER_ERROR').callText('ORIGINAL', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_PROVIDER_ERROR');
    const credit = make('OFFLOAD_CREDIT_EXHAUSTED');
    await assert.rejects(() => credit.callText('A', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_CREDIT_EXHAUSTED');
    await assert.rejects(() => credit.callText('B', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_CREDIT_EXHAUSTED');
    assert.equal(offloadCalls, 3, 'every call asks DeepSeek; nothing is remembered as blocked');
    await assert.rejects(() => make('CLAUDE_CANCELLED').callText('C', { claudeStage: 'qa-write' }), error => error.code === 'CLAUDE_CANCELLED');
    assert.equal(runs.length, 0, 'Claude was never called');
  } },
  { name: 'interview Q&A offload: an empty offload reply fails loudly and Claude never answers a routed stage', async run() {
    const runs = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-pro', reasoning: 'high' }),
      offloadCall: async () => null });
    await assert.rejects(() => transport.callText('P', { claudeStage: 'qa-write' }), error => error.code === 'OFFLOAD_EMPTY_REPLY');
    assert.equal(runs.length, 0, 'Claude was never called');
  } },
  { name: 'interview Q&A offload: rejected offload replies are resent statelessly to DeepSeek and never escalate to Claude', async run() {
    const runs = []; const offloads = [];
    const replies = ['{"ok":false}', '{"ok":false}', '{"ok":true}'];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async args => { offloads.push(args.messages.map(item => ({ ...item }))); return { text: replies.shift(), model: 'd' }; } });
    const validator = (value) => { if (value.ok !== true) throw new Error('ok must be true'); };
    assert.deepEqual(await transport.callText('ORIGINAL', { claudeStage: 'qa-write', responseValidator: validator }), { ok: true });
    assert.equal(offloads.length, 3);
    assert.deepEqual(offloads[2].map(item => item.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    assert.equal(offloads[1][2].content, '{"ok":false}');
    assert.match(offloads[1][3].content, /REJECTED BY THE APP[\s\S]*ok must be true/u);
    assert.equal(runs.length, 0, 'Claude was never called');
    // Every reply rejected: the call ends as an exhausted validation, still without Claude.
    const never = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      routeFor: () => ({ route: 'deepseek-flash', reasoning: 'high' }),
      offloadCall: async () => ({ text: '{"ok":false}', model: 'd' }) });
    await assert.rejects(() => never.callText('ORIGINAL', { claudeStage: 'qa-write', responseValidator: validator }), /ok must be true/u);
    assert.equal(runs.length, 0);
  } },
  { name: 'interview Q&A shadow: only Claude-answered first attempts of qa-brief and qa-write are measured', async run() {
    const jobs = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      runStage: async () => ({ text: '{"ok":true}', model: 'claude-x' }),
      shadow: { enabled: true, measure: job => jobs.push(job) } });
    const validator = (value) => { if (value.ok !== true) throw Object.assign(new Error('no'), { code: 'NOT_OK' }); };
    await transport.callText('P', { claudeStage: 'qa-brief', responseValidator: validator });
    await transport.callText('P', { claudeStage: 'qa-write', responseValidator: validator });
    await transport.callText('P', { claudeStage: 'qa-fact-check', responseValidator: validator });
    assert.deepEqual(jobs.map(job => job.id), ['qa-brief', 'qa-write']);
    assert.equal(jobs[0].kind, 'qa');
    assert.equal(jobs[0].claude.outcome, 'accepted');
    assert.equal(jobs[0].messages[1].content, 'P');
    assert.deepEqual(jobs[0].validate('{"ok":true}'), { valid: true, code: null });
    assert.deepEqual(jobs[0].validate('{"ok":false}'), { valid: false, code: 'NOT_OK' });
    assert.equal(jobs[0].validate('no json').valid, false);
  } },
  { name: 'interview Claude transport: qa-research always calls runResearchStage with the six Parallel tools and MCP server', async run() {
    const runs = []; const research = []; const samples = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true, readKey: async () => 'pk-test-key-0123456789' },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: '{"ok":true}', model: 'claude-parallel' }; },
      recordSample: sample => samples.push(sample),
      routeFor: () => null });
    assert.deepEqual(await transport.callText('RESEARCH', { task: 'interview-brief-research' }), { ok: true });
    assert.equal(runs.length, 0, 'runStage is never called for qa-research');
    assert.equal(research.length, 1);
    const request = research[0];
    assert.deepEqual(request.tools, [...PARALLEL_RESEARCH_TOOLS]);
    assert.equal(request.tools.length, 6);
    assert.equal(request.tools.some(name => name === 'WebSearch' || name === 'WebFetch'), false);
    assert.equal(request.mcpServers.parallel.url, 'https://mcp.parallel.ai/mcp');
    assert.deepEqual(request.mcpServers.parallel.headers, { Authorization: 'Bearer pk-test-key-0123456789' });
    assert.equal(typeof request.onToolResult, 'function');
    assert.equal(request.maxTurns, INTERVIEW_RESEARCH_MAX_TURNS);
    assert.equal(request.maxTurns, 24);
    assert.equal(request.persistSession, false);
    assert.equal(request.resume, false);
    assert.equal(request.ultracode, false);
    assert.equal(request.model, 'opus');
    assert.equal(request.effort, 'high');
    assert.equal(samples[0].tools, PARALLEL_RESEARCH_TOOLS.join(','));
    assert.equal(samples[0].tools.split(',').length, 6);
  } },
  { name: 'interview Claude transport: a research error other than exhaustion propagates and never reaches runStage', async run() {
    const runs = []; let researchCalls = 0;
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 3,
      parallel: { enabled: async () => true, readKey: async () => '' },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async () => { researchCalls += 1; throw Object.assign(new Error('mcp down'), { code: 'CLAUDE_RUN_FAILED' }); },
      routeFor: () => null });
    await assert.rejects(transport.callText('RESEARCH', { task: 'interview-brief-research' }),
      error => error.code === 'CLAUDE_RUN_FAILED' && error.message === 'mcp down');
    assert.equal(researchCalls, 1, 'a thrown research error is not retried');
    assert.equal(runs.length, 0, 'runStage is never called for qa-research');
  } },
  { name: 'interview Claude transport: PARALLEL_SEARCH_EXHAUSTED from research propagates at once and is never retried', async run() {
    const runs = []; const research = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 3,
      parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); throw parallelExhaustedError(); },
      routeFor: () => null });
    await assert.rejects(transport.callText('RESEARCH', { task: 'interview-brief-research' }),
      error => error.code === PARALLEL_EXHAUSTED_CODE);
    assert.equal(research.length, 1, 'exhaustion is not retried');
    assert.equal(runs.length, 0, 'runStage is never called for qa-research');
  } },
  { name: 'interview Claude transport: a rejected research reply is retried through Parallel with the original prompt and rejection', async run() {
    const runs = []; const research = [];
    const replies = ['{"ok":false}', '{"ok":true}'];
    const validator = value => { if (value.ok !== true) throw Object.assign(new Error('ok must be true'), { code: 'NOT_OK' }); };
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 3,
      parallel: { enabled: async () => true },
      runStage: async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; },
      runResearchStage: async args => { research.push(args); return { text: replies.shift(), model: 'claude-parallel' }; },
      routeFor: () => null });
    assert.deepEqual(await transport.callText('ORIGINAL', { task: 'interview-brief-research', responseValidator: validator }), { ok: true });
    assert.equal(research.length, 2, 'the rejection is retried, not abandoned');
    assert.equal(research[0].text, 'ORIGINAL');
    assert.equal(research[1].resume, false, 'a Parallel session is never persisted, so it cannot be resumed');
    assert.equal(research[1].persistSession, false);
    assert.match(research[1].text, /^ORIGINAL\n\nYOUR PREVIOUS REPLY WAS REJECTED BY THE APP[\s\S]*ok must be true$/u);
    assert.equal(runs.length, 0, 'the retry is another Parallel call, never the built-in runner');
    const spent = [];
    const exhausted = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, maxAttempts: 1,
      parallel: { enabled: async () => true },
      runStage: async args => { spent.push(args); return { text: '{"ok":true}' }; },
      runResearchStage: async args => { spent.push(args); return { text: '{"ok":false}' }; },
      routeFor: () => null });
    await assert.rejects(exhausted.callText('ORIGINAL', { task: 'interview-brief-research', responseValidator: validator }),
      error => error.code === 'NOT_OK');
    assert.equal(spent.length, 1, 'a rejected research reply consumes an attempt, never a built-in one');
  } },
  { name: 'interview Claude transport: Parallel exhausted before the call rejects with PARALLEL_SEARCH_EXHAUSTED and calls neither runner', async run() {
    const runs = []; const research = [];
    const stage = async args => { runs.push(args); return { text: '{"ok":true}', model: 'claude-x' }; };
    const researchStage = async args => { research.push(args); return { text: '{"ok":true}' }; };
    const off = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => false },
      runStage: stage, runResearchStage: researchStage, routeFor: () => null });
    await assert.rejects(off.callText('R', { task: 'interview-brief-research' }), error => error.code === PARALLEL_EXHAUSTED_CODE);
    assert.equal(runs.length, 0, 'runStage is never a research fallback');
    assert.equal(research.length, 0, 'Claude is not called when Parallel is exhausted');
    const throwing = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => { throw new Error('no keychain'); } },
      runStage: stage, runResearchStage: researchStage, routeFor: () => null });
    await assert.rejects(throwing.callText('R', { task: 'interview-brief-research' }), error => error.code === PARALLEL_EXHAUSTED_CODE);
    assert.equal(runs.length, 0, 'a throwing enabled() also means exhausted, never built-in');
    assert.equal(research.length, 0);
  } },
  { name: 'interview Claude transport: a non-research stage never calls runResearchStage or consults Parallel', async run() {
    let researchCalls = 0;
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => { throw new Error('Parallel must not be consulted'); } },
      runStage: async () => ({ text: '{"ok":true}', model: 'claude-x' }),
      runResearchStage: async () => { researchCalls += 1; return { text: '{"ok":true}' }; },
      routeFor: () => null });
    await transport.callText('Q', { task: 'interview-answer-bank', claudeStage: 'qa-fact-check' });
    await transport.callText('Q', { task: 'interview-brief-assessment' });
    await transport.callText('Q', { task: 'interview-answer-bank' });
    assert.equal(researchCalls, 0);
  } },
  { name: 'interview Claude transport: research onToolResult throws only for a Parallel tool error that reports a limit', async run() {
    const research = [];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {}, parallel: { enabled: async () => true, readKey: async () => '' },
      runStage: async () => { throw new Error('runStage must not run for research'); },
      runResearchStage: async args => { research.push(args); return { text: '{"ok":true}', model: 'claude-parallel' }; },
      routeFor: () => null });
    await transport.callText('SEARCH', { task: 'interview-brief-research' });
    const { onToolResult } = research[0];
    assert.equal(typeof onToolResult, 'function');
    try {
      assert.equal(onToolResult({ toolName: 'mcp__tavily__search', isError: true, text: '429 rate limit exceeded' }), undefined);
      assert.equal(onToolResult({ toolName: 'mcp__parallel__web_search', isError: false, text: '429 rate limit exceeded' }), undefined);
      assert.equal(onToolResult({ toolName: 'mcp__parallel__web_search', isError: true, text: 'failed to fetch https://x.test' }), undefined);
      assert.throws(() => onToolResult({ toolName: 'mcp__parallel__web_search', isError: true, text: '429 rate limit exceeded, try again later' }),
        error => error.code === PARALLEL_EXHAUSTED_CODE);
      assert.equal(parallelBlocked(), true, 'the limit is noted for the dock and the next call');
    } finally { resetParallelLimit(); }
  } },
  { name: 'interview Claude transport: recorded samples name the Parallel tools research used', async run() {
    const samples = []; const research = [];
    const replies = ['{"ok":false}', '{"ok":true}'];
    const transport = createInterviewClaudeTransport({ resolveBinary: () => '/usr/bin/claude', env: {},
      parallel: { enabled: async () => true },
      runStage: async () => ({ text: '{"ok":true}', model: 'claude-x' }),
      runResearchStage: async args => { research.push(args); return { text: replies.shift(), model: 'claude-parallel' }; },
      recordSample: sample => samples.push(sample),
      routeFor: () => null });
    const validator = value => { if (value.ok !== true) throw new Error('ok must be true'); };
    await transport.callText('ORIGINAL', { task: 'interview-brief-research', responseValidator: validator });
    await transport.callText('BRIEF', { task: 'interview-brief-assessment' });
    assert.deepEqual(samples.map(sample => [sample.stage, sample.tools]), [
      ['qa-research', PARALLEL_RESEARCH_TOOLS.join(',')],
      ['qa-research', PARALLEL_RESEARCH_TOOLS.join(',')],
      ['qa-brief', null],
    ]);
    assert.deepEqual(samples.map(sample => sample.outcome), ['rejected', 'accepted', 'accepted']);
    assert.match(samples[1].text, /^ORIGINAL\n\nYOUR PREVIOUS REPLY WAS REJECTED BY THE APP/u);
    assert.equal(samples.some(sample => String(sample.tools || '').includes('WebSearch')), false);
  } },
];
