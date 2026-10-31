import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import { createInterviewCallAudioService, INTERVIEW_AUDIO_MESSAGES, interviewAudioHelperPath } from '../../electron/interviewCallAudio.js';
import { createInterviewWindowController } from '../../electron/interviewWindow.js';
import { interviewPreparedBriefRecordId } from '../../electron/ipc/interviewPreparation.js';
import { createInterviewWindowE2EFixture } from '../fixtures/interview-window-e2e.mjs';
import { buildInterviewAudioHelper } from '../build-interview-audio-helper.mjs';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function nativeHarness(extra = {}) {
  let time = 0; let poll; let spawnCount = 0;
  const states = []; const questions = []; const children = [];
  const service = createInterviewCallAudioService({ platform: 'darwin', arch: 'arm64', helperPath: '/tmp/synthetic-audio-helper', now: () => time,
    onState: state => states.push(state), onQuestion: (question, isCurrent) => questions.push({ question, isCurrent }),
    spawn: (command, args, options) => {
      spawnCount += 1;
      assert.equal(command, '/tmp/synthetic-audio-helper'); assert.equal(options.shell, false);
      assert.deepEqual(args, ['--parent-pid', String(process.pid), '--locale', 'en-US']);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdout.setEncoding = () => undefined;
      child.stderr = { resume() {} }; child.signals = [];
      child.stdin = new EventEmitter(); child.stdin.end = () => { child.ended = true; };
      child.kill = signal => { child.signals.push(signal); return true; };
      children.push(child); return child;
    },
    setIntervalFn: callback => { poll = callback; return 1; }, clearIntervalFn: () => { poll = null; },
    setTimeoutFn: () => 2, clearTimeoutFn: () => undefined, ...extra,
  });
  return { service, states, questions, children, get spawnCount() { return spawnCount; },
    at(value) { time = value; }, poll() { poll?.(); },
    send(value, child = children.at(-1)) { child.stdout.emit('data', `${JSON.stringify(value)}\n`); },
  };
}
const transcript = (text = 'Tell me about leading a team.', segmentId = '0', startMs = 0, endMs = 800) => ({ type: 'transcript', text, segmentId, startMs, endMs, final: false });

class Contents extends EventEmitter {
  constructor(id) { super(); this.id = id; this.mainFrame = {}; this.sent = []; }
  send(channel, value) { this.sent.push({ channel, value }); }
  setWindowOpenHandler() {}
}
class Window extends EventEmitter {
  static nextId = 1;
  static all = new Map();
  static fromWebContents(sender) { return this.all.get(sender); }
  constructor() { super(); this.id = Window.nextId++; this.webContents = new Contents(this.id); Window.all.set(this.webContents, this); }
  async loadURL() {}
  focus() {}
  isDestroyed() { return !!this.destroyed; }
  close() { this.emit('close'); this.destroyed = true; this.emit('closed'); Window.all.delete(this.webContents); }
}
async function controllerHarness() {
  const fixture = createInterviewWindowE2EFixture(); const owner = new Window(); const handlers = new Map();
  const decisions = [];
  let audio; let options; let snapshotReads = 0; let bankReads = 0; let active = false; let state;
  const controller = createInterviewWindowController({ matcherTransportFactory: () => { throw new Error('Offline fixture: AI unavailable.'); }, BrowserWindow: Window, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    appInstance: { isPackaged: false, getPath: () => '/tmp/synthetic-unused' }, isAuthorizedOwner: candidate => candidate === owner,
    loadSnapshot: async () => { snapshotReads += 1; return fixture.snapshot; },
    loadBundle: async () => fixture.bundle, loadPreparedBrief: async () => fixture.brief,
    loadAnswerBank: async () => { bankReads += 1; return fixture.bank; }, devServerUrl: 'http://127.0.0.1:41739/',
    createAudioService: input => {
      options = input;
      audio = { start() { active = true; state = { status: 'listening', transcript: '', question: '', errorCode: null, message: '' }; input.onState(state); return state; },
        stop() { active = false; state = { status: 'idle', transcript: '', question: '', errorCode: null, message: '' }; input.onState(state); return state; },
        getState: () => state, getQuestion: () => 'Tell me about leading a team.', notice: message => { state.message = message; } };
      return audio;
    },
  });
  await controller.launch({ sender: owner.webContents }, { nodeId: 'audio_test', snapshotId: fixture.snapshot.snapshotId,
    jobUrl: fixture.canonicalJobUrl, briefRecordId: interviewPreparedBriefRecordId(fixture.brief), brief: fixture.brief, plan: null, currentStep: 0 });
  const session = [...controller.sessions.values()][0];
  const event = { sender: session.child.webContents, senderFrame: session.child.webContents.mainFrame };
  return { fixture, owner, controller, session, event, handlers, decisions,
    get reads() { return [snapshotReads, bankReads]; }, get active() { return active; },
    endpoint(text, isCurrent = () => active) { return options.onQuestion({ text }, isCurrent, decision => decisions.push(decision)); },
  };
}

export default [
  {
    name: 'interview call audio: assembled partials and endpoint share a turn id through volatile revisions and finals',
    async run() {
      const partials = [];
      const h = nativeHarness({ onPartial: partial => partials.push(partial) });
      h.service.start(); h.send({ type: 'status', state: 'listening' });
      h.send({ type: 'activity', speaking: true });
      h.send({ ...transcript('Tell me about', 'head', 0, 400), final: true });
      h.at(100); h.send(transcript('a difficult team', 'tail', 400, 900));
      h.at(200); h.send(transcript('a difficult project', 'revision', 400, 1000));
      h.at(300); h.send({ ...transcript('a difficult project', 'final', 400, 1000), final: true });
      assert.deepEqual(partials, [
        { turnId: 1, text: 'Tell me about' }, { turnId: 1, text: 'Tell me about a difficult team' },
        { turnId: 1, text: 'Tell me about a difficult project' },
      ]);
      h.at(400); h.send({ type: 'activity', speaking: false }); h.at(1200); h.poll(); await flush();
      assert.equal(h.questions.length, 1); assert.equal(h.questions[0].question.id, partials.at(-1).turnId);
      assert.equal(h.questions[0].question.text, partials.at(-1).text);
      h.at(1300); h.send({ type: 'activity', speaking: true });
      h.at(1400); h.send({ ...transcript('How do you prioritize work?', 'next', 1200, 1700), final: true });
      assert.equal(partials.at(-1).turnId, 2);
      h.at(1500); h.send({ type: 'activity', speaking: false }); h.at(2300); h.poll(); await flush();
      assert.equal(h.questions[1].question.id, 2); assert.equal(h.questions[1].question.text, partials.at(-1).text);
      h.service.stop();
    },
  },
  { name: 'interview call audio: streams locally, endpoints once, ignores late finals and stops generation', async run() {
    const h = nativeHarness();
    assert.equal(h.service.start().status, 'starting'); h.service.start(); assert.equal(h.spawnCount, 1);
    h.send({ type: 'status', state: 'listening' }); h.send({ type: 'activity', speaking: true });
    h.at(100); h.send(transcript('Tell me about leading'));
    h.at(200); h.send({ ...transcript(), final: true });
    h.at(400); h.send({ type: 'activity', speaking: false }); h.at(1199); h.poll();
    assert.equal(h.questions.length, 0); h.at(1200); h.poll(); await flush();
    assert.equal(h.questions.length, 1); assert.equal(h.questions[0].question.text, 'Tell me about leading a team.');
    assert.equal(h.service.getQuestion(), 'Tell me about leading a team.');
    h.send({ ...transcript('late revision'), final: true });
    assert.equal(h.service.getState().transcript, 'Tell me about leading a team.');
    h.service.stop(); assert.equal(h.questions[0].isCurrent(), false);
    assert.equal(h.service.getState().transcript, ''); assert.equal(h.children[0].ended, true);
    assert.deepEqual(h.children[0].signals, ['SIGTERM']);
    h.send(transcript(), h.children[0]); h.poll(); await flush(); assert.equal(h.questions.length, 1);
    h.service.start(); h.send({ type: 'status', state: 'listening' });
    h.children[0].emit('exit', 1); assert.equal(h.service.getState().status, 'listening'); h.service.stop();
  } },
  { name: 'interview call audio: denial, missing helper and malformed native data fail with fixed private-safe messages', run() {
    const h = nativeHarness(); h.service.start();
    h.send({ type: 'error', code: 'permission-denied', message: '/private/sensitive transcript' });
    assert.equal(h.service.getState().message, INTERVIEW_AUDIO_MESSAGES['permission-denied']);
    assert.equal(h.service.getQuestion(), '');
    h.service.start(); h.children.at(-1).emit('error', new Error('/private/path'));
    assert.equal(h.service.getState().errorCode, 'helper-unavailable');
    h.service.start(); h.children.at(-1).stdout.emit('data', 'not json\n');
    assert.equal(h.service.getState().errorCode, 'recognition-failed');
    h.service.start(); h.children.at(-1).stdout.emit('data', 'x'.repeat(32769));
    assert.equal(h.service.getState().errorCode, 'recognition-failed');
    const unsupported = nativeHarness({ platform: 'linux' });
    assert.equal(unsupported.service.start().errorCode, 'unsupported-platform'); assert.equal(unsupported.spawnCount, 0);
  } },
  { name: 'interview call audio: silent or stalled helper fails safely and first-use preparation remains cancellable', run() {
    const h = nativeHarness(); h.service.start(); h.at(60_000); h.poll(); assert.equal(h.service.getState().status, 'starting');
    h.service.stop(); assert.equal(h.service.getState().status, 'idle');
    h.service.start(); h.send({ type: 'status', state: 'listening' }); h.at(80_001); h.poll();
    assert.equal(h.service.getState().errorCode, 'capture-failed');
    h.service.start(); h.at(400_002); h.poll(); assert.equal(h.service.getState().errorCode, 'speech-assets');
  } },
  { name: 'interview call audio: long turns abstain without ending capture and interrupted speech cannot revive', async run() {
    const h = nativeHarness(); h.service.start(); h.send({ type: 'status', state: 'listening' });
    h.send({ type: 'activity', speaking: true }); h.at(100); h.send({ ...transcript(`Tell me about ${'a long question '.repeat(160)}`), final: true });
    h.at(200); h.send({ type: 'activity', speaking: false }); h.at(1000); h.poll(); await flush();
    assert.equal(h.service.getState().status, 'listening'); assert.equal(h.service.getQuestion(), '');
    assert.equal(h.questions[0].question.reason, 'too-long');
    h.at(600_000); h.send({ type: 'status', state: 'preparing' }); h.poll();
    assert.equal(h.service.getState().status, 'starting'); assert.equal(h.service.getState().transcript, '');
    h.send(transcript('Tell me about a stale question.', 'old')); // Ignored during reconnect.
    h.at(600_100); h.send({ type: 'status', state: 'listening' });
    h.send(transcript('Tell me about a stale question.', 'old')); // Retired native range.
    assert.equal(h.service.getState().transcript, '');
    h.send({ type: 'activity', speaking: true }); h.send({ ...transcript('How do you prioritize your work?', 'new', 1000, 1800), final: true });
    h.at(600_200); h.send({ type: 'activity', speaking: false }); h.at(601_000); h.poll(); await flush();
    assert.equal(h.questions.length, 2); assert.equal(h.service.getQuestion(), 'How do you prioritize your work?'); h.service.stop();
  } },
  { name: 'interview call audio IPC: exact child/main-frame binding rejects owners, siblings, forged ids and subframes', async run() {
    const h = await controllerHarness();
    try {
      for (const name of ['get-listening-state', 'start-listening', 'stop-listening', 'use-transcript-question']) {
        const handler = h.handlers.get(`interview-window:${name}`); assert.equal(typeof handler, 'function');
        for (const event of [{ sender: h.owner.webContents }, { sender: { id: h.event.sender.id } }, { sender: h.event.sender, senderFrame: {} }, { sender: h.event.sender }]) {
          await assert.rejects(async () => handler(event), /session is not available/u);
        }
      }
      assert.equal(h.controller.getListeningState(h.event).status, 'idle');
      assert.equal(h.controller.startListening(h.event).status, 'listening');
      assert.equal(h.active, true); h.controller.stopListening(h.event); assert.equal(h.active, false);
      assert(h.event.sender.sent.some(item => item.channel === 'interview-window:listening-updated'));
    } finally { h.controller.cleanupOwner(h.owner); }
  } },
  { name: 'interview call audio IPC: detected questions advance locked cards locally; multipart and stopped events abstain', async run() {
    const h = await controllerHarness();
    try {
      h.controller.startListening(h.event);
      const beforeUpdates = h.event.sender.sent.filter(item => item.channel === 'interview-window:brief-updated').length;
      await h.endpoint('Tell me about leading a team.'); assert.equal(h.session.display.answerCard.id, 'leadership');
      assert.deepEqual(h.decisions.map(decision => decision.stage), ['semantic-gate', 'matcher', 'approximate-gate', 'display'],
        'the audio diagnostic callback must receive actual gate, matcher and committed display decisions');
      assert.equal(h.decisions.at(-1).cardId, 'leadership');
      assert.equal(h.event.sender.sent.filter(item => item.channel === 'interview-window:brief-updated').length, beforeUpdates + 1, 'auto advance must not unmount a typed draft through an empty intermediate display');
      assert.deepEqual(h.reads, [1, 1]); assert.equal(h.session.locked, true);
      const anchor = h.session.anchorPlan; h.session.anchorPlan = null;
      await h.endpoint('What did you learn?'); assert.equal(h.session.display.answerCard.id, 'leadership');
      assert.match(h.controller.getListeningState(h.event).message, /^No story to follow · type it$/u); h.session.anchorPlan = anchor;
      await h.endpoint('How do you prioritize your work?'); assert.equal(h.session.display.answerCard.id, 'priorities');
      assert.deepEqual(h.reads, [1, 1]);
      await h.endpoint('How do you prioritize your work? Tell me about leading a team.');
      assert.equal(h.session.display.answerCard.id, 'priorities'); assert.match(h.controller.getListeningState(h.event).message, /^Multi-part · pick one$/u);
      await h.endpoint('How did you reduce Kafka consumer lag?');
      assert.equal(h.session.display.answerCard, null); assert.equal(h.session.display.plan.status, 'supported');
      const cues = h.session.display.plan.steps.map(step => step.cue);
      await h.endpoint('What was the result?'); assert.deepEqual(h.session.display.plan.steps.map(step => step.cue), cues);
      await h.endpoint('What are your salary expectations?');
      assert.equal(h.session.display.answerCard, null); assert.equal(h.session.display.plan.status, 'unsupported');
      await h.endpoint('How do you prioritize your work?');
      h.controller.stopListening(h.event); await h.endpoint('Tell me about leading a team.', () => false);
      assert.equal(h.session.display.answerCard.id, 'priorities');
      h.controller.startListening(h.event); await h.controller.useTranscriptQuestion(h.event);
      assert.equal(h.session.display.answerCard.id, 'leadership'); assert.deepEqual(h.reads, [2, 2]);
      h.session.child.webContents.emit('did-start-navigation', {}, 'file:///unused', false, true); assert.equal(h.active, false);
      h.controller.startListening(h.event); h.session.child.close(); assert.equal(h.active, false); assert.equal(h.controller.sessionCount(), 0);
    } finally { h.controller.cleanupOwner(h.owner); }
  } },
  { name: 'interview call audio IPC: closing the canvas or committing node deletion releases the child-owned capture', async run() {
    const first = await controllerHarness(); first.controller.startListening(first.event);
    await first.endpoint('Tell me about leading a team.');
    await assert.rejects(() => first.controller.launch({ sender: first.owner.webContents }, {
      nodeId: 'another_helper', snapshotId: first.fixture.snapshot.snapshotId, jobUrl: first.fixture.canonicalJobUrl,
      briefRecordId: interviewPreparedBriefRecordId(first.fixture.brief), brief: first.fixture.brief, plan: null, currentStep: 0,
    }), /active interview rail/u);
    assert.equal(first.active, true, 'a rejected sibling launch cannot stop the active interview');
    first.controller.cleanupOwner(first.owner); assert.equal(first.active, false); assert.equal(first.controller.sessionCount(), 0);
    const second = await controllerHarness(); second.controller.startListening(second.event);
    assert.equal(second.controller.cleanupBySenderAndNode(second.owner.webContents, 'sibling_node'), false); assert.equal(second.active, true);
    assert.equal(second.controller.cleanupBySenderAndNode(second.owner.webContents, 'audio_test'), true); assert.equal(second.active, false);
    assert.equal(second.controller.sessionCount(), 0);
  } },
  { name: 'interview call audio preload: exposes narrow argument-free commands and removable state listener', async run() {
    const invokes = []; const listeners = new Map(); let api;
    const ipcRenderer = { invoke: async (...args) => { invokes.push(args); }, on: (channel, listener) => listeners.set(channel, listener), removeListener: channel => listeners.delete(channel) };
    vm.runInNewContext(fs.readFileSync(new URL('../../electron/interviewWindowPreload.js', import.meta.url), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer }),
    });
    for (const method of ['getListeningState', 'startListening', 'stopListening', 'useTranscriptQuestion']) await api[method]({ process: 'untrusted' });
    assert(invokes.every(args => args.length === 1));
    assert.throws(() => api.onListeningUpdated(null), /callback/u);
    let received; const off = api.onListeningUpdated(value => { received = value; });
    listeners.get('interview-window:listening-updated')({ sender: 'hidden' }, { status: 'listening' });
    assert.deepEqual(received, { status: 'listening' }); off(); assert.equal(listeners.size, 0);
  } },
  { name: 'interview call audio invariant: capture boundary has no device changes, mic input, persistence, network or playback APIs', run() {
    const files = ['electron/interviewCallAudio.js', 'electron/interviewCallQuestionDetector.js', 'electron/interviewWindow.js',
      'electron/interviewWindowPreload.js', 'src/interview-window/CallAudioPanel.jsx', 'src/interview-window/InterviewWindowApp.jsx',
      'native/interview-audio/InterviewAudioHelper.swift'];
    const forbidden = /\b(?:setDefaultDevice|setSinkId|selectAudioOutput|getUserMedia|AudioHardwareSetPropertyData|AudioObjectSetPropertyData|AudioHardwareCreateAggregateDevice|AudioHardwareCreateProcessTap|AudioDeviceCreateIOProcID|kAudioHardwarePropertyDefaultOutputDevice|kAudioHardwarePropertyDefaultInputDevice|outputDeviceID|microphoneCaptureDeviceID|AVAudioEngine|AVAudioPlayer|AVAudioRecorder|AVSpeechSynthesizer|AVCaptureDevice|SFSpeechRecognizer|SCRecordingOutput|AudioQueueNewOutput|AudioUnitRender|URLSession|NWConnection|WebSocket)\b|\.play\s*\(|\.duck\s*\(|\.setVolume\s*\(|\.setAudioMuted\s*\(/u;
    for (const file of files) {
      const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert(!forbidden.test(source), `${file} must remain a read-only output tap`);
    }
    const swift = fs.readFileSync(new URL('../../native/interview-audio/InterviewAudioHelper.swift', import.meta.url), 'utf8');
    assert.match(swift, /captureMicrophone\s*=\s*false/u); assert.match(swift, /excludesCurrentProcessAudio\s*=\s*true/u);
    assert.doesNotMatch(swift, /addStreamOutput\([^\n]+type:\s*\.(?:microphone|screen)/u);
    assert.doesNotMatch(swift, /(?:AVAudioFile|Data\([^)]*\)\.write|write\(to:|FileManager.*createFile)/u);
    assert.match(swift, /downloadAndInstall/u); assert.doesNotMatch(swift, /requiresOnDeviceRecognition\s*=\s*false/u);
    const config = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(config.build.mac.identity, 'AI Chalkboard Local Code Signing'); assert.equal(config.build.mac.hardenedRuntime, true);
    assert(config.build.mac.extraResources.some(item => item.to === 'interview-audio/Interview Audio Helper.app'));
    assert.equal(interviewAudioHelperPath({ packaged: true, resourcesPath: '/tmp/resources' }), '/tmp/resources/interview-audio/Interview Audio Helper.app/Contents/MacOS/interview-audio-helper');
    const pipeline = fs.readFileSync(new URL('../build-macos.mjs', import.meta.url), 'utf8');
    assert.match(pipeline, /buildInterviewAudioHelper\(\{ projectDir, identity \}\)/u);
    assert.throws(() => buildInterviewAudioHelper({ identity: '-' }), /ad-hoc/u);
  } },
];
