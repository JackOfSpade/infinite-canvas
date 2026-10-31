import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterviewAudioDebugLog, createInterviewCallAudioService } from '../../electron/interviewCallAudio.js';

const LIMIT_BYTES = 5 * 1024 * 1024;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'interview-audio-debug-'));
const readLines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
async function withDebugPath(filePath, run) {
  const previous = process.env.INTERVIEW_AUDIO_DEBUG_LOG;
  if (filePath === undefined) delete process.env.INTERVIEW_AUDIO_DEBUG_LOG;
  else process.env.INTERVIEW_AUDIO_DEBUG_LOG = filePath;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.INTERVIEW_AUDIO_DEBUG_LOG;
    else process.env.INTERVIEW_AUDIO_DEBUG_LOG = previous;
  }
}
function nativeHarness(onQuestion) {
  let time = 0; let poll; let child;
  const service = createInterviewCallAudioService({
    platform: 'darwin', arch: 'arm64', helperPath: '/tmp/synthetic-audio-helper', now: () => time,
    onQuestion,
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => undefined;
      child.stderr = { resume() {} }; child.stdin = new EventEmitter(); child.stdin.end = () => undefined;
      child.kill = () => true;
      return child;
    },
    setIntervalFn: callback => { poll = callback; return 1; }, clearIntervalFn: () => { poll = null; },
    setTimeoutFn: () => 2, clearTimeoutFn: () => undefined,
  });
  return { service, at(value) { time = value; }, poll() { poll?.(); },
    send(value) { child.stdout.emit('data', `${JSON.stringify(value)}\n`); } };
}
const question = { type: 'transcript', segmentId: '0', text: 'Tell me about leading a team.', final: true, startMs: 0, endMs: 800 };

export default [
  { name: 'interview call audio debug: unset environment performs no filesystem access or writes', async run() {
    let accesses = 0;
    const io = new Proxy({}, { get() { accesses += 1; throw new Error('Unexpected diagnostic filesystem access.'); } });
    const log = createInterviewAudioDebugLog({ env: {}, io });
    log.write('helper-event', { event: question }, 10); log.close();
    assert.equal(accesses, 0);
    const directory = temporaryDirectory();
    try {
      await withDebugPath(undefined, async () => {
        const h = nativeHarness((_endpoint, _current, report) => report({ accepted: true }));
        try {
          h.service.start(); h.send({ type: 'status', state: 'listening' }); h.send({ type: 'activity', speaking: true });
          h.at(100); h.send(question); h.at(200); h.send({ type: 'activity', speaking: false });
          h.at(1000); h.poll(); await flush();
          assert.equal(h.service.getQuestion(), question.text);
          assert.deepEqual(fs.readdirSync(directory), []);
        } finally { h.service.stop(); }
      });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } },
  { name: 'interview call audio debug: opt-in captures raw helper, detector and selection receipt clocks in private append-only JSONL', async run() {
    const directory = temporaryDirectory(); const file = path.join(directory, 'audio.jsonl');
    try {
      await withDebugPath(file, async () => {
        const h = nativeHarness((endpoint, isCurrent, report) => {
          assert.equal(isCurrent(), true); h.at(1005); report({ stage: 'semantic', accepted: true, question: endpoint.text });
        });
        try {
          h.service.start(); h.send({ type: 'status', state: 'listening' }); h.send({ type: 'activity', speaking: true });
          h.at(100); h.send({ ...question, text: `${question.text}\u0001` });
          h.at(200); h.send({ type: 'activity', speaking: false }); h.at(1000); h.poll(); await flush();
          const lines = readLines(file);
          const raw = lines.find(line => line.type === 'helper-event' && line.event.type === 'transcript');
          assert.equal(raw.event.text, `${question.text}\u0001`); assert.equal(raw.receivedAtMs, 100);
          assert(lines.some(line => line.type === 'detector-receive' && line.eventType === 'transcript' && line.accepted));
          const endpoint = lines.find(line => line.type === 'detector-endpoint');
          assert.equal(endpoint.receivedAtMs, 1000); assert.equal(endpoint.endpoint.text, question.text);
          const selection = lines.find(line => line.type === 'selection');
          assert.deepEqual(selection, { type: 'selection', receivedAtMs: 1005, endpointId: endpoint.endpoint.id,
            decision: { stage: 'semantic', accepted: true, question: question.text } });
          assert.equal(fs.statSync(file).mode & 0o777, 0o600);
          const before = fs.readFileSync(file, 'utf8');
          h.service.stop(); h.service.start(); h.send({ type: 'status', state: 'listening' });
          assert(fs.readFileSync(file, 'utf8').startsWith(before), 'reopening must append without truncating');
        } finally { h.service.stop(); }
      });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } },
  { name: 'interview call audio debug: invalid paths, links and nonprivate files fail closed without writes', run() {
    const directory = temporaryDirectory();
    try {
      const publicFile = path.join(directory, 'public.jsonl'); fs.writeFileSync(publicFile, 'private transcript', { mode: 0o644 });
      const target = path.join(directory, 'target.jsonl'); fs.writeFileSync(target, 'do not append', { mode: 0o600 });
      const link = path.join(directory, 'link.jsonl'); fs.symlinkSync(target, link);
      const hardLink = path.join(directory, 'hard.jsonl'); fs.linkSync(target, hardLink);
      const invalid = ['relative.jsonl', path.join(directory, 'bad\nname.jsonl'), path.join(directory, 'missing', 'log.jsonl'), directory, publicFile, link, hardLink];
      for (const file of invalid) {
        const log = createInterviewAudioDebugLog({ env: { INTERVIEW_AUDIO_DEBUG_LOG: file } });
        log.write('helper-event', { event: question }, 1); log.close();
      }
      assert.equal(fs.readFileSync(publicFile, 'utf8'), 'private transcript');
      assert.equal(fs.readFileSync(target, 'utf8'), 'do not append');
      assert.deepEqual(fs.readdirSync(directory).sort(), ['hard.jsonl', 'link.jsonl', 'public.jsonl', 'target.jsonl']);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } },
  { name: 'interview call audio debug: an hour of activity ticks logs edges once and preserves later turn diagnostics', async run() {
    const directory = temporaryDirectory(); const file = path.join(directory, 'activity.jsonl');
    try {
      await withDebugPath(file, async () => {
        const h = nativeHarness((_endpoint, _current, report) => report({ accepted: true }));
        try {
          h.service.start(); h.send({ type: 'status', state: 'listening' });
          for (let tick = 0; tick <= 36_000; tick += 1) {
            h.at(tick * 100); h.send({ type: 'activity', speaking: false }); h.poll();
          }
          h.at(3_600_100); h.send({ type: 'activity', speaking: true });
          h.at(3_600_200); h.send(question);
          h.at(3_600_300); h.send({ type: 'activity', speaking: false });
          h.at(3_601_100); h.poll(); await flush();
          const lines = readLines(file);
          assert.deepEqual(lines.filter(line => line.type === 'helper-event' && line.event.type === 'activity')
            .map(line => line.event.speaking), [false, true, false]);
          assert.equal(lines.filter(line => line.type === 'detector-receive' && line.eventType === 'activity').length, 0);
          assert(lines.some(line => line.type === 'detector-endpoint' && line.endpoint.text === question.text));
          assert(lines.some(line => line.type === 'selection' && line.decision.accepted));
          assert(fs.statSync(file).size < 2000);
        } finally { h.service.stop(); }
      });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } },
  { name: 'interview call audio debug: cap reserves an explicit final marker and closes without exceeding five MiB', run() {
    const directory = temporaryDirectory(); const file = path.join(directory, 'capped.jsonl');
    try {
      fs.writeFileSync(file, `${' '.repeat(LIMIT_BYTES - 1000 - 1)}\n`, { mode: 0o600 });
      const log = createInterviewAudioDebugLog({ env: { INTERVIEW_AUDIO_DEBUG_LOG: file } });
      log.write('test', { value: 'small' }, 1);
      const firstSize = fs.statSync(file).size;
      assert(firstSize > LIMIT_BYTES - 1000 && firstSize <= LIMIT_BYTES);
      log.write('test', { value: 'x'.repeat(1000) }, 2); log.write('test', { value: 'small' }, 3); log.close();
      const cappedSize = fs.statSync(file).size;
      assert(cappedSize > firstSize && cappedSize <= LIMIT_BYTES);
      const lines = readLines(file);
      assert.equal(lines.length, 2);
      assert.deepEqual(lines.at(-1), { type: 'log-capped', receivedAtMs: 2, reason: 'size-limit', limitBytes: LIMIT_BYTES });
      const reopened = createInterviewAudioDebugLog({ env: { INTERVIEW_AUDIO_DEBUG_LOG: file } });
      reopened.write('detector-endpoint', { endpoint: { text: 'A later question?' } }, 4); reopened.close();
      const restarted = readLines(file);
      assert.deepEqual(restarted[0], { type: 'log-reset', reason: 'previous-log-capped', previousBytes: cappedSize });
      assert.equal(restarted[1].endpoint.text, 'A later question?');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } },
  { name: 'interview call audio debug: a later session reclaims a private full log and records new questions', run() {
    const directory = temporaryDirectory(); const file = path.join(directory, 'capped.jsonl');
    try {
      fs.writeFileSync(file, Buffer.alloc(LIMIT_BYTES, 32), { mode: 0o600 });
      const reopened = createInterviewAudioDebugLog({ env: { INTERVIEW_AUDIO_DEBUG_LOG: file } });
      reopened.write('detector-endpoint', { endpoint: { text: 'A later question?' } }, 4); reopened.close();
      const lines = readLines(file);
      assert.deepEqual(lines[0], { type: 'log-reset', reason: 'previous-log-capped', previousBytes: LIMIT_BYTES });
      assert.equal(lines[1].endpoint.text, 'A later question?');
      assert(fs.statSync(file).size < 1000);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } },
  { name: 'interview call audio debug: capped public and linked files are refused before reclamation', run() {
    const directory = temporaryDirectory();
    try {
      const contents = Buffer.alloc(LIMIT_BYTES, 32);
      const publicFile = path.join(directory, 'public.jsonl'); fs.writeFileSync(publicFile, contents, { mode: 0o644 });
      const target = path.join(directory, 'private.jsonl'); fs.writeFileSync(target, contents, { mode: 0o600 });
      const symlink = path.join(directory, 'symlink.jsonl'); fs.symlinkSync(target, symlink);
      const hardlink = path.join(directory, 'hardlink.jsonl'); fs.linkSync(target, hardlink);
      for (const file of [publicFile, symlink, hardlink, target]) {
        const log = createInterviewAudioDebugLog({ env: { INTERVIEW_AUDIO_DEBUG_LOG: file } });
        log.write('detector-endpoint', { endpoint: { text: 'Do not write this.' } }, 4); log.close();
      }
      assert.deepEqual(fs.readFileSync(publicFile), contents);
      assert.deepEqual(fs.readFileSync(target), contents);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } },
];
