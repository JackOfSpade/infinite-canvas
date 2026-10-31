import assert from 'node:assert/strict';
import { createInterviewAiMatcher, interviewAiMatcherConfigFromEnv, interviewMatchPoolSize } from '../../electron/interviewAiMatcher.js';
import { createInterviewAiTransport } from '../../electron/interviewAiTransports.js';
import { INTERVIEW_AI_MATCH_SCHEMA } from '../../electron/interviewAiSelectionSchema.js';

const bank = { cards: [{ id: 'a', question: 'Describe a project.', headline: 'A prepared project.' }] };
const answer = JSON.stringify({ kind: 'question', cardId: 'a', confidence: 0.8 });
const flush = () => new Promise(resolve => setImmediate(resolve));
function pool(config = {}, failed = -1) {
  const sessions = [];
  const matcher = createInterviewAiMatcher({ bank, config: { transport: 'chatgpt-bridge', ...config }, transportFactory: () => {
    const record = { starts: 0, calls: [], closes: 0, index: sessions.length };
    sessions.push(record);
    return { start(input) {
      record.starts += 1; record.instructions = input.instructions;
      // Only the failed slot reopens a session during these tests.
      if (record.index === failed || failed >= 0 && record.index >= 3) throw new Error('Synthetic session failure');
    }, match(input) {
      if (!input.partial) { record.calls.push(input); return answer; }
      return new Promise(resolve => record.calls.push({ ...input, resolve }));
    }, close() { record.closes += 1; } };
  } });
  return { matcher, sessions };
}
export default [
  { name: 'interview speculative pool: default, configuration, env and clamp', async run() {
    assert.equal(interviewMatchPoolSize(), 4);
    assert.deepEqual([-20, 0, 1, 2.9, 9, 'bad'].map(value => interviewMatchPoolSize(value)), [1, 1, 1, 2, 4, 4]);
    assert.deepEqual(interviewAiMatcherConfigFromEnv({ INTERVIEW_MATCH_POOL_SIZE: '9' }), { poolSize: 4 });
    const h = pool();
    try { assert.equal(h.matcher.poolSize, 4); assert.equal(h.matcher.speculativeCapacity, 3);
      await h.matcher.start(); await flush(); assert.equal(h.sessions.length, 4); assert.deepEqual(h.sessions.map(s => s.starts), [1, 1, 1, 1]);
    } finally { await h.matcher.close(); }
  } },
  { name: 'interview speculative pool: two partials cannot delay a final or spend reserved capacity', async run() {
    const h = pool({ poolSize: 3 });
    try {
      await h.matcher.start();
      const first = h.matcher.select({ text: 'Tell me about projects', partial: true });
      const second = h.matcher.select({ text: 'Tell me about projects please', partial: true });
      await flush();
      assert.deepEqual(h.sessions.map(s => s.calls.length), [0, 1, 1]);
      await assert.rejects(h.matcher.select({ text: 'Tell me about projects now please', partial: true }), { code: 'MATCH_BUSY' });
      const final = await h.matcher.select({ text: 'Tell me about projects please.' });
      assert.equal(final.cardId, 'a'); assert.equal(final.approximate, false);
      assert.equal(h.sessions[0].calls[0].partial, false);
      assert.equal(h.sessions[1].calls[0].partial, true);
      h.sessions[1].calls[0].resolve(answer); h.sessions[2].calls[0].resolve(answer);
      await Promise.all([first, second]);
      assert.equal(h.sessions[1].instructions, h.sessions[0].instructions, 'one cache-friendly prefix for final and partial');
    } finally { await h.matcher.close(); }
  } },
  { name: 'interview speculative pool: size one disables speculation but keeps final API working', async run() {
    const h = pool({ poolSize: 1 });
    try {
      await h.matcher.start(); assert.equal(h.matcher.speculativeCapacity, 0);
      await assert.rejects(h.matcher.select({ text: 'Tell me about projects', partial: true }), { code: 'MATCH_BUSY' });
      assert.equal((await h.matcher.match('Tell me about projects')).cardId, 'a');
      assert.equal(h.sessions.length, 1);
    } finally { await h.matcher.close(); }
  } },
  { name: 'interview speculative pool: failed warm session cannot break healthy sessions', async run() {
    const h = pool({ poolSize: 3 }, 1);
    try {
      await h.matcher.start(); await flush();
      const failed = h.matcher.select({ text: 'Tell me about projects', partial: true });
      const healthy = h.matcher.select({ text: 'Tell me about projects please', partial: true });
      await flush();
      assert.equal((await failed).approximate, true);
      h.sessions[2].calls[0].resolve(answer); assert.equal((await healthy).cardId, 'a');
      assert.equal((await h.matcher.select({ text: 'Tell me about projects.' })).approximate, false);
      assert.equal(h.sessions[0].closes, 0); assert.equal(h.sessions[2].closes, 0);
    } finally { await h.matcher.close(); }
  } },
  { name: 'interview speculative pool: cancelling a partial detaches without closing healthy warm sessions', async run() {
    const h = pool({ poolSize: 3 }); const abort = new AbortController();
    try {
      await h.matcher.start(); const pending = h.matcher.select({ text: 'Tell me about projects', partial: true, signal: abort.signal });
      const rejected = assert.rejects(pending, { code: 'CANCELLED' }); await flush();
      abort.abort(); await rejected;
      assert.equal(h.sessions[1].calls[0].signal.aborted, true); assert.equal(h.sessions[1].closes, 0);
      assert.equal((await h.matcher.select({ text: 'Tell me about projects.' })).cardId, 'a');
      h.sessions[1].calls[0].resolve(answer);
    } finally { await h.matcher.close(); }
  } },
  { name: 'interview speculative pool: partial-aware per-turn message preserves strict response schema', async run() {
    const requests = [];
    const matcher = createInterviewAiMatcher({ bank, config: { transport: 'chatgpt-bridge', poolSize: 2 },
      request: async request => { requests.push(request); return answer; }, transportFactory: createInterviewAiTransport });
    try {
      await matcher.start();
      await matcher.select({ text: 'Tell me about projects', partial: true });
      await matcher.select({ text: 'Tell me about projects.' });
      assert.equal(requests.length, 2);
      assert.deepEqual(requests.map(request => request.responseSchema), [INTERVIEW_AI_MATCH_SCHEMA, INTERVIEW_AI_MATCH_SCHEMA]);
      const messages = requests.map(request => JSON.parse(request.prompt));
      assert.equal(messages[0].partial, true); assert.equal(Object.hasOwn(messages[1], 'partial'), false);
      assert.equal(requests[0].cachedPrefix, requests[1].cachedPrefix);
      assert.match(requests[0].cachedPrefix, /When the user message has partial: true, the interviewer is still mid-sentence:/u);
    } finally { await matcher.close(); }
  } },
];
