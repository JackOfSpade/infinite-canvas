import assert from 'node:assert/strict';
import { createInterviewTalkingPoints, interviewTalkingPointInstructions } from '../../electron/interviewTalkingPoints.js';

function fake(reply) {
  const record = { settings: null, starts: [], matches: [], closes: 0 };
  const factory = settings => { record.settings = settings; return {
    start: async input => { record.starts.push(input); },
    match: input => { record.matches.push(input); return typeof reply === 'function' ? reply(input) : Promise.resolve(reply); },
    close: async () => { record.closes += 1; } }; };
  return { record, factory };
}

export default [
  { name: 'interview talking points: generic points only, never anything about the candidate', async run() {
    const { record, factory } = fake('Sure. {"points":["Listen to both sides first.","I resolved a conflict at Acme","Focus on the shared goal","Mention my promotion","Focus on the shared goal","Use Node.js event loop terms","Agree next steps","A fifth usable point here"]}');
    const points = createInterviewTalkingPoints({ config: { claudeBin: '/opt/claude', model: 'haiku', timeoutMs: 1 }, transportFactory: factory });
    assert.deepEqual(await points.generate('  Tell me about a time you handled conflict between coworkers. '),
      ['Listen to both sides first', 'Focus on the shared goal', 'Use Node.js event loop terms'].map(text => ({ text, sub: [] })), 'first-person points and duplicates are dropped and at most three are kept');
    assert.deepEqual(record.matches[0].question, 'Tell me about a time you handled conflict between coworkers.');
    assert.equal(record.starts.length, 1); assert.equal(record.starts[0].instructions, interviewTalkingPointInstructions());
    assert(/You know nothing about this candidate/u.test(record.starts[0].instructions) && !/career|résumé|resume/iu.test(record.starts[0].instructions), 'the session is given no career data');
    assert.equal(record.settings.model, 'opus'); assert.equal(record.settings.effort, 'medium'); assert.equal(record.settings.claudeBin, '/opt/claude');
    assert.equal(record.settings.timeoutMs, 10000, 'the matching deadline does not apply to writing points');
    assert(/live interview/u.test(record.settings.systemPrompt));
    const list = createInterviewTalkingPoints({ transportFactory: fake(JSON.stringify({ points: [
      { text: 'ACID: atomicity, consistency, isolation, durability', sub: ['Atomicity: all steps succeed or none do.', 'Consistency: data always obeys its rules', 'I used isolation at Acme', 'Isolation: concurrent work does not interfere', 'Durability: saved data survives a crash', 'A fifth sub point here'] },
      { text: 'Give one case where isolation matters in real systems you know well enough to explain', sub: [] },
      { text: 'Name the trade-off with speed', sub: ['A sub point that is far too long to read in the moment because it goes on and on', 'Stricter guarantees cost throughput'] }] })).factory });
    assert.deepEqual(await list.generate('What does ACID stand for?'), [
      { text: 'ACID: atomicity, consistency, isolation, durability', sub: ['Atomicity: all steps succeed or none do', 'Consistency: data always obeys its rules', 'Isolation: concurrent work does not interfere', 'Durability: saved data survives a crash'] },
      { text: 'Name the trade-off with speed', sub: ['Stricter guarantees cost throughput'] }],
    'a named list is one longer main point with each item defined beneath it; over-long or first-person lines are dropped');
    await points.generate('Another question for the same warm session?');
    assert.equal(record.starts.length, 1, 'the session is started once');
    await points.close(); assert.equal(record.closes, 1);
    assert.deepEqual(await points.generate('After close?'), []);
  } },
  { name: 'interview talking points: unusable replies and failures leave the card blank', async run() {
    for (const reply of ['not json', '{"points":[]}', '{"points":["Only one point"]}', '{"points":"Listen actively"}', '{"points":["I listened","We agreed"]}']) {
      const points = createInterviewTalkingPoints({ transportFactory: fake(reply).factory });
      assert.deepEqual(await points.generate('Tell me about a conflict.'), [], reply);
    }
    const failing = createInterviewTalkingPoints({ transportFactory: fake(() => Promise.reject(new Error('down'))).factory });
    assert.deepEqual(await failing.generate('Tell me about a conflict.'), []);
    const unstartable = createInterviewTalkingPoints({ transportFactory: () => { throw new Error('no claude'); } });
    assert.deepEqual(await unstartable.generate('Tell me about a conflict.'), []);
    assert.deepEqual(await failing.generate(''), []); assert.deepEqual(await failing.generate('x'.repeat(2001)), []);
  } },
  { name: 'interview talking points: a newer question abandons the older request', async run() {
    const pending = [];
    const { factory } = fake(() => new Promise(resolve => { pending.push(resolve); }));
    const points = createInterviewTalkingPoints({ transportFactory: factory });
    const first = points.generate('First question asked here?');
    await new Promise(resolve => setImmediate(resolve));
    const second = points.generate('Second question asked here?');
    await new Promise(resolve => setImmediate(resolve));
    pending[0]('{"points":["Stale point one","Stale point two"]}');
    pending[1]('{"points":["Fresh point one","Fresh point two"]}');
    assert.deepEqual(await first, []); assert.deepEqual(await second, [{ text: 'Fresh point one', sub: [] }, { text: 'Fresh point two', sub: [] }]);
  } },
];
