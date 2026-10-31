/** Event-driven speculative selection. No timers, provider, or display state. */
import { isInterviewPartialEligible } from './interviewCallQuestionDetector.js';

export const normalizeSpeculativeText = text => String(text || '').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[\p{P}\s]+$/gu, '');
const words = text => text.trim().split(/\s+/u).filter(Boolean).length;
const roundedConfidence = value => Math.round(value * 20) / 20;

export function createInterviewSpeculativeMatcher({
  matcher, bank, now = Date.now, onPreview = () => {}, isEligible = isInterviewPartialEligible,
  previewMinConfidence = 0.6, minConfidence = matcher?.minConfidence ?? 0.55,
  capacity = matcher?.speculativeCapacity ?? Math.max(0, (matcher?.poolSize ?? 4) - 1),
  enabled = true,
} = {}) {
  const cards = new Map((bank?.cards || []).map(card => [card.id, card]));
  const jobs = new Set();
  let listening = enabled;
  let turn = null;
  let blockedTurn = null;
  let visible = null;
  let preview = null;

  function emit(value) {
    const key = value ? `${value.id}:${value.cardId}:${roundedConfidence(value.confidence)}` : null;
    if (key === visible) return;
    visible = key;
    onPreview(value);
  }
  function clearPreview() { preview = null; emit(null); }
  function cancel(preservedJob = null) {
    if (turn) {
      blockedTurn = turn.id;
      turn.open = false;
      for (const job of jobs) if (job.turn === turn && job !== preservedJob) job.abort.abort();
    }
    turn = null;
    clearPreview();
  }
  function show(state, request, result) {
    preview = { cardId: result.cardId, confidence: result.confidence, words: words(request.text) };
    state.challenger = null;
    state.misses = 0;
    emit({ id: `${state.id}`, cardId: result.cardId, card: cards.get(result.cardId),
      confidence: result.confidence, transcript: request.text.slice(0, 2000), updatedAt: now() });
  }
  function apply(state, request, result) {
    if (!state.open || turn !== state || request.seq <= state.applied || !result) return;
    state.applied = request.seq;
    state.latest = { request, result };
    const qualifies = !result.approximate && ['question', 'follow-up'].includes(result.kind)
      && cards.has(result.cardId) && result.confidence >= previewMinConfidence;
    if (!qualifies) {
      state.challenger = null;
      state.misses = preview && words(request.text) >= preview.words + 2 ? state.misses + 1 : 0;
      if (state.misses >= 2) { state.misses = 0; clearPreview(); }
      return;
    }
    state.misses = 0;
    if (!preview || preview.cardId === result.cardId) { show(state, request, result); return; }
    const consecutive = state.challenger === result.cardId;
    state.challenger = result.cardId;
    if (consecutive || result.confidence + 1e-9 >= preview.confidence + 0.15) show(state, request, result);
  }
  const select = options => matcher.select ? matcher.select(options) : matcher.match(options.text, options);
  function pump() {
    const state = turn;
    if (!listening || !state?.open || jobs.size >= capacity || !state.pending
      || matcher.availableSpeculative === 0) return;
    const text = state.pending;
    // Revisions with no word growth do not spend another session. Retain the
    // latest revision, not a FIFO of transcripts that will already be stale.
    if (words(text) < state.dispatchedWords + 1) return;
    state.pending = null;
    state.dispatchedWords = words(text);
    const request = { turnId: state.id, seq: ++state.seq, text };
    const job = { turn: state, request, abort: new AbortController() };
    jobs.add(job);
    let pending;
    try { pending = select({ ...state.context, ...request, partial: true, signal: job.abort.signal }); }
    catch { pending = null; }
    job.promise = Promise.resolve(pending).then(result => job.abort.signal.aborted ? null : result, () => null);
    job.promise.then(result => apply(state, request, result)).finally(() => { jobs.delete(job); pump(); });
  }
  const unsubscribe = matcher?.subscribeAvailability?.(pump);
  function partial({ turnId, text }, context = {}) {
    if (!listening || !capacity || turnId === blockedTurn || typeof text !== 'string' || text.length > 2000) return;
    text = text.replace(/\s+/gu, ' ').trim();
    if (!turn || turn.id !== turnId) {
      cancel();
      turn = { id: turnId, open: true, seq: 0, applied: 0, dispatchedWords: 0, latest: null,
        pending: null, misses: 0, challenger: null, context };
    }
    if (words(text) < 3 || !isEligible(text)) { turn.pending = null; return; }
    turn.pending = text;
    turn.context = context;
    pump();
  }
  const reusable = result => result && !result.approximate
    && ['question', 'follow-up'].includes(result.kind) && result.confidence >= minConfidence;
  function endpoint({ turnId, id = turnId, text }) {
    const state = turn;
    if (!state || state.id !== id) return null;
    const normalized = normalizeSpeculativeText(text);
    const latest = state.latest;
    if (latest && normalizeSpeculativeText(latest.request.text) === normalized && reusable(latest.result)) {
      cancel();
      return { ...latest.result, source: 'speculative' };
    }
    const inflight = [...jobs].reverse().find(job => job.turn === state && !job.abort.signal.aborted
      && normalizeSpeculativeText(job.request.text) === normalized);
    // Retire the turn and clear its preview now, but keep an identical bounded
    // request alive so endpoint selection can use its existing head start.
    cancel(inflight);
    return inflight ? inflight.promise.then(result => reusable(result)
      ? { ...result, source: 'speculative-inflight' } : null) : null;
  }
  return Object.freeze({
    partial, endpoint, cancel,
    dispose() { cancel(); unsubscribe?.(); },
    async selectFinal(event, context = {}) {
      return (await endpoint(event)) || select({ ...context, text: event.text, partial: false });
    },
    setListening(value) {
      if (value === listening) return;
      cancel();
      listening = value;
      if (value) blockedTurn = null;
    },
    getPreview: () => preview && { ...preview },
  });
}
