/**
 * One voice stream for a panel of interviewers.
 * Each interviewer has their own ElevenLabs voice, so every stretch of speech by one
 * interviewer is a segment on that interviewer's own stream. Segments generate in parallel
 * (text goes out as soon as it is sent), but the audio is released strictly in speaking
 * order so the caller still sees ONE utterance with one running timeline.
 */
import { pcmDurationMs } from './dialogueVoice.js';

const noop = () => {};

// A remark spoken over a colleague plays a little under the main voice.
export const OVERLAY_GAIN = 0.85;
// The main speech never waits longer than this for a remark that is not ready yet.
export const OVERLAY_HOLD_MS = 250;
/** Never wait for a remark longer than this, however much speech is buffered ahead. */
export const OVERLAY_HOLD_MAX_MS = 3000;
/** Audio that must stay queued for playback while waiting, so the speaker never runs dry. */
export const OVERLAY_PLAY_MARGIN_MS = 200;

/**
 * A cut-in starts this long before the interrupted voice's SPEECH ends (not its buffer: a synthesised
 * segment ends in near-silence), so the two voices are heard together. Real overlaps are brief, 80% under 1 s.
 */
export const CUT_IN_OVERLAP_MS = 700;
/** The interrupted voice fades out over its last stretch, so it gives way instead of being cut. */
export const CUT_IN_FADE_MS = 120;
/** The most trailing near-silence a segment followed by a cut-in is expected to carry; held back with the overlap. */
export const CUT_IN_TRAILING_ALLOWANCE_MS = 1200;
/** Level test: speech is a window whose RMS is above the floor and above this share of the segment's loudest window. */
export const CUT_IN_LEVEL_WINDOW_MS = 20;
export const CUT_IN_SPEECH_FLOOR = 8;
export const CUT_IN_SPEECH_RATIO = 0.05;
/** gap() is clamped to this; the silence is emitted in chunks of at most SILENCE_CHUNK_MS. */
export const GAP_MAX_MS = 20000;
export const SILENCE_CHUNK_MS = 100;

const nonSpaceCount = text => String(text ?? '').replace(/\s/g, '').length;
const evenUp = value => value + (value & 1);

/**
 * Adds `count` samples of `remark` (from byte `from`, at OVERLAY_GAIN) into the 16-bit LE `target`
 * (from byte `at`). Both offsets are even. The one place the mixing arithmetic lives.
 */
function mixSamples(target, at, remark, from, count) {
  for (let i = 0; i < count; i += 1) {
    const sum = target.readInt16LE(at + i * 2) + Math.round(remark.readInt16LE(from + i * 2) * OVERLAY_GAIN);
    target.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), at + i * 2);
  }
}

const msSamples = (rate, ms) => Math.round((Number(rate) * ms) / 1000);
// Bytes (always even) withheld from a segment that a cut-in follows: the overlap plus the trailing-silence allowance.
const holdBytes = rate => msSamples(rate, CUT_IN_OVERLAP_MS + CUT_IN_TRAILING_ALLOWANCE_MS) * 2;
const windowRms = (buffer, fromSample, toSample) => {
  let sum = 0;
  for (let i = fromSample; i < toSample; i += 1) { const v = buffer.readInt16LE(i * 2); sum += v * v; }
  return toSample > fromSample ? Math.sqrt(sum / (toSample - fromSample)) : 0;
};

export function createPanelVoiceFactory({
  factories = {},
  leadId = 'A',
  clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle), now: () => Date.now() },
} = {}) {
  if (!factories?.[leadId]) throw new Error('panel voice needs a factory for the lead');

  function open({ utteranceId, signal, speakerId = leadId } = {}) {
    const audioListeners = [];
    const wordListeners = [];
    const speakerListeners = [];
    const overlayListeners = [];
    const errorListeners = [];
    const segments = [];
    let opened = 0;
    let current = null;
    let active = 0; // the segment whose audio may be released now
    let emittedMs = 0; // audio released so far, in the utterance timeline
    let cancelled = false;
    let finished = false;
    let firstError = null;
    let finishPromise = null;
    // Remark spoken over the current speaker (see overlay()); null unless one was asked for.
    let ov = null;
    let outBytes = 0; // bytes handed to listeners, the part of the timeline that can no longer change
    let inBytes = 0; // bytes the segments have released, including any held back for a remark
    let carry = null; // odd trailing byte held while a remark may mix so a sample is never split
    let heldMain = null; // main audio waiting at the remark's start point
    let holdTimer = null;
    let tailTimer = null; // how long a cut-in may wait for its first audio before the old voice's tail plays alone
    let firstOutAt = null; // when the first audio left, to know how much is still waiting to be played

    const emit = (list, value) => {
      for (const listener of [...list]) {
        try { listener(value); } catch { /* a listener must not break the stream */ }
      }
    };
    const subscribe = (list, callback) => {
      if (typeof callback !== 'function') return () => {};
      list.push(callback);
      return () => {
        const at = list.indexOf(callback);
        if (at >= 0) list.splice(at, 1);
      };
    };
    const fail = error => {
      if (firstError) return;
      firstError = error instanceof Error ? error : new Error(String(error ?? 'voice error'));
      emit(errorListeners, firstError);
    };

    const writeOut = buffer => {
      if (!buffer.length) return;
      if (firstOutAt === null && typeof clock.now === 'function') firstOutAt = clock.now();
      outBytes += buffer.length;
      emit(audioListeners, buffer);
    };
    const ovLive = () => Boolean(ov && !ov.failed && !cancelled);
    const maybeReport = at => {
      if (!ov || ov.reported) return;
      ov.reported = true;
      emit(overlayListeners, { speakerId: ov.speakerId, text: ov.text, offsetMs: Math.round(pcmDurationMs(at, ov.rate) * 10) / 10 });
    };
    const releaseHold = () => {
      if (holdTimer !== null) clock.clearTimeout(holdTimer);
      holdTimer = null;
      if (!heldMain) return;
      const data = Buffer.concat(heldMain);
      heldMain = null;
      processMain(data);
    };
    // Speech is synthesised faster than it is played, so by the time the main audio reaches the
    // remark's start point there are usually seconds of it still waiting to be heard. The main
    // audio can wait that long for the WHOLE remark, which is then mixed in one piece where it
    // belongs. Released on its first sample instead, the remark's first chunk landed at the point
    // and the rest of it seconds later, after everything that had been buffered. With nothing
    // buffered ahead (or no clock to tell) the wait is the short fixed one.
    const holdBudgetMs = () => {
      if (firstOutAt === null || typeof clock.now !== 'function' || !ov?.rate) return OVERLAY_HOLD_MS;
      const ahead = pcmDurationMs(outBytes, ov.rate) - (clock.now() - firstOutAt);
      return Math.max(OVERLAY_HOLD_MS, Math.min(ahead - OVERLAY_PLAY_MARGIN_MS, OVERLAY_HOLD_MAX_MS));
    };
    const hold = data => {
      heldMain = [data];
      holdTimer = clock.setTimeout(() => {
        holdTimer = null;
        if (!heldMain) return;
        ov.gaveUp = true;
        releaseHold();
      }, holdBudgetMs());
    };

    // The one place main speech leaves. The remark is a queue (ov.queue) consumed in order and
    // summed into whatever main samples go out from the anchor on; with no remark this is a pass-through.
    function processMain(buffer) {
      if (heldMain) { heldMain.push(buffer); return; }
      let data = carry ? Buffer.concat([carry, buffer]) : buffer;
      carry = null;
      if (!ovLive()) { writeOut(data); return; }
      // An overlay asked for mid-stream can find the output on half a sample.
      if (outBytes & 1 && data.length) { writeOut(data.subarray(0, 1)); data = data.subarray(1); }
      if (data.length & 1) {
        carry = Buffer.from(data.subarray(data.length - 1));
        data = data.subarray(0, data.length - 1);
      }
      if (!data.length) return;
      if (ov.anchor == null || outBytes + data.length <= ov.anchor) { writeOut(data); return; }
      if (outBytes < ov.anchor) {
        const cut = ov.anchor - outBytes;
        writeOut(data.subarray(0, cut));
        data = data.subarray(cut);
      }
      const available = ov.queue.length >> 1;
      if (!available) {
        if (!ov.started && !ov.gaveUp && !ov.done) {
          // Wait for the remark's first audio, but never longer than OVERLAY_HOLD_MS.
          if (carry) { data = Buffer.concat([data, carry]); carry = null; }
          hold(data);
          return;
        }
        writeOut(data);
        return;
      }
      const count = Math.min(available, data.length >> 1);
      const mixed = Buffer.from(data);
      mixSamples(mixed, 0, ov.queue, 0, count);
      ov.queue = ov.queue.subarray(count * 2);
      ov.started = true;
      maybeReport(outBytes);
      ov.mixEnd = outBytes + count * 2;
      writeOut(mixed);
    }

    // The loudest 20 ms window of a segment's own audio, the reference for "is this still speech".
    function trackLevel(segment, buffer) {
      const lv = segment.level;
      lv.win ||= Math.max(1, msSamples(segment.stream.sampleRate, CUT_IN_LEVEL_WINDOW_MS));
      let data = lv.odd ? Buffer.concat([lv.odd, buffer]) : buffer;
      lv.odd = null;
      if (data.length & 1) { lv.odd = Buffer.from(data.subarray(data.length - 1)); data = data.subarray(0, data.length - 1); }
      for (let i = 0; i < data.length; i += 2) {
        const v = data.readInt16LE(i);
        lv.sum += v * v;
        lv.n += 1;
        if (lv.n === lv.win) { lv.peak = Math.max(lv.peak, Math.sqrt(lv.sum / lv.n)); lv.sum = 0; lv.n = 0; }
      }
    }
    const commitAudio = (segment, buffer) => {
      if (!segment.spoke) {
        segment.spoke = true;
        emit(speakerListeners, { speakerId: segment.speakerId, startMs: emittedMs });
      }
      emittedMs += pcmDurationMs(buffer.length, segment.stream.sampleRate);
      inBytes += buffer.length;
      trackLevel(segment, buffer);
      feed(segment, buffer);
    };
    // An interrupter's own leading silence is not played: the audio waits for its first speech so its
    // first word lands inside the overlap. Decided on whole 20 ms windows, so chunking never matters.
    function leadDecide(segment, atSample) {
      const lead = segment.lead;
      segment.lead = null;
      segment.skipMs = pcmDurationMs(atSample * 2, segment.stream.sampleRate);
      const rest = lead.buf.subarray(atSample * 2);
      for (const words of lead.words) releaseWords(segment, words);
      commitAudio(segment, Buffer.from(rest));
    }
    function leadScan(segment, final) {
      const lead = segment.lead;
      const win = Math.max(1, msSamples(segment.stream.sampleRate, CUT_IN_LEVEL_WINDOW_MS));
      const total = lead.buf.length >> 1;
      while (lead.scanned < total) {
        const hi = Math.min(total, lead.scanned + win);
        if (hi - lead.scanned < win && !final) return;
        if (windowRms(lead.buf, lead.scanned, hi) >= CUT_IN_SPEECH_FLOOR) {
          let at = lead.scanned;
          while (Math.abs(lead.buf.readInt16LE(at * 2)) < CUT_IN_SPEECH_FLOOR) at += 1;
          leadDecide(segment, at);
          return;
        }
        lead.scanned = hi;
      }
      if (final) leadDecide(segment, 0); // never any speech: nothing to skip
    }
    const releaseAudio = (segment, buffer) => {
      if (!segment.lead) { commitAudio(segment, buffer); return; }
      segment.lead.buf = Buffer.concat([segment.lead.buf, buffer]);
      leadScan(segment, false);
    };

    // Cut-ins. A segment whose successor cuts in (holdTail) keeps its last CUT_IN_OVERLAP_MS back
    // (segment.pending); when it ends that tail becomes the head of the next segment (mixHead), which
    // is summed with it sample by sample as its audio arrives. Segments involved in neither stay a
    // pass-through, byte for byte. Involved segments work on whole samples (segment.odd holds a split one).
    const involved = segment => segment.holdTail || (segment.mixHead && segment.mixHead.length > 0);
    function forward(segment, data) {
      if (!segment.holdTail) { processMain(data); return; }
      segment.pending = Buffer.concat([segment.pending, data]);
      const releasable = segment.pending.length - holdBytes(segment.stream.sampleRate);
      if (releasable > 0) {
        processMain(segment.pending.subarray(0, releasable));
        segment.pending = segment.pending.subarray(releasable);
      }
    }
    function feed(segment, buffer) {
      if (!involved(segment)) {
        // A split sample kept while the segment was involved is part of this audio: dropping it would shift every later sample.
        if (segment.odd) { buffer = Buffer.concat([segment.odd, buffer]); segment.odd = null; }
        segment.rawBytes += buffer.length;
        processMain(buffer);
        return;
      }
      let data = segment.odd ? Buffer.concat([segment.odd, buffer]) : buffer;
      segment.odd = null;
      // Raw bytes sent before this segment became involved can end on half a sample: finish it as it is.
      if (segment.rawBytes & 1 && data.length) { processMain(data.subarray(0, 1)); data = data.subarray(1); segment.rawBytes = 0; }
      if (data.length & 1) { segment.odd = Buffer.from(data.subarray(data.length - 1)); data = data.subarray(0, data.length - 1); }
      if (!data.length) return;
      if (segment.mixHead && segment.mixHead.length) {
        const count = Math.min(segment.mixHead.length, data.length) >> 1;
        const mixed = Buffer.from(data);
        for (let i = 0; i < count; i += 1) {
          const sum = mixed.readInt16LE(i * 2) + segment.mixHead.readInt16LE(i * 2);
          mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i * 2);
        }
        segment.mixHead = segment.mixHead.subarray(count * 2);
        data = mixed;
      }
      forward(segment, data);
    }
    // The segment's audio is over: what is left of its head plays alone, its tail goes to the next segment.
    // Where the segment's speech really ends within `pending`: the last 20 ms window that is above the
    // segment's own level threshold, refined to the last loud sample. 0 when the held part is all silence.
    function speechEndSample(segment, pending) {
      const threshold = Math.max(CUT_IN_SPEECH_FLOOR, segment.level.peak * CUT_IN_SPEECH_RATIO);
      const win = Math.max(1, msSamples(segment.stream.sampleRate, CUT_IN_LEVEL_WINDOW_MS));
      for (let hi = pending.length >> 1; hi > 0; hi -= win) {
        const lo = Math.max(0, hi - win);
        if (windowRms(pending, lo, hi) < threshold) continue;
        for (let i = hi - 1; i >= lo; i -= 1) if (Math.abs(pending.readInt16LE(i * 2)) >= threshold) return i + 1;
      }
      return 0;
    }
    // What a cut-in does to the held end of an interrupted segment: `head` plays as it is, `tail` (the
    // last CUT_IN_OVERLAP_MS of speech, faded out) is summed with the interrupter, `dropped` (the trailing
    // silence) is not played. `full` is the untouched end, played when no interrupter mixes after all.
    function planTail(segment, pending) {
      const rate = segment.stream.sampleRate;
      const end = speechEndSample(segment, pending);
      const start = Math.max(0, end - msSamples(rate, CUT_IN_OVERLAP_MS));
      const tail = Buffer.from(pending.subarray(start * 2, end * 2));
      const fade = Math.min(msSamples(rate, CUT_IN_FADE_MS), end - start);
      for (let k = 0; k < fade; k += 1) {
        const at = (end - start - fade + k) * 2;
        tail.writeInt16LE(Math.round(tail.readInt16LE(at) * (1 - (k + 1) / fade)), at);
      }
      return { full: pending, head: pending.subarray(0, start * 2), tail, dropped: pending.length - end * 2, rate };
    }
    function endSegment(segment) {
      if (segment.lead) leadScan(segment, true); // an interrupter with no speech at all plays whole
      segment.odd = null; // half a sample cannot be summed or heard
      if (segment.mixHead && segment.mixHead.length) {
        // Shorter than the overlap: the interrupted tail that was not covered plays on its own.
        const rest = segment.mixHead;
        segment.mixHead = null;
        emittedMs += pcmDurationMs(rest.length, segment.stream?.sampleRate ?? segment.tailRate);
        inBytes += rest.length;
        forward(segment, rest);
      }
      if (segment.holdTail) {
        const pending = segment.pending;
        segment.pending = Buffer.alloc(0);
        const lv = segment.level;
        if (lv.n > 0) { lv.peak = Math.max(lv.peak, Math.sqrt(lv.sum / lv.n)); lv.sum = 0; lv.n = 0; }
        // A segment with no speech in it has nothing to cut into: the plain switch, nothing dropped.
        if (!segment.stream || lv.peak < CUT_IN_SPEECH_FLOOR) {
          processMain(pending);
        } else if (pending.length) {
          segment.overlapTail = planTail(segment, pending);
          segment.tailRate = segment.stream.sampleRate;
        }
      }
    }
    const anchorAt = bytes => {
      if (!ov || ov.anchor != null) return;
      ov.anchor = evenUp(Math.max(bytes, outBytes));
    };
    const releaseWords = (segment, words) => {
      const list = [].concat(words ?? []).filter(Boolean);
      if (!list.length) return;
      if (segment.lead) { segment.lead.words.push(list); return; } // times need the skipped leading silence
      const mapped = list.map(word => ({
        ...word,
        startMs: Math.round((Math.max(0, Number(word.startMs) - segment.skipMs) + segment.offsetMs) * 10) / 10,
        endMs: Math.round((Math.max(0, Number(word.endMs) - segment.skipMs) + segment.offsetMs) * 10) / 10,
        speakerId: segment.speakerId,
      }));
      for (const word of mapped) {
        segment.wordLog.push({ before: segment.spoken, startMs: word.startMs });
        segment.spoken += nonSpaceCount(word.word);
        if (ov && ov.anchor == null && ov.host === segment && segment.spoken - nonSpaceCount(word.word) >= ov.before) {
          anchorAt(Math.round((word.startMs / 1000) * ov.rate) * 2);
        }
      }
      emit(wordListeners, mapped);
    };

    // The interrupted voice's last CUT_IN_OVERLAP_MS is withheld until the interrupter's first audio
    // says where to sum it. Waiting costs nothing while earlier speech is still queued for playback,
    // so the wait is bounded by that queue: past it the listener would hear the first voice stop and
    // then a gap, so the tail plays alone and the interrupter simply follows.
    const tailRateMismatch = (segment, before) => Boolean(segment.stream) && Number(segment.stream.sampleRate) !== before.tailRate;
    const tailBudgetMs = rate => {
      if (firstOutAt === null || typeof clock.now !== 'function') return OVERLAY_HOLD_MS; // nothing heard yet, so no gap to cause
      const ahead = pcmDurationMs(outBytes, rate) - (clock.now() - firstOutAt);
      return Math.max(0, Math.min(ahead - OVERLAY_PLAY_MARGIN_MS, OVERLAY_HOLD_MAX_MS));
    };
    const clearTailTimer = () => {
      if (tailTimer !== null) clock.clearTimeout(tailTimer);
      tailTimer = null;
    };
    // Mixes the tail under the segment when it can be (same rate, audio present), else plays the whole end alone.
    function settleTail(segment, before, mix) {
      clearTailTimer();
      segment.waiting = false;
      const plan = before.overlapTail;
      before.overlapTail = null;
      // The rate is compared here, once the stream is known to exist, not when the speaker was chosen.
      if (mix && segment.stream && Number(segment.stream.sampleRate) === plan.rate) {
        if (plan.head.length) processMain(plan.head);
        // The trailing silence is dropped and the new voice starts under the end of the old speech: the timeline moves back.
        const removed = plan.dropped + plan.tail.length;
        emittedMs -= pcmDurationMs(removed, plan.rate);
        inBytes -= removed;
        segment.mixHead = plan.tail;
        segment.tailRate = plan.rate;
        segment.lead = { buf: Buffer.alloc(0), scanned: 0, words: [] };
      } else {
        processMain(plan.full);
      }
    }
    function startTailWait(segment, before) {
      const budget = tailBudgetMs(before.overlapTail.rate);
      if (!(budget > 0)) return;
      segment.waiting = true;
      tailTimer = clock.setTimeout(() => {
        tailTimer = null;
        if (cancelled || !segment.waiting) return;
        settleTail(segment, before, false);
        pump();
      }, budget);
    }

    // Real silence between two separately synthesised segments: zero samples in the normal audio flow
    // (through processMain, so a remark can still mix into it), in small chunks, never one big buffer.
    function emitSilence(rate, ms) {
      let left = msSamples(rate, ms);
      const chunk = Math.max(1, msSamples(rate, SILENCE_CHUNK_MS));
      while (left > 0 && !cancelled) {
        const count = Math.min(left, chunk);
        left -= count;
        emittedMs += pcmDurationMs(count * 2, rate);
        inBytes += count * 2;
        processMain(Buffer.alloc(count * 2));
      }
    }
    const silenceRate = () => [...segments.slice(0, active)].reverse().find(item => item.stream)?.stream.sampleRate ?? segments[0].stream?.sampleRate;

    // Moves the release point past finished segments and plays what a waiting one held back.
    const pump = () => {
      while (!cancelled && active < segments.length) {
        const segment = segments[active];
        if (!segment.activated) {
          const before = segments[active - 1];
          if (before?.overlapTail) {
            if (segment.cutIn && !segment.gapMs && !segment.done && !segment.heldAudio.length && !tailRateMismatch(segment, before)) {
              // Nothing of the interrupter yet: its first audio decides, but only a limited time.
              if (!segment.waiting) startTailWait(segment, before);
              if (segment.waiting) return;
            }
            // A gap before any text ends the cut-in: the old voice finishes whole, then the silence.
            settleTail(segment, before, segment.heldAudio.length > 0 && !segment.gapMs);
          }
          if (segment.gapMs) { emitSilence(silenceRate(), segment.gapMs); segment.gapMs = 0; }
          if (cancelled) return;
          segment.activated = true;
          segment.offsetMs = emittedMs;
          for (const words of segment.heldWords.splice(0)) releaseWords(segment, words);
          for (const buffer of segment.heldAudio.splice(0)) releaseAudio(segment, buffer);
        }
        if (!segment.done) return;
        endSegment(segment);
        // A speaker who never spoke is dropped: the tail withheld before it goes on to the next segment.
        if (!segment.hasText && !segment.holdTail && segments[active - 1]?.overlapTail) {
          segment.overlapTail = segments[active - 1].overlapTail;
          segment.tailRate = segments[active - 1].tailRate;
          segments[active - 1].overlapTail = null;
        }
        // A remark placed after the last word of a segment starts where that segment ends.
        segment.endBytes = inBytes;
        if (ov && ov.anchor == null && ov.host === segment) anchorAt(inBytes);
        active += 1;
      }
    };

    const markDone = segment => {
      if (segment.done) return;
      segment.done = true;
      segment.settle();
      pump();
    };

    function startSegment(id, cutIn = false) {
      const segment = {
        cutIn, holdTail: false, pending: Buffer.alloc(0), overlapTail: null, mixHead: null, odd: null,
        rawBytes: 0, tailRate: undefined, waiting: false, lead: null, skipMs: 0,
        level: { sum: 0, n: 0, peak: 0, odd: null, win: 0 },
        speakerId: id, stream: null, hasText: false, done: false, activated: false, spoke: false,
        offsetMs: 0, gapMs: 0, heldAudio: [], heldWords: [], settle: noop, promise: null,
        sent: '', wordLog: [], spoken: 0, endBytes: null,
      };
      segment.promise = new Promise(resolve => { segment.settle = resolve; });
      segments.push(segment);
      current = segment;
      return segment;
    }

    function openStream(segment) {
      const stream = factories[segment.speakerId].open({ utteranceId: `${utteranceId}-s${opened}`, signal });
      opened += 1;
      segment.stream = stream;
      stream.onAudio?.(buffer => {
        if (cancelled || segment.done) return;
        if (segment.activated) { releaseAudio(segment, buffer); return; }
        segment.heldAudio.push(buffer);
        if (segment.waiting && buffer?.length) pump(); // its first audio ends the wait
      });
      stream.onWords?.(words => {
        if (cancelled || segment.done) return;
        if (segment.activated) releaseWords(segment, words);
        else segment.heldWords.push(words);
      });
      stream.onError?.(error => fail(error));
    }

    // Ends a segment: one that got text finishes its stream, an empty one is dropped silently.
    function closeSegment(segment) {
      if (segment.hasText) {
        let result;
        try { result = segment.stream.finish(); } catch (error) { fail(error); markDone(segment); return; }
        Promise.resolve(result).then(() => markDone(segment), error => { fail(error); markDone(segment); });
        return;
      }
      try { segment.stream?.cancel(); } catch { /* already gone */ }
      markDone(segment);
    }

    // The first segment opens at once so `sampleRate` is known before any audio flows.
    startSegment(speakerId);
    openStream(current);
    pump();

    function setSpeaker(id, options) {
      if (cancelled || finished || !factories[id] || id === current.speakerId) return false;
      const cutIn = options?.cutIn === true;
      // Only a segment that has text can be interrupted; its tail is kept back from here on.
      if (cutIn && current.hasText && !current.done) current.holdTail = true;
      closeSegment(current);
      startSegment(id, cutIn);
      pump();
      return true;
    }

    /**
     * Ends the current segment here (its audio plays out whole), adds ms of silence, and goes on with a new
     * segment for the same speaker. Clamped to 0..GAP_MAX_MS; 0 or a non-finite value does nothing.
     */
    function gap(ms) {
      const value = Math.min(GAP_MAX_MS, Number(ms));
      if (cancelled || finished || !(value > 0)) return false;
      if (current.hasText) {
        closeSegment(current);
        startSegment(current.speakerId);
      } else if (current.activated) {
        // The releasing segment has said nothing yet: the silence goes out now and its words start after it.
        emitSilence(silenceRate(), value);
        current.offsetMs = emittedMs;
        return true;
      }
      current.gapMs += value;
      if (current.waiting) { clearTailTimer(); current.waiting = false; }
      pump();
      return true;
    }

    function sendText(text) {
      const value = String(text ?? '');
      if (cancelled || finished || !value) return false;
      if (!current.stream) {
        // Opened on first text so a speaker who never talks costs no connection.
        try { openStream(current); } catch (error) {
          fail(error);
          markDone(current);
          return false;
        }
      }
      current.hasText = true;
      current.sent += value;
      return current.stream.sendText(value);
    }

    /**
     * A short remark by another interviewer heard over the current speaker, from the point
     * `afterChars` into the current speaker's text. Returns false when it cannot be played.
     */
    function overlay({ speakerId: id, text, afterChars } = {}) {
      const value = String(text ?? '').trim();
      if (cancelled || finished || ov || !value || !factories[id] || id === current.speakerId) return false;
      const reference = current.stream ?? segments[0]?.stream;
      let stream;
      try { stream = factories[id].open({ utteranceId: `${utteranceId}-o`, signal }); } catch { return false; }
      const rate = Number(stream?.sampleRate);
      if (!(rate > 0) || rate !== Number(reference?.sampleRate)) {
        try { stream?.cancel(); } catch { /* already gone */ }
        return false;
      }
      // Non-space characters into the host's sent text; matched against word timings, never sliced.
      const before = Math.max(0, Math.floor(Number(afterChars)) || 0);
      const host = current;
      const state = {
        speakerId: id, text: value, host, stream, rate, anchor: null, started: false, reported: false,
        done: false, failed: false, gaveUp: false, pad: 0, mixEnd: 0,
        queue: Buffer.alloc(0), settle: noop, promise: null, before,
      };
      state.promise = new Promise(resolve => { state.settle = resolve; });
      ov = state;
      const lose = () => {
        if (state.failed) return;
        state.failed = true;
        state.queue = Buffer.alloc(0);
        state.settle();
        if (ov === state) releaseHold();
      };
      stream.onAudio?.(buffer => {
        if (cancelled || state.failed || state.done || !buffer?.length) return;
        state.queue = Buffer.concat([state.queue, buffer]);
        // A held start waits for the whole remark (released when it ends, fails, or the wait runs out).
      });
      stream.onError?.(lose);
      try {
        stream.sendText(value);
        Promise.resolve(stream.finish()).then(() => {
          state.done = true;
          // A last half sample is read with a zero high byte so it is mixed where it belongs.
          if (state.queue.length & 1) { state.queue = Buffer.concat([state.queue, Buffer.alloc(1)]); state.pad = 1; }
          state.settle();
          if (!cancelled && !state.failed) releaseHold();
        }, lose);
      } catch { lose(); }
      // The point may already have been spoken, or the host may already be over.
      const seen = host.wordLog.find(word => word.before >= state.before);
      if (seen) anchorAt(Math.round((seen.startMs / 1000) * rate) * 2);
      else if (host.endBytes != null) anchorAt(host.endBytes);
      return true;
    }

    // When every segment is over: free a held start, then emit the rest of the main speech and
    // the rest of the remark together, so the total is max(main, remark start + remark length).
    function finalizeOverlay() {
      if (!ov || cancelled) return;
      releaseHold();
      const tailCarry = carry;
      carry = null;
      let left = ovLive() ? ov.queue : Buffer.alloc(0);
      // A lone half sample that only became whole after its place had passed is dropped, not moved.
      if (ov.started && left.length === 2 && ov.pad && outBytes > ov.mixEnd) left = Buffer.alloc(0);
      if (!left.length) {
        if (tailCarry) writeOut(tailCarry);
        return;
      }
      const mainEnd = outBytes + (tailCarry ? 1 : 0);
      const start = ov.started ? outBytes : Math.max(ov.anchor ?? outBytes, outBytes);
      const end = Math.max(mainEnd, start + left.length - ov.pad);
      const tail = Buffer.alloc(evenUp(end - outBytes));
      if (tailCarry) tailCarry.copy(tail);
      mixSamples(tail, start - outBytes, left, 0, left.length >> 1);
      ov.queue = Buffer.alloc(0);
      ov.started = true;
      maybeReport(start);
      emittedMs += pcmDurationMs(Math.max(0, end - mainEnd), ov.rate);
      writeOut(tail.subarray(0, end - outBytes));
    }

    /** Ask the current speaker's stream to speak what it has now (a short acknowledgement). */
    function flush() {
      if (cancelled || finished || !current.stream || !current.hasText) return false;
      try { return current.stream.flush?.() ?? false; } catch { return false; }
    }

    // The abort listener goes when the stream is over, as the plain stream does with its own;
    // otherwise every utterance of a call would stay reachable from the call's signal.
    function forget() { try { signal?.removeEventListener?.('abort', cancel); } catch { /* nothing to remove */ } }

    function finish() {
      if (finishPromise) return finishPromise;
      if (!finished && !cancelled) {
        finished = true;
        closeSegment(current);
      }
      finishPromise = Promise.all([...segments.map(segment => segment.promise), ov?.promise]).then(() => {
        clearTailTimer();
        try { finalizeOverlay(); } catch { /* a remark must never break the speech */ }
        forget();
        if (firstError) throw firstError;
        return cancelled ? { cancelled: true } : { ok: true };
      });
      return finishPromise;
    }

    function cancel() {
      if (cancelled) return;
      cancelled = true;
      if (holdTimer !== null) clock.clearTimeout(holdTimer);
      holdTimer = null;
      clearTailTimer();
      heldMain = null;
      carry = null;
      if (ov) {
        try { ov.stream.cancel(); } catch { /* already gone */ }
        ov.failed = true;
        ov.queue = Buffer.alloc(0);
        ov.settle();
      }
      for (const segment of segments) {
        try { segment.stream?.cancel(); } catch { /* already gone */ }
        segment.heldAudio.length = 0;
        segment.heldWords.length = 0;
        segment.pending = Buffer.alloc(0); // nothing is played after a cancel, a withheld tail included
        segment.overlapTail = null;
        segment.mixHead = null;
        segment.done = true;
        segment.settle();
      }
      forget();
    }

    if (signal?.aborted) cancel();
    else signal?.addEventListener?.('abort', cancel);

    return {
      utteranceId,
      get sampleRate() { return segments[0]?.stream?.sampleRate; },
      get closed() { return cancelled || (finished && segments.every(segment => segment.done)); },
      sendText,
      flush,
      finish,
      cancel,
      setSpeaker,
      gap,
      overlay,
      onOverlay: callback => subscribe(overlayListeners, callback),
      onAudio: callback => subscribe(audioListeners, callback),
      onWords: callback => subscribe(wordListeners, callback),
      onSpeaker: callback => subscribe(speakerListeners, callback),
      onError: callback => subscribe(errorListeners, callback),
    };
  }

  return { open };
}
