#!/usr/bin/env node
// Real-model parity probe (not part of the unit suite).
//
//   node scripts/practice-probes/model-parity.mjs \
//     --smart-turn <smart-turn-v3.2-gpu.onnx> --tone <tone/model.onnx>
//
// Regenerates the synthetic fixture signals, runs the real models through the
// production modules with real onnxruntime-node, and prints max abs differences
// against scripts/fixtures/smart-turn-reference.json and tone-model-reference.json
// plus median ms per call (20 runs by default, including a 30 s tone signal).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWhisperFeatures, N_FRAMES } from '../../electron/practiceCall/models/whisperFeatures.js';
import { createSmartTurn } from '../../electron/practiceCall/models/smartTurn.js';
import { createToneModel } from '../../electron/practiceCall/models/toneModel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, '..', 'fixtures');
const USAGE = [
  'usage: node scripts/practice-probes/model-parity.mjs --smart-turn <onnx> --tone <onnx> [--runs 20]',
  '  --smart-turn  path to smart-turn-v3.2-gpu.onnx (Smart Turn probabilities)',
  '  --tone        path to the tone model.onnx (arousal/dominance/valence)',
  '  --runs        timed repetitions per call, default 20',
].join('\n');

// The fixture generator: one LCG step BEFORE each noise sample, float32 output.
export function syntheticSignal(samples, seed) {
  const out = new Float32Array(samples);
  let state = seed >>> 0;
  for (let i = 0; i < samples; i += 1) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const noise = state / 4294967296 - 0.5;
    const t = i / 16000;
    const env = 0.5 * (1 + Math.sin(2 * Math.PI * 3 * t));
    const tone = 0.3 * Math.sin(2 * Math.PI * (180 + 40 * t) * t) + 0.15 * Math.sin(2 * Math.PI * 440 * t);
    out[i] = Math.fround(env * tone + 0.05 * noise);
  }
  return out;
}

export function parseArgs(argv) {
  const options = { smartTurn: null, tone: null, runs: 20, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--smart-turn' || arg === '--smartTurn') options.smartTurn = next();
    else if (arg === '--tone') options.tone = next();
    else if (arg === '--runs') options.runs = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 2) {
    throw new Error('--runs must be an integer >= 2');
  }
  return options;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function timed(fn, runs) {
  const times = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    last = await fn();
    times.push(performance.now() - start);
  }
  return { medianMs: median(times), last, runs };
}

function statsOf(values) {
  let sum = 0;
  let squares = 0;
  for (const value of values) {
    sum += value;
    squares += value * value;
  }
  const mean = sum / values.length;
  return { mean, std: Math.sqrt(squares / values.length - mean * mean) };
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

async function probeSmartTurn(modelPath, ort, runs, log) {
  const fixture = readFixture('smart-turn-reference.json');
  log(`smart turn model: ${modelPath}`);
  const model = createSmartTurn({ modelPath, ort });
  try {
    for (const item of fixture.cases) {
      const signal = syntheticSignal(item.samples, item.seed);
      const features = extractWhisperFeatures(signal);
      const probeDiff = Math.max(...item.probe.map(([mel, frame, expected]) => (
        Math.abs(features[mel * N_FRAMES + frame] - expected)
      )));
      const measured = statsOf(features);
      log(`  ${item.name}: feature probe max abs diff ${probeDiff.toExponential(2)} `
        + `| mean diff ${Math.abs(measured.mean - item.mean).toExponential(2)} `
        + `| std diff ${Math.abs(measured.std - item.std).toExponential(2)}`);
      const probability = await model.predict(signal);
      log(`  ${item.name}: probability ${probability.toFixed(6)} vs fixture ${item.probability.toFixed(6)} `
        + `(abs diff ${Math.abs(probability - item.probability).toExponential(2)})`);
    }
    const timingSignal = syntheticSignal(144000, 11);
    const timing = await timed(() => model.predict(timingSignal), runs);
    log(`  predict 9 s signal: median ${timing.medianMs.toFixed(1)} ms over ${timing.runs} runs`);
    return timing;
  } finally {
    await model.close();
  }
}

async function probeTone(modelPath, ort, runs, log) {
  const fixture = readFixture('tone-model-reference.json');
  log(`tone model: ${modelPath}`);
  const model = createToneModel({ modelPath, ort });
  try {
    for (const item of fixture.cases) {
      const score = await model.score(syntheticSignal(item.samples, item.seed));
      const actual = [score.arousal, score.dominance, score.valence];
      const diff = Math.max(...actual.map((value, i) => Math.abs(value - item.logits[i])));
      log(`  ${item.name}: [${actual.map((value) => value.toFixed(6)).join(', ')}] `
        + `vs fixture [${item.logits.map((value) => value.toFixed(6)).join(', ')}] `
        + `| max abs diff ${diff.toExponential(2)}`);
    }
    const six = syntheticSignal(96000, 9);
    const timing = await timed(() => model.score(six), runs);
    log(`  score 6 s signal: median ${timing.medianMs.toFixed(1)} ms over ${timing.runs} runs`);
    const thirty = syntheticSignal(480000, 13);
    const timing30 = await timed(() => model.score(thirty), runs);
    log(`  score 30 s signal: median ${timing30.medianMs.toFixed(1)} ms over ${timing30.runs} runs`);
    return { timing, timing30 };
  } finally {
    await model.close();
  }
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log(error.message);
    log(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (!options.smartTurn && !options.tone) {
    log(USAGE);
    return 1;
  }
  const ort = await import('onnxruntime-node');
  if (options.smartTurn) await probeSmartTurn(options.smartTurn, ort, options.runs, log);
  if (options.tone) await probeTone(options.tone, ort, options.runs, log);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
