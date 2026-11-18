const TONE_CHUNK_MS = 6000;

async function defaultWavOpen() {
  const module = await import('./audio/wavReader.js');
  return module.openGrowingWav;
}

async function defaultInference({ smartTurnPath, tonePath }) {
  const module = await import('./models/inferenceWorker.js');
  return module.createPracticeInference({ smartTurnPath, tonePath });
}

async function defaultProsody() {
  return (await import('./audio/prosody.js')).turnProsody;
}

async function defaultBaseline(options) {
  return (await import('./audio/baseline.js')).createVoiceBaseline(options);
}

async function defaultToneNote() {
  return (await import('./audio/toneNote.js')).composeVoiceNote;
}

async function defaultFloorBid(options) {
  return (await import('./audio/floorBid.js')).createFloorBidDetector(options);
}

/**
 * Ear on the candidate track. `endOfTurn` asks the inference worker for the
 * Smart Turn probability; `floorBid` judges an overlap with the user's
 * baseline; `voiceNote` is synchronous and never waits on a model: it composes
 * the prosody of a span with the most recent background tone scores.
 */
export function createPracticeEar({
  candidatePath,
  wavOpen = defaultWavOpen,
  inference = defaultInference,
  createInference = null,
  prosody = defaultProsody,
  baseline = defaultBaseline,
  floorBid = defaultFloorBid,
  toneNote = defaultToneNote,
  smartTurnPath = null,
  tonePath = null,
  minSpeechMs = 20000,
  onToneSample = () => {},
} = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath) throw new TypeError('Practice ear requires the candidate recording path.');
  let wav = null;
  let worker = null;
  let pro = null;
  let base = null;
  let note = null;
  const toneSamples = [];
  // Every measured answer span, kept so the call record can hold the prosody per turn.
  const measuredTurns = [];
  // R12: noteSpeech runs in the background; settle() can wait for its work.
  const inflight = new Set();
  let speechMs = 0;
  let latestTone = null;
  let closed = false;

  let opening = null;
  function reader() {
    // One shared attempt: two callers arriving together must not each open the file, or the
    // first handle is overwritten and never closed. A failed attempt is forgotten so the next
    // caller tries again (the recording may not exist yet).
    opening ??= (async () => {
      // Every dependency here is a loader (an async function), like the defaults above.
      const open = await wavOpen();
      // The reader uses synchronous file calls, so it takes its own default file system.
      wav = await open(candidatePath);
      return wav;
    })().catch(error => { opening = null; throw error; });
    return opening;
  }
  // Each loader caches its pending promise, so callers arriving together share one load. A
  // failed load is forgotten so the next caller tries again.
  const pending = {};
  function loadOnce(key, load) {
    pending[key] ??= load().catch(error => { pending[key] = null; throw error; });
    return pending[key];
  }
  function workerOf() {
    return loadOnce('worker', async () => {
      const created = createInference ? createInference({ smartTurnPath, tonePath }) : await inference({ smartTurnPath, tonePath });
      // A worker that finishes loading after close() would never be closed by anyone else.
      if (closed) {
        try { created?.close?.(); } catch { /* worker already gone */ }
        throw new Error('Practice ear is closed.');
      }
      worker = created;
      return worker;
    });
  }
  function prosodyOf() { return loadOnce('prosody', async () => { pro = await prosody(); return pro; }); }
  function baselineOf() { return loadOnce('baseline', async () => { base = await baseline({ minSpeechMs }); return base; }); }
  function floorOf() { return loadOnce('floor', async () => { return floorBid({ baseline: await baselineOf() }); }); }
  function noteOf() { return loadOnce('note', async () => { note = await toneNote(); return note; }); }
  // composeVoiceNote is pure and cheap, so load it with the ear: the voice-note
  // path then has it in hand instead of waiting on a model mid-call.
  const noteLoaded = noteOf().catch(() => null);

  function spanSamples(startMs, endMs) {
    if (!wav) return null;
    return wav.readMs(Math.max(0, startMs), Math.max(0, endMs));
  }

  async function endOfTurn(atMs) {
    if (closed) return 0.5;
    const readerNow = await reader();
    const end = Number.isFinite(atMs) ? atMs : readerNow.writtenMs();
    const samples = readerNow.readMs(Math.max(0, end - 8000), Math.max(0, end));
    if (!samples.length) return 0.5;
    let workerNow;
    try { workerNow = await workerOf(); } catch (error) {
      if (closed) return 0.5;
      throw error;
    }
    const value = await workerNow.endOfTurn(samples);
    return Number.isFinite(value) ? value : 0.5;
  }

  async function assessFloor({ startMs, endMs, wordCount = 0 } = {}) {
    const readerNow = await reader();
    const end = Number.isFinite(endMs) ? endMs : readerNow.writtenMs();
    const samples = readerNow.readMs(Math.max(0, startMs || 0), Math.max(0, end));
    const detector = await floorOf();
    return detector.assess({ samples, sampleRate: readerNow.sampleRate ?? 16000, overlapMs: Math.max(0, end - (startMs || 0)), wordCount });
  }

  /** Feed an answer span: baseline prosody now, tone scores in the background. */
  function noteSpeech({ startMs, endMs, wordCount = 0 } = {}) {
    if (closed || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
    const run = async () => {
      // The recording is opened here too: a call may reach its first answer before any
      // end-of-turn check has opened it.
      await reader();
      const samples = spanSamples(startMs, endMs);
      if (!samples || !samples.length) return;
      await noteLoaded;
      const measure = await prosodyOf();
      const measured = measure({ samples, sampleRate: 16000, startMs, endMs, words: [] });
      // The measure has no word timings here, so pace is the segment's word count over its speech time.
      const spoken = Number(measured?.speechMs) || 0;
      const words = Number.isFinite(wordCount) && wordCount > 0 ? Math.round(wordCount) : 0;
      const turn = words > 0 && spoken > 0
        ? { ...measured, wordCount: words, wordsPerMinute: Math.round((words / spoken) * 60000 * 10) / 10 }
        : measured;
      measuredTurns.push({ ...turn, startMs, endMs });
      // Only the first ~minSpeechMs of candidate speech defines the baseline;
      // later answers are measured against it rather than moving it.
      const feedsBaseline = speechMs < minSpeechMs;
      speechMs += Number(turn?.speechMs) || 0;
      const active = await baselineOf();
      if (feedsBaseline) active.add(turn, latestTone);
      const workerNow = await workerOf();
      for (let offset = 0; offset < endMs - startMs; offset += TONE_CHUNK_MS) {
        const chunkStart = startMs + offset;
        const chunkEnd = Math.min(endMs, chunkStart + TONE_CHUNK_MS);
        if (chunkEnd - chunkStart < 1000) continue;
        const chunk = wav.readMs(chunkStart, chunkEnd);
        if (!chunk.length) continue;
        try {
          const tone = await workerNow.tone(chunk);
          if (!tone) continue;
          latestTone = tone;
          const sample = { atMs: chunkStart, endMs: chunkEnd, arousal: tone.arousal, dominance: tone.dominance, valence: tone.valence };
          toneSamples.push(sample);
          try { onToneSample(sample); } catch { /* observer errors never break the call */ }
        } catch { /* tone is best effort */ }
      }
    };
    const work = run();
    inflight.add(work);
    const done = () => { inflight.delete(work); };
    work.then(done, done);
  }

  /** R12: resolve once background tone/prosody work is done, or after the timeout. */
  async function settle(timeoutMs = 2000) {
    const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 2000;
    const deadline = Date.now() + budget;
    while (inflight.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise(resolveWaited => { const timer = setTimeout(resolveWaited, remaining); timer?.unref?.(); }),
      ]);
    }
  }

  function voiceNote({ startMs, endMs, wordCount } = {}) {
    if (closed || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    const samples = spanSamples(startMs, endMs);
    if (!samples || !samples.length || !pro || !base || !note) return null;
    if (!base.ready()) return null;
    const measured = pro({ samples, sampleRate: 16000, startMs, endMs, words: [] });
    // Pace needs the words of this span: use the caller's count, else the one noted for the same span.
    const known = Number.isFinite(wordCount) ? wordCount : measuredTurns.find(item => item.startMs === startMs && item.endMs === endMs)?.wordCount;
    const spoken = Number(measured?.speechMs) || 0;
    const turn = known > 0 && spoken > 0
      ? { ...measured, wordCount: known, wordsPerMinute: Math.round((known / spoken) * 60000 * 10) / 10 }
      : measured;
    let tone = latestTone;
    for (const sample of toneSamples) if (sample.atMs >= startMs && sample.atMs < endMs) tone = sample;
    return note(base.relative(turn, tone));
  }

  return Object.freeze({
    endOfTurn,
    floorBid: assessFloor,
    voiceNote,
    noteSpeech,
    settle,
    toneSamples: () => toneSamples.map(sample => ({ ...sample })),
    /** Measured candidate turns in time order, each with its pauses, for the call record. */
    prosodyTurns: () => measuredTurns.map(turn => ({ ...turn })).sort((left, right) => left.startMs - right.startMs),
    /** The voice baseline's medians, or null when no answer has been measured. */
    baselineSnapshot: () => { try { return base?.snapshot?.() ?? null; } catch { return null; } },
    transcript: async () => (await reader()).writtenMs(),
    close: () => {
      closed = true;
      try { wav?.close(); } catch { /* already closed */ }
      try { worker?.close?.(); } catch { /* worker already gone */ }
    },
  });
}

export const createEar = createPracticeEar;
export default createPracticeEar;
