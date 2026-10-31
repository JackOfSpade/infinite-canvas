import assert from 'node:assert/strict';
import { createInterviewSpeculativeMatcher } from '../../electron/interviewSpeculativeMatcher.js';
import { isInterviewPartialEligible } from '../../electron/interviewCallQuestionDetector.js';

const bank = { cards: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
const result = (cardId = 'a', confidence = 0.7, kind = 'question') => ({ kind, cardId, confidence });
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(capacity = 2, extra = {}) {
  const calls = []; const previews = [];
  const matcher = { speculativeCapacity: capacity, select(input) {
    let resolve; let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    calls.push({ ...input, resolve, reject });
    return promise;
  } };
  const scheduler = createInterviewSpeculativeMatcher({ bank, matcher, now: () => 42,
    isEligible: isInterviewPartialEligible, onPreview: value => previews.push(value), ...extra });
  return { calls, previews, scheduler,
    partial: text => scheduler.partial({ turnId: 1, text }),
    async reply(index, value) { calls[index].resolve(value); await flush(); },
  };
}

export default [
  { name: 'interview speculative: latest-wins dispatch never queues stale partials', async run() {
    const h = harness(1);
    h.partial('Tell me about'); await flush();
    h.partial('Tell me about a'); h.partial('Tell me about a project'); h.partial('Tell me about a project you built');
    assert.equal(h.calls.length, 1);
    await h.reply(0, result());
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].text, 'Tell me about a project you built');
    assert.deepEqual([h.calls[0].turnId, h.calls[0].seq, h.calls[1].seq], [1, 1, 2]);
    assert.equal(h.calls[1].partial, true);
    h.partial('Tell us about a project you built'); await h.reply(1, result());
    assert.equal(h.calls.length, 2, 'same word-count revisions cannot spend another session');
    h.scheduler.cancel();
  } },
  { name: 'interview speculative: stale out-of-order and closed-turn results are silent', async run() {
    const h = harness();
    h.partial('Tell me about'); h.partial('Tell me about a'); await flush();
    await h.reply(1, result('b'));
    await h.reply(0, result('a', 0.99));
    assert.deepEqual(h.previews.map(item => item?.cardId), ['b']);
    h.partial('Tell me about a project'); await flush();
    h.scheduler.endpoint({ id: 1, text: 'Tell me about a project' });
    await h.reply(2, result('a', 0.99));
    assert.deepEqual(h.previews.map(item => item?.cardId ?? null), ['b', null]);
    h.scheduler.partial({ turnId: 1, text: 'Tell me about a project please' }); await flush();
    assert.equal(h.calls.length, 3);
  } },
  { name: 'interview speculative: threshold, bank-only previews, rounded changes and sealed shape', async run() {
    const h = harness(1);
    for (const [index, selection] of [result('a', 0.59), result('outside', 1), result('a', 0.6), result('a', 0.61), result('a', 0.64)].entries()) {
      h.partial(`Describe the project ${'word '.repeat(index)}`); await flush(); await h.reply(index, selection);
    }
    assert.equal(h.previews.length, 2);
    assert.equal(h.previews[0].card, bank.cards[0]); assert.equal(h.previews[0].confidence, 0.6);
    assert.deepEqual(Object.keys(h.previews[0]).sort(), ['card', 'cardId', 'confidence', 'id', 'transcript', 'updatedAt']);
    assert.equal(h.previews[0].id, '1'); assert.equal(h.previews[0].updatedAt, 42);
    assert.equal(h.previews.at(-1).confidence, 0.64);
    h.scheduler.cancel();
  } },
  { name: 'interview speculative: switch requires consecutive challenger or confidence gain of 0.15', async run() {
    const h = harness(1);
    const selections = [result('a', 0.6), result('b', 0.7), result('c', 0.7), result('b', 0.7), result('b', 0.7), result('a', 0.85)];
    for (const [index, selection] of selections.entries()) {
      h.partial(`Describe the project ${'word '.repeat(index)}`); await flush(); await h.reply(index, selection);
    }
    assert.deepEqual(h.previews.map(item => item.cardId), ['a', 'b', 'a']);
    h.scheduler.cancel();
  } },
  { name: 'interview speculative: clear requires two consecutive misses each two words beyond preview', async run() {
    const h = harness(1);
    const selections = [result(), result('none', 0.9), result('none', 0.1), result('a', 0.1), result(),
      result('none', 0.99, 'not-question'), result('a', 0.5), result('none', 0.8)];
    for (const [index, selection] of selections.entries()) {
      h.partial(`Describe the project ${'word '.repeat(index)}`); await flush(); await h.reply(index, selection);
      if (index === 2 || index === 6) assert.notEqual(h.previews.at(-1), null);
    }
    assert.deepEqual(h.previews.map(item => item?.cardId ?? null), ['a', null, 'a', null]);
    h.scheduler.cancel();
  } },
  { name: 'interview speculative: endpoint locks matching latest text instantly, otherwise selects final once', async run() {
    for (const kind of ['question', 'follow-up']) {
      const h = harness(1);
      h.partial('Tell me about projects'); await flush(); await h.reply(0, result('a', 0.7, kind));
      const locked = await h.scheduler.selectFinal({ id: 1, text: ' TELL  me about projects?! ' });
      assert.equal(locked.source, 'speculative'); assert.equal(locked.kind, kind); assert.equal(h.calls.length, 1);
      assert.equal(h.previews.at(-1), null);
    }
    for (const selection of [result(), result('a', 0.5), result('none', 0.99, 'not-question')]) {
      const h = harness(1);
      h.partial('Tell me about projects'); await flush(); await h.reply(0, selection);
      const pending = h.scheduler.selectFinal({ id: 1, text: 'Tell me about projects now' }); await flush();
      assert.equal(h.calls.length, 2); assert.equal(h.calls[1].partial, false);
      h.calls[1].resolve(result('none', 0.95, 'not-question'));
      const final = await pending; assert.equal(final.kind, 'not-question'); assert.equal(h.scheduler.getPreview(), null);
      h.scheduler.cancel();
    }
  } },
  { name: 'interview speculative: endpoint reuses identical in-flight text once at the final threshold, including none', async run() {
    for (const kind of ['question', 'follow-up']) for (const cardId of ['a', 'none']) {
      const h = harness(1, { minConfidence: 0.55 });
      h.partial('Tell me about projects');
      const pending = h.scheduler.selectFinal({ id: 1, text: ' TELL  me about projects?! ' });
      await flush();
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].partial, true);
      assert.equal(h.calls[0].signal.aborted, false);
      const selection = result(cardId, 0.55, kind);
      await h.reply(0, selection);
      assert.deepEqual(await pending, { ...selection, source: 'speculative-inflight' });
      assert.equal(h.calls.length, 1, 'identical endpoint text must not spend a final matcher call');
      assert.equal(h.scheduler.getPreview(), null); assert.deepEqual(h.previews, []);
    }
  } },
  { name: 'interview speculative: endpoint clears preview immediately and aborts every other job without dispatching pending text', async run() {
    const h = harness(2);
    h.partial('Tell me about'); await h.reply(0, result());
    h.partial('Tell me about projects');
    h.partial('Tell me about projects you built');
    h.partial('Tell me about projects you built recently');
    const pending = h.scheduler.endpoint({ id: 1, text: 'Tell me about projects you built.' });
    assert.equal(pending instanceof Promise, true);
    assert.equal(h.scheduler.getPreview(), null);
    assert.deepEqual(h.previews.map(item => item?.cardId ?? null), ['a', null]);
    assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.calls[2].signal.aborted, false);
    h.scheduler.cancel();
    assert.equal(h.calls[2].signal.aborted, false, 'endpoint handoff survives redundant preview cancellation');
    await h.reply(1, result('c', 1)); await h.reply(2, result('b'));
    assert.deepEqual(await pending, { ...result('b'), source: 'speculative-inflight' });
    assert.equal(h.calls.length, 3); assert.equal(h.scheduler.getPreview(), null);
    assert.deepEqual(h.previews.map(item => item?.cardId ?? null), ['a', null]);
  } },
  { name: 'interview speculative: non-identical in-flight text is aborted and selects final once', async run() {
    const h = harness(1);
    h.partial('Tell me about projects');
    const pending = h.scheduler.selectFinal({ id: 1, text: 'Tell me about projects now' }, { previousCardId: 'b' });
    await flush();
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].partial, false);
    assert.equal(h.calls[1].text, 'Tell me about projects now'); assert.equal(h.calls[1].previousCardId, 'b');
    await h.reply(0, result('c', 1)); await h.reply(1, result('b'));
    assert.deepEqual(await pending, result('b')); assert.equal(h.scheduler.getPreview(), null);
  } },
  { name: 'interview speculative: rejected, aborted, approximate, low-confidence and non-question in-flight replies select final once', async run() {
    const aborted = Object.assign(new Error('Selection aborted.'), { name: 'AbortError' });
    for (const selection of [new Error('Selection failed.'), aborted, { ...result(), approximate: true },
      result('a', 0.54), result('none', 0.99, 'not-question'), null]) {
      const h = harness(1, { minConfidence: 0.55 });
      h.partial('Tell me about projects');
      const pending = h.scheduler.selectFinal({ id: 1, text: 'Tell me about projects.' });
      await flush();
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, false);
      if (selection instanceof Error) h.calls[0].reject(selection);
      else h.calls[0].resolve(selection);
      await flush();
      assert.equal(h.calls.length, 2); assert.equal(h.calls[1].partial, false);
      assert.equal(h.calls[1].text, 'Tell me about projects.');
      await h.reply(1, result('b'));
      assert.deepEqual(await pending, result('b')); assert.equal(h.scheduler.getPreview(), null);
      assert.equal(h.calls.length, 2);
    }
  } },
  { name: 'interview speculative: final uses matcher threshold rather than preview threshold', async run() {
    const h = harness(1, { minConfidence: 0.55 });
    h.partial('Tell me about projects'); await flush(); await h.reply(0, result('a', 0.56));
    assert.equal(h.previews.length, 0);
    const final = await h.scheduler.selectFinal({ id: 1, text: 'Tell me about projects.' });
    assert.equal(final.cardId, 'a'); assert.equal(final.source, 'speculative'); assert.equal(h.calls.length, 1);
  } },
  { name: 'interview speculative: Listen, explicit cancellation and safe filler gates', async run() {
    const h = harness(1);
    h.partial('Tell me'); h.partial('Um uh hmm'); await flush(); assert.equal(h.calls.length, 0);
    h.partial('I would really appreciate'); await flush(); assert.equal(h.calls.length, 1, 'no interrogative lexical gate');
    h.scheduler.cancel(); assert.equal(h.calls[0].signal.aborted, true);
    h.partial('I would really appreciate hearing more'); await h.reply(0, result()); assert.equal(h.calls.length, 1);
    h.scheduler.setListening(false); h.scheduler.partial({ turnId: 2, text: 'Tell me about projects' }); await flush(); assert.equal(h.calls.length, 1);
    h.scheduler.setListening(true); h.scheduler.partial({ turnId: 1, text: 'Tell me about projects' }); await flush();
    assert.equal(h.calls.length, 2); await h.reply(1, result());
    h.scheduler.setListening(false); assert.equal(h.previews.at(-1), null);
  } },
];
