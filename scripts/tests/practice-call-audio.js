import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openGrowingWav } from '../../electron/practiceCall/audio/wavReader.js';
import { trackPitch } from '../../electron/practiceCall/audio/pitch.js';
import { turnProsody } from '../../electron/practiceCall/audio/prosody.js';
import { createVoiceBaseline } from '../../electron/practiceCall/audio/baseline.js';
import { composeVoiceNote, VOICE_NOTE_THRESHOLDS } from '../../electron/practiceCall/audio/toneNote.js';
import { createFloorBidDetector, FLOOR_BID_THRESHOLDS } from '../../electron/practiceCall/audio/floorBid.js';
import { createInterviewerTrack } from '../../electron/practiceCall/audio/trackWriter.js';
import { mixTracks } from '../../electron/practiceCall/audio/mixdown.js';
import { callMetrics } from '../../electron/practiceCall/audio/callMetrics.js';

// All fixtures here are synthetic: generated sines, seeded noise, silence and
// scripted word timings. No real recording is read.
const RATE = 16000;
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'practice-call-audio-'));

const median = values => {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function sine(hz, ms, sampleRate = RATE, amplitude = 0.3) {
  const frames = Math.round((sampleRate * ms) / 1000);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

const silence = (ms, sampleRate = RATE) => new Float32Array(Math.round((sampleRate * ms) / 1000));

function seededNoise(ms, { sampleRate = RATE, amplitude = 0.3, seed = 7 } = {}) {
  let state = seed >>> 0;
  const out = new Float32Array(Math.round((sampleRate * ms) / 1000));
  for (let i = 0; i < out.length; i += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    out[i] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function writeWav(filePath, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
  return filePath;
}

function readWav(filePath) {
  const bytes = fs.readFileSync(filePath);
  const sampleRate = bytes.readUInt32LE(24);
  const frames = Math.floor((bytes.length - 44) / 2);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) samples[i] = bytes.readInt16LE(44 + i * 2) / 32768;
  return { sampleRate, samples, dataBytes: bytes.length - 44 };
}

const int16Pcm = (samples, amplitude) => {
  const bytes = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) bytes.writeInt16LE(Math.round(amplitude * 32767), i * 2);
  return bytes;
};

export default [
  {
    name: 'practice call audio: pitch recovers synthetic sines and marks silence and noise unvoiced',
    run() {
      for (const hz of [100, 180, 300]) {
        const { hopMs, f0 } = trackPitch(sine(hz, 600), RATE);
        assert.equal(hopMs, 10);
        const voiced = Array.from(f0).filter(value => value > 0);
        assert.ok(voiced.length >= 40, `synthetic ${hz} Hz sine should be voiced in most frames`);
        const measured = median(voiced);
        assert.ok(Math.abs(measured - hz) / hz <= 0.02, `YIN on synthetic ${hz} Hz sine measured ${measured} Hz`);
      }
      const quiet = trackPitch(sine(180, 400, RATE, 0.001), RATE);
      assert.deepEqual(Array.from(quiet.f0).filter(value => value !== 0), [], 'a -60 dBFS sine is below the voicing gate');
      const empty = trackPitch(silence(300), RATE);
      assert.deepEqual(Array.from(empty.f0), Array.from(new Float32Array(empty.f0.length)), 'silence is unvoiced');
      const noise = trackPitch(seededNoise(500), RATE);
      assert.deepEqual(Array.from(noise.f0).filter(value => value !== 0), [], 'seeded white noise is unvoiced');
    },
  },
  {
    name: 'practice call audio: prosody measures pauses, pace, pitch range and loudness on a synthetic turn',
    run() {
      const samples = concat(sine(120, 1000), silence(500), sine(240, 1000), silence(800), sine(120, 1000));
      const labels = ['synthetic', 'tone', 'turn', 'with', 'eight', 'scripted', 'timing', 'marks'];
      const words = labels.map((text, index) => ({ text, startMs: index * 375, endMs: index * 375 + 300 }));
      const prosody = turnProsody({ samples, sampleRate: RATE, startMs: 0, words });
      assert.deepEqual(prosody.pauses, [{ startMs: 1000, endMs: 1500 }, { startMs: 2500, endMs: 3300 }]);
      assert.equal(prosody.pauseCount, 2);
      assert.equal(prosody.longestPauseMs, 800);
      assert.ok(Math.abs(prosody.speechMs - 3000) <= 20, `synthetic turn speechMs ${prosody.speechMs}`);
      assert.ok(Math.abs(prosody.wordsPerMinute - 160) <= 2, `synthetic turn wpm ${prosody.wordsPerMinute}`);
      assert.ok(Math.abs(prosody.pitchRangeSt - 12) <= 1.5, `synthetic 120->240 Hz turn range ${prosody.pitchRangeSt} st`);
      const expectedDb = 20 * Math.log10(0.3 / Math.SQRT2);
      assert.ok(Math.abs(prosody.loudnessDb - expectedDb) <= 1, `synthetic -13.5 dBFS turn measured ${prosody.loudnessDb}`);
      assert.equal(prosody.restarts, 0, 'distinct synthetic tokens are not restarts');

      const silent = turnProsody({ samples: silence(600), sampleRate: RATE, startMs: 0, words: [] });
      assert.equal(silent.speechMs, 0);
      assert.deepEqual(silent.pauses, []);
      assert.equal(silent.wordsPerMinute, 0);
      assert.equal(silent.restarts, 0);
    },
  },
  {
    name: 'practice call audio: prosody restarts count immediately repeated tokens and pairs without word lists',
    run() {
      const samples = sine(150, 2000);
      const scripted = (texts) => texts.map((text, index) => ({ text, startMs: index * 100, endMs: index * 100 + 80 }));
      const prosody = turnProsody({
        samples, sampleRate: RATE, startMs: 0,
        words: scripted(['I', 'i.', 'think', 'I', 'THINK', 'so']),
      });
      assert.equal(prosody.restarts, 2, 'one repeated token and one repeated adjacent pair');
      const distinct = turnProsody({ samples, sampleRate: RATE, startMs: 0, words: scripted(['alpha', 'beta', 'gamma']) });
      assert.equal(distinct.restarts, 0);
      const triple = turnProsody({ samples, sampleRate: RATE, startMs: 0, words: scripted(['go', 'go', 'go']) });
      assert.equal(triple.restarts, 2, 'two immediate repeats in a triple');
    },
  },
  {
    name: 'practice call audio: baseline stays null until enough speech then reports medians and relative deltas',
    run() {
      const baseline = createVoiceBaseline({ minSpeechMs: 2000 });
      assert.equal(baseline.ready(), false);
      assert.equal(baseline.snapshot(), null);
      const idle = baseline.relative({ wordsPerMinute: 150, pauseCount: 2, pitchRangeSt: 6, loudnessDb: -18 });
      assert.deepEqual(Object.values(idle), [null, null, null, null, null, null, null, null], 'nothing is relative before the baseline is ready');
      const turn = { speechMs: 1000, wordsPerMinute: 120, pauseCount: 1, longestPauseMs: 400, pitchRangeSt: 8, loudnessDb: -20, pitchMedianHz: 150 };
      baseline.add(turn, { arousal: 0.5, dominance: 0.5, valence: 0.5 });
      assert.equal(baseline.ready(), false, 'one 1 s turn is under minSpeechMs');
      baseline.add(turn, { arousal: 0.5, dominance: 0.5, valence: 0.5 });
      assert.equal(baseline.ready(), true);
      const snapshot = baseline.snapshot();
      assert.equal(snapshot.wordsPerMinute, 120);
      assert.equal(snapshot.loudnessDb, -20);
      assert.equal(snapshot.arousal, 0.5);
      const relative = baseline.relative(
        { wordsPerMinute: 150, pauseCount: 2, pitchRangeSt: 6, loudnessDb: -18, restarts: 1 },
        { arousal: 0.6, dominance: 0.4, valence: 0.5 },
      );
      assert.equal(relative.rateRatio, 1.25);
      assert.equal(relative.pauseRatio, 1.5);
      assert.equal(relative.pitchRangeDeltaSt, -2);
      assert.equal(relative.loudnessDeltaDb, 2);
      assert.equal(relative.arousalDelta, 0.1);
      assert.equal(relative.dominanceDelta, -0.1);
      assert.equal(relative.valenceDelta, 0);
      assert.equal(relative.restarts, 1);
      const missingTone = baseline.relative({ wordsPerMinute: 150, pauseCount: 2, pitchRangeSt: 6, loudnessDb: -18 });
      assert.equal(missingTone.arousalDelta, null, 'tone deltas need both sides');
    },
  },
  {
    name: 'practice call audio: tone note thresholds are frozen and notes stay sparse and relative',
    run() {
      assert.ok(Object.isFrozen(VOICE_NOTE_THRESHOLDS), 'voice note thresholds are one frozen object');
      assert.equal(VOICE_NOTE_THRESHOLDS.rateRatioFast, 1.2);
      assert.equal(VOICE_NOTE_THRESHOLDS.rateRatioSlow, 0.8);
      assert.equal(VOICE_NOTE_THRESHOLDS.pauseRatio, 1.6);
      assert.throws(() => { VOICE_NOTE_THRESHOLDS.pauseRatio = 9; }, TypeError, 'frozen thresholds reject writes');
      const normal = { rateRatio: 1.1, pauseRatio: 1.2, pitchRangeDeltaSt: -1, loudnessDeltaDb: 2, arousalDelta: 0.01, dominanceDelta: -0.01, valenceDelta: 0.2, restarts: 1 };
      assert.equal(composeVoiceNote(normal), null, 'normal speech relative to the user gets no note');
      assert.equal(composeVoiceNote(null), null);
      assert.equal(composeVoiceNote({ rateRatio: 1.2, pauseRatio: 1.6, pitchRangeDeltaSt: -2, dominanceDelta: -0.08, arousalDelta: 0.08, restarts: 3 }),
        'faster than your usual pace; more long pauses than usual; less confident than your usual', 'exactly at threshold counts, ties keep measure order');
      assert.equal(composeVoiceNote({ pitchRangeDeltaSt: -6, restarts: 6, rateRatio: 1.3 }),
        'flatter than usual; restarted several times; faster than your usual pace', 'the most salient measure comes first');
      assert.equal(composeVoiceNote({ rateRatio: 0.8 }), 'slower than your usual pace');
      assert.equal(composeVoiceNote({ rateRatio: 0.79 }), 'slower than your usual pace');
      assert.equal(composeVoiceNote({ rateRatio: 1.19 }), null);
      assert.equal(composeVoiceNote({ arousalDelta: 0.09 }), 'more tense/energetic than usual');
      assert.equal(composeVoiceNote({ pitchRangeDeltaSt: -2.01 }), 'flatter than usual');
      const custom = { ...VOICE_NOTE_THRESHOLDS, rateRatioFast: 1.05, maxPhrases: 1 };
      assert.equal(composeVoiceNote({ rateRatio: 1.1, pauseRatio: 4 }, custom), 'more long pauses than usual', 'custom thresholds cap at one phrase');
    },
  },
  {
    name: 'practice call audio: floor bid continues only for a quiet short sound and pauses otherwise',
    run() {
      assert.ok(Object.isFrozen(FLOOR_BID_THRESHOLDS));
      assert.equal(FLOOR_BID_THRESHOLDS.quietBelowBaselineDb, 8);
      assert.equal(FLOOR_BID_THRESHOLDS.shortMs, 300);
      assert.equal(FLOOR_BID_THRESHOLDS.onsetSharpDb, 12);
      const baseline = createVoiceBaseline({ minSpeechMs: 1000 });
      baseline.add({ speechMs: 1000, wordsPerMinute: 120, pauseCount: 1, pitchRangeSt: 8, loudnessDb: -20 });
      const detector = createFloorBidDetector({ baseline });
      const quiet = detector.assess({ samples: sine(200, 150, RATE, 0.02), sampleRate: RATE, overlapMs: 120, wordCount: 0 });
      assert.equal(quiet.decision, 'continue');
      assert.equal(quiet.reason, 'quiet-short-overlap');
      assert.ok(Math.abs(quiet.features.loudnessDb - 20 * Math.log10(0.02 / Math.SQRT2)) <= 1);
      assert.equal(quiet.features.quietDb, -28, 'baseline loudness minus 8 dB');
      assert.equal(quiet.features.quietReference, 'baseline');
      const loud = detector.assess({ samples: sine(200, 150, RATE, 0.3), sampleRate: RATE, overlapMs: 120, wordCount: 0 });
      assert.equal(loud.decision, 'pause');
      assert.equal(loud.reason, 'loud');
      const long = detector.assess({ samples: sine(200, 500, RATE, 0.02), sampleRate: RATE, overlapMs: 400, wordCount: 0 });
      assert.equal(long.decision, 'pause');
      assert.equal(long.reason, 'long');
      const sharp = detector.assess({ samples: concat(sine(200, 40, RATE, 0.002), sine(200, 260, RATE, 0.03)), sampleRate: RATE, overlapMs: 120, wordCount: 0 });
      assert.equal(sharp.decision, 'pause');
      assert.equal(sharp.reason, 'sharp-onset');
      assert.ok(sharp.features.onsetRiseDb > 12);
      const words = detector.assess({ samples: sine(200, 150, RATE, 0.02), sampleRate: RATE, overlapMs: 120, wordCount: 2 });
      assert.equal(words.decision, 'pause');
      assert.equal(words.reason, 'words');
      const absolute = createFloorBidDetector({ baseline: null });
      const cold = absolute.assess({ samples: sine(200, 150, RATE, 0.01), sampleRate: RATE, overlapMs: 120, wordCount: 1 });
      assert.equal(cold.decision, 'continue', 'without a baseline the absolute -38 dBFS fallback applies');
      assert.equal(cold.features.quietReference, 'absolute');
      assert.equal(cold.features.quietDb, -38);
      const coldLoud = absolute.assess({ samples: sine(200, 150, RATE, 0.05), sampleRate: RATE, overlapMs: 120, wordCount: 0 });
      assert.equal(coldLoud.decision, 'pause');
    },
  },
  {
    name: 'practice call audio: track writer aligns played spans to the helper timeline sample by sample',
    run() {
      const dir = tempDir();
      const quantize = value => Math.round(Math.max(-1, Math.min(1, value)) * 32767) / 32768;
      const out = path.join(dir, 'interviewer.wav');
      const track = createInterviewerTrack({ sampleRate: 24000 });
      track.addUtterance('first', int16Pcm(24000, 0.5), 24000);
      track.started('first', 100);
      track.ended('first', 600, 700);
      track.addUtterance('second', int16Pcm(24000, 0.25), 24000);
      track.started('second', 500);
      track.paused('second', 400, 900);
      track.resumed('second', 1200);
      track.ended('second', 1000, 2200);
      const result = track.finalize(out, { durationMs: 2000, fs });
      assert.equal(result.sampleRate, 24000);
      const { sampleRate, samples } = readWav(out);
      assert.equal(sampleRate, 24000);
      assert.equal(samples.length, 48000, 'two seconds at 24 kHz');
      const expected = new Float32Array(48000);
      const place = (startMs, endMs, value) => {
        for (let i = Math.round(startMs * 24); i < Math.min(expected.length, Math.round(endMs * 24)); i += 1) expected[i] += value;
      };
      place(100, 700, 0.5);
      place(500, 900, 0.25);
      place(1200, 1800, 0.25);
      for (let i = 0; i < samples.length; i += 1) assert.equal(samples[i], quantize(expected[i]), `synthetic sample ${i} differs`);

      // A 16 kHz utterance is linearly resampled onto the 24 kHz timeline.
      const resampledPath = path.join(dir, 'resampled.wav');
      const resampled = createInterviewerTrack({ sampleRate: 24000 });
      resampled.addUtterance('low', int16Pcm(1600, 0.4), 16000);
      resampled.started('low', 0);
      resampled.finalize(resampledPath, { durationMs: 200, fs });
      const low = readWav(resampledPath);
      assert.equal(low.samples.length, 4800);
      assert.equal(low.samples[0], quantize(0.4));
      assert.equal(low.samples[2399], quantize(0.4));
      assert.equal(low.samples[2400], 0, 'the 100 ms utterance ends there');
      assert.equal(low.samples[4799], 0);

      // Overlapping utterances are summed and clipped to full scale.
      const loudPath = path.join(dir, 'overlap.wav');
      const loud = createInterviewerTrack({ sampleRate: 24000 });
      loud.addUtterance('a', int16Pcm(2400, 0.8), 24000);
      loud.addUtterance('b', int16Pcm(2400, 0.8), 24000);
      loud.started('a', 0);
      loud.started('b', 0);
      loud.finalize(loudPath, { durationMs: 100, fs });
      const clipped = readWav(loudPath);
      assert.equal(clipped.samples.length, 2400);
      for (const value of clipped.samples) assert.equal(value, 32767 / 32768, 'summed overlap clips at full scale');
    },
  },
  {
    name: 'practice call audio: mixdown upsamples the candidate, soft clips and reports the longer duration',
    run() {
      const dir = tempDir();
      const candidatePath = writeWav(path.join(dir, 'candidate.wav'), new Float32Array(4800).fill(0.2), 16000);
      const interviewerPath = writeWav(path.join(dir, 'interviewer.wav'), new Float32Array(4800).fill(0.3), 24000);
      const outPath = path.join(dir, 'mix.wav');
      const result = mixTracks({ candidatePath, interviewerPath, outPath, fs });
      assert.equal(result.durationMs, 300, 'the longer of the two tracks');
      const mixed = readWav(outPath);
      assert.equal(mixed.sampleRate, 24000);
      assert.equal(mixed.samples.length, 7200);
      const candidateValue = readWav(candidatePath).samples[0];
      const interviewerValue = readWav(interviewerPath).samples[0];
      for (let i = 0; i < 7200; i += 1) {
        const expected = Math.tanh(i < 4800 ? candidateValue + interviewerValue : candidateValue);
        assert.ok(Math.abs(mixed.samples[i] - expected) <= 2 / 32768, `mix sample ${i} ${mixed.samples[i]} vs ${expected}`);
      }
      const loudOut = path.join(dir, 'loud.wav');
      const loud = mixTracks({
        candidatePath: writeWav(path.join(dir, 'loud-candidate.wav'), new Float32Array(1600).fill(0.9), 16000),
        interviewerPath: writeWav(path.join(dir, 'loud-interviewer.wav'), new Float32Array(2400).fill(0.9), 24000),
        outPath: loudOut, fs,
      });
      assert.equal(loud.durationMs, 100);
      const clipped = readWav(loudOut);
      for (const value of clipped.samples) {
        assert.ok(value < 1, 'soft clip stays inside full scale');
        assert.ok(Math.abs(value - Math.tanh(1.8)) <= 2 / 32768, `soft clipped ${value}`);
      }
    },
  },
  {
    name: 'practice call audio: wav reader follows a still growing helper file and clamps to written audio',
    run() {
      const dir = tempDir();
      const file = path.join(dir, 'candidate.wav');
      writeWav(file, new Float32Array(0), 16000);
      const reader = openGrowingWav(file, { fs });
      assert.equal(reader.sampleRate, 16000);
      assert.equal(reader.writtenMs(), 0);
      assert.equal(reader.readMs(0, 100).length, 0, 'nothing written yet');
      const block = (value, frames) => {
        const bytes = Buffer.alloc(frames * 2);
        for (let i = 0; i < frames; i += 1) bytes.writeInt16LE(Math.round(value * 32768), i * 2);
        return bytes;
      };
      fs.appendFileSync(file, block(0.5, 760));
      assert.equal(reader.writtenMs(), 47.5);
      const first = reader.readMs(0, 47.5);
      assert.equal(first.length, 760);
      assert.equal(first[0], 0.5);
      fs.appendFileSync(file, block(0.25, 760));
      assert.equal(reader.writtenMs(), 95);
      const whole = reader.readMs(0, 1000);
      assert.equal(whole.length, 1520, 'reads clamp to the bytes written so far');
      assert.equal(whole[759], 0.5);
      assert.equal(whole[760], 0.25);
      const middle = reader.readMs(40, 55);
      assert.equal(middle.length, 240, '15 ms of audio crossing the block boundary');
      assert.equal(middle.slice(0, 120).filter(value => value !== 0.5).length, 0, 'first half is the 0.5 block');
      assert.equal(middle.slice(120).filter(value => value !== 0.25).length, 0, 'second half is the 0.25 block');
      reader.close();
    },
  },
  {
    name: 'practice call audio: call metrics score a synthetic transcript per answer and across the call',
    run() {
      const transcript = [
        { speaker: 'interviewer', text: 'Tell me about a synthetic project.', startMs: 0, endMs: 3000 },
        { speaker: 'candidate', text: 'one two three four five six seven eight nine ten', startMs: 4000, endMs: 40000 },
        { speaker: 'interviewer', text: 'And a longer synthetic question?', startMs: 41000, endMs: 43000 },
        { speaker: 'candidate', text: 'alpha beta gamma delta epsilon', startMs: 45000, endMs: 230000 },
        { speaker: 'candidate', channel: 'chat', text: 'typed note here', startMs: 240000, endMs: 245000 },
        { speaker: 'interviewer', text: 'What about the end?', startMs: 250000, endMs: 254000 },
        { speaker: 'candidate', text: 'sorry could you say that again', startMs: 253000, endMs: 258000 },
      ];
      const prosodyByTurn = {
        1: { speechMs: 30000, pauses: [{ startMs: 10000, endMs: 11200 }, { startMs: 20000, endMs: 23000 }], pitchRangeSt: 10, loudnessDb: -20 },
        3: { speechMs: 100000, pauses: [{ startMs: 60000, endMs: 61500 }], pitchRangeSt: 8, loudnessDb: -22 },
        6: { speechMs: 4000, pauses: [], pitchRangeSt: 9, loudnessDb: -21 },
      };
      const metrics = callMetrics({ transcript, candidateProsodyByTurn: prosodyByTurn, baselineSnapshot: { pitchRangeSt: 8, loudnessDb: -20 } });
      assert.equal(metrics.answerCount, 3);
      assert.equal(metrics.typedAnswerCount, 1);
      assert.deepEqual(metrics.typedAnswers, [{ startMs: 240000, endMs: 245000, wordCount: 3, text: 'typed note here' }]);
      const [first, second, third] = metrics.answers;
      assert.equal(first.wordsPerMinute, 20, '10 synthetic words over 30 s of speech');
      assert.equal(first.fastest20sWindowWpm, 18);
      assert.equal(first.pausesOver1s, 2);
      assert.equal(first.pausesOver2s, 1);
      assert.equal(first.longestPauseMs, 3000);
      assert.equal(first.responseLatencyMs, 1000);
      assert.equal(first.longAnswer, false);
      assert.equal(first.pitchRangeDeltaSt, 2);
      assert.equal(first.loudnessDeltaDb, 0);
      assert.equal(second.wordsPerMinute, 3);
      assert.equal(second.longAnswer, true, '185 s is over the two minute flag');
      assert.equal(second.responseLatencyMs, 2000);
      assert.equal(second.pausesOver1s, 1);
      assert.equal(second.pausesOver2s, 0);
      assert.equal(third.wordsPerMinute, 90);
      assert.equal(third.fastest20sWindowWpm, 72, 'a short answer is one window');
      assert.equal(third.responseLatencyMs, 0, 'negative latency clamps to zero');
      assert.equal(metrics.talkRatio, 0.937);
      assert.equal(metrics.candidateTalkMs, 134000);
      assert.equal(metrics.interviewerTalkMs, 9000);
      assert.deepEqual(metrics.candidateInterruptions, [{
        turnIndex: 6, atMs: 253000, interviewerFirstIndex: 5, interviewerEndMs: 254000, overlapMs: 1000, beforeQuestionFinished: true,
      }]);
      assert.equal(metrics.longAnswerCount, 1);
      assert.equal(metrics.pausesOver1s, 3);
      assert.equal(metrics.pausesOver2s, 1);
      assert.equal(metrics.fastest20sWindowWpm, 72);
      const backchannel = callMetrics({
        transcript: [
          { speaker: 'interviewer', text: 'Synthetic question, still going.', startMs: 0, endMs: 5000 },
          { speaker: 'candidate', text: 'mm-hm', startMs: 1000, endMs: 1400, acknowledgement: true },
        ],
      });
      assert.equal(backchannel.interruptionCount, 0, 'acknowledgements are not interruptions');
    },
  },
  {
    name: 'practice call audio: only the file modules touch fs and every module has its contract export',
    run() {
      const source = name => fs.readFileSync(new URL(`../../electron/practiceCall/audio/${name}`, import.meta.url), 'utf8');
      const pure = ['pitch.js', 'prosody.js', 'baseline.js', 'toneNote.js', 'floorBid.js', 'callMetrics.js'];
      for (const name of pure) {
        assert.equal(source(name).includes('node:fs'), false, `${name} must stay pure`);
        assert.equal(source(name).includes('require('), false, `${name} is ESM only`);
      }
      const contracts = {
        'wavReader.js': 'openGrowingWav',
        'pitch.js': 'trackPitch',
        'prosody.js': 'turnProsody',
        'baseline.js': 'createVoiceBaseline',
        'toneNote.js': 'composeVoiceNote',
        'floorBid.js': 'createFloorBidDetector',
        'trackWriter.js': 'createInterviewerTrack',
        'mixdown.js': 'mixTracks',
        'callMetrics.js': 'callMetrics',
      };
      for (const [name, exported] of Object.entries(contracts)) {
        const text = source(name);
        assert.ok(text.includes(`export function ${exported}`), `${name} exports ${exported}`);
        assert.ok(text.includes('export default'), `${name} has a default export`);
      }
      assert.ok(source('wavReader.js').includes('fs = nodeFs'), 'wavReader defaults to node:fs and accepts an injected fs');
      assert.ok(source('wavReader.js').includes('readSync'), 'wavReader reads through fs');
      assert.equal(source('mixdown.js').includes('node:fs'), false, 'mixdown touches only the fs it is given');
      assert.ok(source('mixdown.js').includes('mixTracks requires fs'), 'mixdown requires an injected fs');
      assert.ok(source('mixdown.js').includes('writeSync'), 'mixdown streams through fs');
      assert.ok(source('trackWriter.js').includes('writeSync'), 'trackWriter writes through the injected fs');
      assert.equal(source('trackWriter.js').includes('node:fs'), false, 'trackWriter only touches the fs it is given');
    },
  },
  {
    name: "practice call audio: mixdown resamples a 44.1 kHz interviewer onto the 24 kHz timeline",
    run() {
      const dir = tempDir();
      const candidatePath = writeWav(path.join(dir, "candidate.wav"), silence(100, 16000), 16000);
      const interviewer = concat(silence(100, 44100), new Float32Array(4410).fill(0.5), silence(200, 44100));
      const interviewerPath = writeWav(path.join(dir, "interviewer.wav"), interviewer, 44100);
      const outPath = path.join(dir, "mix.wav");
      const result = mixTracks({ candidatePath, interviewerPath, outPath, fs });
      assert.equal(result.durationMs, 400);
      const mixed = readWav(outPath);
      assert.equal(mixed.samples.length, 9600);
      let first = -1;
      let last = -1;
      for (let i = 0; i < mixed.samples.length; i += 1) {
        if (mixed.samples[i] > 0.2) { if (first < 0) first = i; last = i; }
      }
      assert.ok(first >= 2399 && first <= 2401, "tone starts at 100 ms, not 183.75 ms: " + first);
      assert.ok(last >= 4798 && last <= 4800, "tone ends at 200 ms: " + last);
    },
  },

];
