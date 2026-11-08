import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  extractWhisperFeatures, N_MELS, N_FRAMES, SAMPLE_COUNT,
} from '../../electron/practiceCall/models/whisperFeatures.js';
import { createSmartTurn } from '../../electron/practiceCall/models/smartTurn.js';
import { createToneModel } from '../../electron/practiceCall/models/toneModel.js';
import { MODEL_SPECS, createModelStore } from '../../electron/practiceCall/models/modelStore.js';
import {
  createPracticeInference, END_OF_TURN, resolveWorkerPath, TONE,
} from '../../electron/practiceCall/models/inferenceWorker.js';
import {
  createRequestQueue, FAKE_TONE_SCORES, FAKE_TURN_LOGIT,
} from '../../electron/practiceCall/models/inferenceWorkerThread.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerThreadPath = path.join(here, '..', '..', 'electron', 'practiceCall', 'models', 'inferenceWorkerThread.js');
const fixtureDir = path.join(here, '..', 'fixtures');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));

// The fixture's documented generator, written out independently of
// whisperFeatures.js: x[i] = env*(0.3*sin(2pi*(180+40t)t)+0.15*sin(2pi*440t))
// + 0.05*noise; env = 0.5*(1+sin(2pi*3t)); one LCG step BEFORE each noise
// sample; float32 output.
function syntheticSignal(samples, seed) {
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

function stats(values) {
  let sum = 0;
  let squares = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    sum += value;
    squares += value * value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const mean = sum / values.length;
  return { mean, std: Math.sqrt(squares / values.length - mean * mean), min, max };
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Fake ort that records tensors/feeds and returns fixed outputs.
function fakeOrt(values, { outputName = 'logits' } = {}) {
  const record = { created: [], tensors: [], feeds: [], released: 0, runs: 0 };
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
      record.tensors.push(this);
    }
  }
  const InferenceSession = {
    async create(modelPath) {
      record.created.push(modelPath);
      return {
        modelPath,
        async run(feeds) {
          record.runs += 1;
          record.feeds.push(feeds);
          return { [outputName]: { data: Float32Array.from(values), dims: [1, values.length] } };
        },
        async release() { record.released += 1; },
      };
    },
  };
  return { ort: { Tensor, InferenceSession }, record };
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function md5(buffer) { return createHash('md5').update(buffer).digest('hex'); }

function tempRoot(prefix) { return fsp.mkdtemp(path.join(os.tmpdir(), prefix)); }

function chunkedResponse(buffer, chunkSize = 7) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.subarray(i, Math.min(i + chunkSize, buffer.length)));
  }
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(buffer.length) : null) },
    body: Readable.from(chunks),
  };
}

const whisperFixture = {
  name: 'practice call models: whisper features match the Smart Turn fixture',
  run() {
    const fixture = readFixture('smart-turn-reference.json');
    assert.equal(fixture.cases.length, 3);
    for (const item of fixture.cases) {
      const features = extractWhisperFeatures(syntheticSignal(item.samples, item.seed));
      assert.ok(features instanceof Float32Array);
      assert.deepEqual([N_MELS, N_FRAMES], item.shape);
      assert.equal(features.length, N_MELS * N_FRAMES);
      for (const [mel, frame, expected] of item.probe) {
        const actual = features[mel * N_FRAMES + frame];
        assert.ok(
          Math.abs(actual - expected) <= 1e-3,
          `${item.name} probe [${mel},${frame}]: got ${actual}, expected ${expected}`,
        );
      }
      const measured = stats(features);
      assert.ok(Math.abs(measured.mean - item.mean) <= 1e-3, `${item.name} mean ${measured.mean} vs ${item.mean}`);
      assert.ok(Math.abs(measured.std - item.std) <= 1e-3, `${item.name} std ${measured.std} vs ${item.std}`);
      assert.ok(Math.abs(measured.min - item.min) <= 1e-3, `${item.name} min ${measured.min} vs ${item.min}`);
      assert.ok(Math.abs(measured.max - item.max) <= 1e-3, `${item.name} max ${measured.max} vs ${item.max}`);
    }
  },
};

const paddingFixture = {
  name: 'practice call models: whisper features keep the last 8 s and pad at the start',
  run() {
    const short = syntheticSignal(16000, 23);
    const padded = new Float32Array(SAMPLE_COUNT);
    padded.set(short, SAMPLE_COUNT - short.length);
    const fromShort = extractWhisperFeatures(short);
    const fromPadded = extractWhisperFeatures(padded);
    assert.deepEqual(fromShort, fromPadded);
    const moved = new Float32Array(SAMPLE_COUNT);
    moved.set(short, 0);
    const shifted = extractWhisperFeatures(moved);
    let differences = 0;
    for (let i = 0; i < shifted.length; i += 1) {
      if (shifted[i] !== fromShort[i]) differences += 1;
    }
    assert.ok(differences > fromShort.length / 10, 'padding at the end must change the features');
    assert.equal(extractWhisperFeatures(new Float32Array(0)).length, N_MELS * N_FRAMES);
  },
};

const smartTurnFixture = {
  name: 'practice call models: smart turn feeds input_features [1,80,800] through the injected ort',
  async run() {
    const samples = syntheticSignal(32000, 31);
    const { ort, record } = fakeOrt([0.625]);
    const model = createSmartTurn({ modelPath: '/models/smart-turn.onnx', ort });
    assert.equal(await model.predict(samples), 0.625);
    assert.equal(await model.predict(samples), 0.625);
    assert.deepEqual(record.created, ['/models/smart-turn.onnx']);
    assert.equal(record.runs, 2);
    const tensor = record.tensors[0];
    assert.equal(tensor.type, 'float32');
    assert.deepEqual(tensor.dims, [1, 80, 800]);
    assert.equal(tensor.data.length, 64000);
    const expected = extractWhisperFeatures(samples);
    for (let i = 0; i < expected.length; i += 401) assert.equal(tensor.data[i], expected[i]);
    assert.deepEqual(Object.keys(record.feeds[0]), ['input_features']);
    assert.equal(record.feeds[0].input_features, tensor);
    await model.close();
    assert.equal(record.released, 1);
    await assert.rejects(() => model.predict(samples), /closed/);
  },
};

const toneFixture = {
  name: 'practice call models: tone model scores raw signal [1,N] as arousal/dominance/valence',
  async run() {
    const samples = Float32Array.from([0.5, -0.25, 0.125, 0, -0.75]);
    const { ort, record } = fakeOrt([0.5, 0.25, 0.75]);
    const model = createToneModel({ modelPath: '/models/tone.onnx', ort });
    assert.deepEqual(await model.score(samples), { arousal: 0.5, dominance: 0.25, valence: 0.75 });
    const tensor = record.tensors[0];
    assert.equal(tensor.type, 'float32');
    assert.deepEqual(tensor.dims, [1, 5]);
    assert.equal(tensor.data, samples, 'raw samples must be fed unchanged');
    assert.deepEqual(Object.keys(record.feeds[0]), ['signal']);
    assert.deepEqual(record.created, ['/models/tone.onnx']);
    await model.close();
    assert.equal(record.released, 1);
    await assert.rejects(() => model.score(samples), /closed/);
  },
};

const tests = [
  whisperFixture,
  paddingFixture,
  smartTurnFixture,
  toneFixture,
];

function testSpecs({ smartBytes, zipBytes, onnxBytes, smartSha, onnxSha }) {
  return {
    smartTurn: {
      name: 'smartTurn',
      fileName: 'smart-turn-test.onnx',
      url: 'https://example.invalid/smart-turn-test.onnx',
      bytes: smartBytes.length,
      sha256: smartSha || sha256(smartBytes),
    },
    tone: {
      name: 'tone',
      fileName: 'tone-test.onnx',
      url: 'https://example.invalid/tone-test.zip',
      bytes: zipBytes.length,
      modelBytes: onnxBytes.length,
      sha256: onnxSha || sha256(onnxBytes),
      archive: { md5: md5(zipBytes), extension: '.zip', entry: 'model.onnx' },
    },
  };
}

function unzipWriting(onnxBytes, calls) {
  return async (zipPath, destDir) => {
    calls.push({ zipPath, destDir });
    assert.ok(fs.existsSync(zipPath), 'the archive must exist when unzip runs');
    assert.ok(fs.existsSync(destDir), 'the destination directory must exist when unzip runs');
    await fsp.writeFile(path.join(destDir, 'model.onnx'), onnxBytes);
  };
}

const storeDownloadFixture = {
  name: 'practice call models: model store downloads, verifies, extracts and renames',
  async run() {
    const root = await tempRoot('practice-model-store-');
    try {
      const smartBytes = Buffer.from('smart-turn model bytes '.repeat(40));
      const zipBytes = Buffer.from('tone archive bytes '.repeat(21));
      const onnxBytes = Buffer.from('tone model.onnx bytes '.repeat(37));
      const specs = testSpecs({ smartBytes, zipBytes, onnxBytes });
      const fetches = [];
      const unzips = [];
      const fetchImpl = async (url) => {
        fetches.push(url);
        return chunkedResponse(url === specs.smartTurn.url ? smartBytes : zipBytes);
      };
      const store = createModelStore({
        rootDir: root, fetch: fetchImpl, fs: fsp, unzip: unzipWriting(onnxBytes, unzips), specs,
      });
      assert.deepEqual(store.status(), { smartTurn: 'missing', tone: 'missing' });

      const progress = [];
      const pending = store.ensure('smartTurn', { onProgress: (item) => progress.push(item) });
      assert.equal(store.status().smartTurn, 'downloading');
      const smartPath = await pending;
      assert.equal(smartPath, path.join(root, 'smart-turn-test.onnx'));
      assert.equal(store.pathOf('smartTurn'), smartPath);
      assert.equal(store.status().smartTurn, 'ready');
      assert.equal(store.status().tone, 'missing');
      assert.ok((await fsp.readFile(smartPath)).equals(smartBytes));
      assert.ok(progress.length > 2, 'progress must be reported while streaming');
      assert.deepEqual(progress[0], { name: 'smartTurn', receivedBytes: 0, totalBytes: smartBytes.length });
      assert.equal(progress.at(-1).receivedBytes, smartBytes.length);
      assert.equal(progress.at(-1).totalBytes, smartBytes.length);
      for (let i = 1; i < progress.length; i += 1) {
        assert.ok(progress[i].receivedBytes >= progress[i - 1].receivedBytes, 'progress must not go backwards');
      }
      assert.deepEqual((await fsp.readdir(root)).sort(), ['smart-turn-test.onnx']);

      const toneProgress = [];
      const tonePath = await store.ensure('tone', { onProgress: (item) => toneProgress.push(item) });
      assert.equal(tonePath, path.join(root, 'tone-test.onnx'));
      assert.ok((await fsp.readFile(tonePath)).equals(onnxBytes));
      assert.equal(unzips.length, 1);
      assert.match(unzips[0].zipPath, /\.zip$/);
      assert.ok(path.dirname(unzips[0].zipPath) === root);
      assert.ok(path.dirname(unzips[0].destDir) === root);
      assert.equal(toneProgress.at(-1).receivedBytes, zipBytes.length);
      assert.deepEqual((await fsp.readdir(root)).sort(), ['smart-turn-test.onnx', 'tone-test.onnx']);
      assert.deepEqual(store.status(), { smartTurn: 'ready', tone: 'ready' });

      const before = fetches.length;
      assert.equal(await store.ensure('smartTurn'), smartPath);
      assert.equal(fetches.length, before, 'ready models must not be downloaded again');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
};

const storeRejectFixture = {
  name: 'practice call models: model store rejects bad hashes and leaves no half files',
  async run() {
    const root = await tempRoot('practice-model-store-bad-');
    try {
      const bytes = Buffer.from('downloaded bytes that do not match the pin');
      const other = Buffer.from('some other payload');
      const badSmart = createModelStore({
        rootDir: root,
        fetch: async () => chunkedResponse(bytes),
        fs: fsp,
        unzip: unzipWriting(other, []),
        specs: testSpecs({ smartBytes: bytes, zipBytes: bytes, onnxBytes: other, smartSha: sha256(other) }),
      });
      await assert.rejects(() => badSmart.ensure('smartTurn'), /sha256 mismatch/);
      assert.deepEqual(await fsp.readdir(root), []);
      assert.equal(fs.existsSync(badSmart.pathOf('smartTurn')), false);
      assert.equal(badSmart.status().smartTurn, 'missing');

      const badTone = createModelStore({
        rootDir: root,
        fetch: async () => chunkedResponse(bytes),
        fs: fsp,
        unzip: unzipWriting(other, []),
        specs: testSpecs({ smartBytes: bytes, zipBytes: bytes, onnxBytes: other, onnxSha: sha256(bytes) }),
      });
      await assert.rejects(() => badTone.ensure('tone'), /sha256 mismatch/);
      assert.deepEqual(await fsp.readdir(root), [], 'zip and extract dir must be removed');
      assert.equal(fs.existsSync(badTone.pathOf('tone')), false);
      assert.equal(badTone.status().tone, 'missing');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
};

const storeAbortFixture = {
  name: 'practice call models: model store honours AbortSignal during a download',
  async run() {
    const root = await tempRoot('practice-model-store-abort-');
    try {
      const bytes = Buffer.from('a'.repeat(500));
      const controller = new AbortController();
      const body = (async function* bodyChunks() {
        yield bytes.subarray(0, 100);
        await delay(2);
        yield bytes.subarray(100);
      })();
      const store = createModelStore({
        rootDir: root,
        fetch: async (url, init) => {
          assert.equal(init.signal, controller.signal);
          return {
            ok: true,
            status: 200,
            headers: { get: () => String(bytes.length) },
            body,
          };
        },
        fs: fsp,
        unzip: unzipWriting(bytes, []),
        specs: testSpecs({ smartBytes: bytes, zipBytes: bytes, onnxBytes: bytes }),
      });
      await assert.rejects(
        () => store.ensure('smartTurn', {
          signal: controller.signal,
          onProgress: (item) => { if (item.receivedBytes > 0) controller.abort(); },
        }),
        (error) => error.name === 'AbortError' || error.code === 'ABORT_ERR',
      );
      assert.deepEqual(await fsp.readdir(root), []);
      assert.equal(fs.existsSync(store.pathOf('smartTurn')), false);
      assert.equal(store.status().smartTurn, 'missing');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  },
};

const pinnedSpecFixture = {
  name: 'practice call models: pinned model specs match the build contract',
  run() {
    assert.deepEqual(Object.keys(MODEL_SPECS).sort(), ['smartTurn', 'tone']);
    const smart = MODEL_SPECS.smartTurn;
    assert.equal(smart.url, 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-gpu.onnx');
    assert.equal(smart.sha256, 'ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be');
    assert.equal(smart.bytes, 32411198);
    assert.equal(smart.fileName, 'smart-turn-v3.2-gpu.onnx');
    const tone = MODEL_SPECS.tone;
    assert.equal(tone.url, 'https://zenodo.org/api/records/6221127/files/w2v2-L-robust-12.6bc4a7fd-1.1.0.zip/content');
    assert.equal(tone.sha256, '9b6e449686c0db86f5c607b8c9fa1d87468c27198a1f0a20280c4e258239763d');
    assert.equal(tone.archive.md5, '76fef8c090addd7fcee60c64e9536ced');
    assert.equal(tone.md5, tone.archive.md5);
    assert.equal(tone.bytes, 609889780);
    assert.equal(tone.modelBytes, 661423381);
    assert.equal(tone.fileName, 'tone.onnx');
    assert.equal(tone.archive.entry, 'model.onnx');
    assert.equal(tone.archive.extension, '.zip');
    assert.ok(Object.isFrozen(tone.archive));
  },
};

tests.push(
  storeDownloadFixture,
  storeRejectFixture,
  storeAbortFixture,
  pinnedSpecFixture,
);

function attachWorkerLogic(worker, delays) {
  const starts = [];
  const concurrency = { active: 0, max: 0 };
  worker.starts = starts;
  worker.concurrency = concurrency;
  const track = async (kind, samples, value, wait) => {
    starts.push([kind, samples.length]);
    concurrency.active += 1;
    concurrency.max = Math.max(concurrency.max, concurrency.active);
    await delay(wait);
    concurrency.active -= 1;
    return value;
  };
  const queue = createRequestQueue({
    runEndOfTurn: (samples) => track(END_OF_TURN, samples, 0.75, delays.endOfTurn || 0),
    runTone: (samples) => track(TONE, samples, { arousal: 0.1, dominance: 0.2, valence: 0.3 }, delays.tone || 0),
    onResult: (id, value) => worker.emit('message', { type: 'result', id, value }),
    onError: (id, error) => worker.emit('message', { type: 'error', id, message: error.message }),
  });
  worker.on('posted', (message) => {
    if (message.type === 'request') queue.push(message.kind, message.id, message.samples);
  });
  worker.queue = queue;
}

// Minimal stand-in for a worker_threads Worker: same postMessage/on/terminate
// surface, with attachWorkerLogic replaying the real worker scheduling core.
function fakeWorkerFactory({ delays = {}, respond = true } = {}) {
  const workers = [];
  const factory = (options) => {
    const listeners = new Map();
    const worker = {
      options,
      messages: [],
      transfers: [],
      terminated: 0,
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) || []), fn]);
        return worker;
      },
      emit(event, payload) {
        for (const fn of listeners.get(event) || []) fn(payload);
      },
      postMessage(message, transferList) {
        worker.messages.push(message);
        worker.transfers.push(transferList || []);
        worker.emit('posted', message);
      },
      async terminate() {
        worker.terminated += 1;
        worker.emit('exit', 0);
      },
    };
    if (respond) attachWorkerLogic(worker, delays);
    workers.push(worker);
    return worker;
  };
  factory.workers = workers;
  return factory;
}

const workerPriorityFixture = {
  name: 'practice call models: inference worker serves endOfTurn before queued tone requests',
  async run() {
    const factory = fakeWorkerFactory({ delays: { tone: 4, endOfTurn: 1 } });
    const inference = createPracticeInference({
      smartTurnPath: '/models/smart-turn.onnx',
      tonePath: '/models/tone.onnx',
      createWorker: factory,
    });
    assert.equal(factory.workers.length, 1);
    const order = [];
    const toneOne = inference.tone(new Float32Array(3200)).then((value) => { order.push('tone-1'); return value; });
    const toneTwo = inference.tone(new Float32Array(6400)).then((value) => { order.push('tone-2'); return value; });
    const end = inference.endOfTurn(new Float32Array(16000)).then((value) => { order.push('endOfTurn'); return value; });
    const [toneFirst, toneSecond, endValue] = await Promise.all([toneOne, toneTwo, end]);
    assert.deepEqual(order, ['tone-1', 'endOfTurn', 'tone-2']);
    const worker = factory.workers[0];
    assert.deepEqual(worker.starts, [[TONE, 3200], [END_OF_TURN, 16000], [TONE, 6400]]);
    assert.equal(worker.concurrency.max, 1, 'one request at a time in the worker');
    assert.deepEqual(toneFirst, { arousal: 0.1, dominance: 0.2, valence: 0.3 });
    assert.deepEqual(toneSecond, { arousal: 0.1, dominance: 0.2, valence: 0.3 });
    assert.equal(endValue, 0.75);
    await inference.close();
    assert.equal(worker.terminated, 1);
  },
};

const workerHostFixture = {
  name: 'practice call models: inference host transfers buffers to one worker and closes it',
  async run() {
    const factory = fakeWorkerFactory();
    const inference = createPracticeInference({
      smartTurnPath: '/models/smart-turn.onnx',
      tonePath: '/models/tone.onnx',
      createWorker: factory,
    });
    const worker = factory.workers[0];
    assert.deepEqual(worker.options, {
      smartTurnPath: '/models/smart-turn.onnx',
      tonePath: '/models/tone.onnx',
    });
    const samples = new Float32Array(800).fill(0.25);
    const pending = inference.endOfTurn(samples);
    assert.equal(worker.messages.length, 1);
    assert.equal(worker.messages[0].type, 'request');
    assert.equal(worker.messages[0].kind, END_OF_TURN);
    assert.equal(worker.messages[0].samples, samples);
    assert.deepEqual(worker.transfers[0], [samples.buffer]);
    assert.equal(await pending, 0.75);
    assert.deepEqual(await inference.tone(new Float32Array(1600)), {
      arousal: 0.1, dominance: 0.2, valence: 0.3,
    });
    assert.equal(worker.messages[1].kind, TONE);
    assert.equal(factory.workers.length, 1, 'both models share one worker');
    assert.equal(worker.terminated, 0);
    await inference.close();
    assert.equal(worker.terminated, 1);
    assert.equal(worker.messages.at(-1).type, 'close');
    await assert.rejects(() => inference.endOfTurn(samples), /closed/);
    await inference.close();
    assert.equal(worker.terminated, 1, 'close is idempotent');
  },
};

const workerErrorFixture = {
  name: 'practice call models: inference host rejects failed requests',
  async run() {
    const factory = fakeWorkerFactory({ respond: false });
    const inference = createPracticeInference({
      smartTurnPath: '/models/smart-turn.onnx',
      tonePath: '/models/tone.onnx',
      createWorker: factory,
    });
    const worker = factory.workers[0];
    const pending = inference.endOfTurn(new Float32Array(16));
    const request = worker.messages[0];
    worker.emit('message', { type: 'error', id: request.id, message: 'model exploded' });
    await assert.rejects(() => pending, /model exploded/);
    const pendingTone = inference.tone(new Float32Array(16));
    worker.emit('error', new Error('worker crashed'));
    await assert.rejects(() => pendingTone, /worker crashed/);
    await assert.rejects(() => inference.tone(new Float32Array(16)), /worker crashed/);
    await inference.close();
  },
};

const workerPathFixture = {
  name: 'practice call models: only the source module may infer the worker entry; a bundle must name it',
  run() {
    const source = 'file:///app/electron/practiceCall/models/inferenceWorker.js';
    assert.equal(
      resolveWorkerPath({ metaUrl: source }),
      fileURLToPath(new URL('./inferenceWorkerThread.js', source)),
    );
    const bundled = 'file:///app/dist-electron/main.cjs';
    assert.throws(() => resolveWorkerPath({ metaUrl: bundled }), /requires workerPath/);
    assert.throws(() => resolveWorkerPath({ metaUrl: bundled, workerPath: '' }), /requires workerPath/);
    const explicit = '/app/dist-electron/inferenceWorkerThread.js';
    assert.equal(resolveWorkerPath({ metaUrl: bundled, workerPath: explicit }), explicit);
  },
};

// The real thread: a genuine worker_threads Worker running the real
// inferenceWorkerThread.js, with workerData.fakeOrt swapping onnxruntime-node
// for the thread's in-file fake session factory.
const realWorkerFixture = {
  name: 'practice call models: the real worker thread answers tone and endOfTurn, endOfTurn first',
  async run() {
    const inference = createPracticeInference({
      smartTurnPath: '/models/smart-turn.onnx',
      tonePath: '/models/tone.onnx',
      workerPath: workerThreadPath,
      workerData: { fakeOrt: { toneDelayMs: 80, endOfTurnDelayMs: 5 } },
    });
    try {
      const order = [];
      const toneOne = inference.tone(new Float32Array(3200)).then((value) => { order.push('tone-1'); return value; });
      const toneTwo = inference.tone(new Float32Array(6400)).then((value) => { order.push('tone-2'); return value; });
      const end = inference.endOfTurn(new Float32Array(16000)).then((value) => { order.push('endOfTurn'); return value; });
      const [toneFirst, toneSecond, endValue] = await Promise.all([toneOne, toneTwo, end]);
      assert.deepEqual(order, ['tone-1', 'endOfTurn', 'tone-2'], 'a queued endOfTurn jumps the tone queue');
      assert.deepEqual(toneFirst, { ...FAKE_TONE_SCORES });
      assert.deepEqual(toneSecond, { ...FAKE_TONE_SCORES });
      assert.equal(endValue, FAKE_TURN_LOGIT);
    } finally {
      await inference.close();
    }
  },
};

tests.push(
  workerPriorityFixture, workerHostFixture, workerErrorFixture, workerPathFixture, realWorkerFixture,
);

export default tests;
