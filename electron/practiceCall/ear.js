import fsPromises from 'node:fs/promises';

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
  let bidder = null;
  let note = null;
  const toneSamples = [];
  // R12: noteSpeech runs in the background; settle() can wait for its work.
  const inflight = new Set();
  let speechMs = 0;
  let latestTone = null;
  let closed = false;

  async function reader() {
    if (wav) return wav;
    const open = await wavOpen;
    wav = await open(candidatePath, { fs: fsPromises });
    return wav;
  }
  async function workerOf() {
    if (worker) return worker;
    worker = createInference ? createInference({ smartTurnPath, tonePath }) : await inference({ smartTurnPath, tonePath });
    return worker;
  }
  async function prosodyOf() { pro ??= await prosody; return pro; }
  async function baselineOf() {
    base ??= await baseline({ minSpeechMs });
    return base;
  }
  async function floorOf() {
    bidder ??= await floorBid({ baseline: await baselineOf() });
    return bidder;
  }
  async function noteOf() { note ??= await toneNote; return note; }
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
    const workerNow = await workerOf();
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
  function noteSpeech({ startMs, endMs } = {}) {
    if (closed || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
    const samples = spanSamples(startMs, endMs);
    if (!samples || !samples.length) return;
    const run = async () => {
      await noteLoaded;
      const measure = await prosodyOf();
      const turn = measure({ samples, sampleRate: 16000, startMs, endMs, words: [] });
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

  function voiceNote({ startMs, endMs } = {}) {
    if (closed || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    const samples = spanSamples(startMs, endMs);
    if (!samples || !samples.length || !pro || !base || !note) return null;
    if (!base.ready()) return null;
    const turn = pro({ samples, sampleRate: 16000, startMs, endMs, words: [] });
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
