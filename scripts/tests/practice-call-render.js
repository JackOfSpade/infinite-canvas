import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { assert } from './testHelpers.js';

const ROOT = path.resolve('.');
const PRACTICE = path.join(ROOT, 'src/practice-call');

// One esbuild graph for every practice-call module plus react-dom/server, so a
// plain renderToStaticMarkup sees the same React the components import.
async function loadServerBundle() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'practice-call-render-'));
  const outfile = path.join(directory, 'bundle.mjs');
  const require = createRequire(import.meta.url);
  const react = require.resolve('react');
  const server = require.resolve('react-dom/server');
  const components = {
    PracticeCallApp: 'PracticeCallApp.jsx',
    ConsentScreen: 'ConsentScreen.jsx',
    DownloadingScreen: 'DownloadingScreen.jsx',
    PrecheckScreen: 'PrecheckScreen.jsx',
    IncomingCall: 'IncomingCall.jsx',
    ConnectingScreen: 'ConnectingScreen.jsx',
    InCall: 'InCall.jsx',
    ChatPanel: 'ChatPanel.jsx',
    EndedScreen: 'EndedScreen.jsx',
    Replay: 'Replay.jsx',
    ErrorScreen: 'ErrorScreen.jsx',
  };
  const namespaces = { callModel: 'callModel.js', replayModel: 'replayModel.js', ringtone: 'ringtone.js' };
  const lines = [
    `import React from ${JSON.stringify(react)};`,
    `import { renderToStaticMarkup } from ${JSON.stringify(server)};`,
    'export { React, renderToStaticMarkup };',
    ...Object.entries(components).map(([name, file]) => `export { default as ${name} } from ${JSON.stringify(path.join(PRACTICE, file))};`),
    ...Object.entries(namespaces).map(([name, file]) => `export * as ${name} from ${JSON.stringify(path.join(PRACTICE, file))};`),
  ];
  await fs.writeFile(path.join(directory, 'entry.mjs'), `${lines.join('\n')}\n`);
  await build({
    entryPoints: [path.join(directory, 'entry.mjs')],
    bundle: true, platform: 'node', format: 'esm', outfile,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    nodePaths: [path.dirname(path.dirname(react))],
    logLevel: 'silent',
  });
  const loaded = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return { module: loaded, dispose: () => fs.rm(directory, { recursive: true, force: true }) };
}

const PERSONA = { name: 'Dana Whitfield', role: 'Hiring manager', team: 'Growth' };

const IN_CALL_STATE = {
  phase: 'in-call', persona: PERSONA, elapsedMs: 72_000, speaking: 'interviewer', muted: false, typing: true,
  captions: [{ speaker: 'candidate', text: 'I led the onboarding rewrite.', atMs: 60_000 }],
  chat: [{ from: 'candidate', text: 'One moment, checking my notes.', atMs: 62_000 }],
};

const REPLAY = {
  callId: 'call-dana-1',
  audioUrl: 'file:///tmp/practice-calls/call-dana-1.wav',
  durationMs: 600_000,
  chapters: [
    { title: 'Small talk', startMs: 0, endMs: 120_000, markers: [{ kind: 'pause', label: 'Long pause', atMs: 30_000 }] },
    { title: 'Onboarding story', startMs: 120_000, endMs: 420_000, markers: [{ kind: 'interruption', label: 'Talked over', atMs: 180_000 }] },
    { title: 'Your questions', startMs: 420_000, endMs: 600_000, markers: [] },
  ],
  transcript: [
    { role: 'interviewer', text: 'Tell me about onboarding.', startMs: 120_000, endMs: 135_000 },
    { role: 'candidate', text: 'We rewrote the first-run flow.', startMs: 135_000, endMs: 200_000 },
  ],
  feedback: { overall: { score: 7, summary: 'Clear story, tidy close.' }, delivery: { wpm: { cited: '168 words per minute' }, pauseCount: 3 } },
  analysis: { status: 'ready' },
};

const MARKERS_BY_KIND = ['data-marker-kind="pause"', 'data-marker-kind="interruption"'];

export default [
  {
    name: 'practice call render: consent lists the model sizes before asking to agree',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ConsentScreen } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(ConsentScreen, { onAgree: () => {}, busy: false }));
        for (const fragment of ['aria-label="Model downloads"', '32 MB', '610 MB', 'Agree and download', 'Practice call']) {
          assert(markup.includes(fragment), `consent screen is missing ${fragment}`);
        }
        const busy = renderToStaticMarkup(React.createElement(ConsentScreen, { onAgree: () => {}, busy: true }));
        assert(busy.includes('Starting…') && busy.includes('disabled'), 'a busy consent screen must show progress and disable the agree button');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: downloading shows real progress and precheck shows the level meter, headphones and usage warning',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, DownloadingScreen, PrecheckScreen } = bundle.module;
        const downloading = renderToStaticMarkup(React.createElement(DownloadingScreen, { download: { receivedBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } }));
        for (const fragment of ['role="progressbar"', 'aria-valuenow="50"', '50%', 'Downloading practice models']) {
          assert(downloading.includes(fragment), `downloading screen is missing ${fragment}`);
        }
        const precheck = renderToStaticMarkup(React.createElement(PrecheckScreen, { level: 0.42, usageWarning: 'Use real examples only.', persona: PERSONA }));
        for (const fragment of ['role="meter"', 'aria-valuenow="42"', 'Headphones recommended', 'aria-label="Usage warning"', 'Use real examples only.', 'aria-label="Microphone check"']) {
          assert(precheck.includes(fragment), `precheck screen is missing ${fragment}`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: ringing shows the persona with answer and decline, and the ringtone is two Web Audio tones that stop',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, IncomingCall, ringtone } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(IncomingCall, { persona: PERSONA, onAnswer: () => {}, onDecline: () => {} }));
        for (const fragment of ['aria-label="Incoming practice call"', 'Dana Whitfield', 'Hiring manager · Growth', 'aria-label="Answer call"', 'aria-label="Decline call"']) {
          assert(markup.includes(fragment), `incoming call screen is missing ${fragment}`);
        }
        const created = [];
        const context = { closed: false };
        class FakeAudioContext {
          constructor() { this.currentTime = 1; this.destination = { name: 'out' }; }
          createOscillator() {
            const oscillator = { type: 'sine', frequencies: [], frequency: { setValueAtTime: value => { oscillator.frequencies.push(value); } }, connect() {}, start() {}, stop() {} };
            created.push(oscillator);
            return oscillator;
          }
          createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
          resume() {}
          close() { context.closed = true; }
        }
        const stop = ringtone.startRingtone({ AudioContext: FakeAudioContext });
        assert(created.length === 2, `the ring must synthesise two tones, got ${created.length}`);
        assert(JSON.stringify(created.map(oscillator => oscillator.frequencies[0])) === '[440,480]', 'the ring must alternate two distinct tones');
        assert(context.closed === false, 'the ring keeps playing until it is stopped');
        stop();
        assert(context.closed === true, 'stopping the ring must close the audio context');
        const noAudio = ringtone.startRingtone({});
        assert(typeof noAudio === 'function' && typeof noAudio() === 'undefined', 'a window without Web Audio must return a harmless stop function');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: connecting and error screens report the state without pretending the call is live',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ConnectingScreen, ErrorScreen } = bundle.module;
        const connecting = renderToStaticMarkup(React.createElement(ConnectingScreen, { persona: PERSONA }));
        for (const fragment of ['aria-label="Connecting practice call"', 'Connecting to Dana Whitfield', 'role="status"']) {
          assert(connecting.includes(fragment), `connecting screen is missing ${fragment}`);
        }
        const failed = renderToStaticMarkup(React.createElement(ErrorScreen, { error: { code: 'mic-denied', message: 'The microphone is not available.' }, onClose: () => {} }));
        for (const fragment of ['role="alert"', 'The microphone is not available.', 'mic-denied', 'Close window']) {
          assert(failed.includes(fragment), `error screen is missing ${fragment}`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: in-call shows the speaking interviewer, timer, call controls and keeps video, captions, cards and chat off by default',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(InCall, { state: IN_CALL_STATE, api: { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} } }));
        for (const fragment of [
          'aria-label="Practice call in progress"', 'aria-label="Interviewer"', 'data-speaking="true"', '>DW<',
          'role="timer"', '1:12', 'aria-label="Mute microphone"', 'aria-pressed="false"',
          'aria-label="Captions"', 'aria-label="Prepared answer cards"', 'aria-label="Chat"', 'aria-label="Hang up"',
          'aria-label="Your camera"', 'data-camera="off"', 'aria-label="Turn on camera"', 'Camera off',
        ]) assert(markup.includes(fragment), `in-call view is missing ${fragment}`);
        for (const hidden of ['aria-label="Live captions"', 'aria-label="Call chat"', '<video', 'I led the onboarding rewrite.']) {
          assert(!markup.includes(hidden), `in-call view must keep ${hidden} hidden until the user asks for it`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: chat panel lists the turns, shows the typing state and labels the message box',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ChatPanel } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(ChatPanel, { chat: IN_CALL_STATE.chat, typing: true, onSend: () => {}, onTyping: () => {} }));
        for (const fragment of ['aria-label="Call chat"', 'One moment, checking my notes.', 'Interviewer is typing', 'aria-label="Chat message"', 'aria-label="Send chat message"', 'aria-live="polite"']) {
          assert(markup.includes(fragment), `chat panel is missing ${fragment}`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: ended and analysing screens state the analysis status and call length',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, EndedScreen } = bundle.module;
        const analysing = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'analyzing', elapsedMs: 72_000, persona: PERSONA } }));
        for (const fragment of ['aria-label="Analysing the call"', 'role="status"', 'Analysing the recording', '1:12']) {
          assert(analysing.includes(fragment), `analysing screen is missing ${fragment}`);
        }
        const ended = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'ended', elapsedMs: 5_000 } }));
        for (const fragment of ['aria-label="Call ended"', 'being analysed', '0:05']) {
          assert(ended.includes(fragment), `ended screen is missing ${fragment}`);
        }
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: replay binds the recording, draws chapter segments and marker ticks, and seeks from chapters, markers and transcript',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY, api: { deleteRecording: async () => {} }, initialPositionMs: 140_000 }));
        for (const fragment of [
          'aria-label="Practice call replay"', '<audio', 'src="file:///tmp/practice-calls/call-dana-1.wav"', 'aria-label="Call recording"',
          'aria-label="Play recording"', 'role="slider"', 'aria-valuemax="600000"', 'aria-valuenow="140000"', 'aria-valuetext="2:20"',
          'data-chapter="0"', 'data-chapter="1"', 'data-chapter="2"', 'style="left:20%;width:50%"',
          ...MARKERS_BY_KIND, 'title="Long pause · 0:30"', 'title="Talked over · 3:00"',
          'aria-label="Seek to Onboarding story at 2:00"', 'aria-label="Seek to Talked over at 3:00"', 'aria-label="Seek to We rewrote the first-run flow. at 2:15"',
          'aria-label="Delete recording"', 'aria-label="Call transcript"', 'data-current-turn="true"', 'data-current-turn="false"',
          'aria-label="Feedback"', 'data-testid="practice-feedback"', 'aria-label="Delivery"', '168 words per minute', 'pause count',
        ]) assert(markup.includes(fragment), `replay view is missing ${fragment}`);
        const selected = markup.slice(markup.indexOf('data-current-turn="true"'));
        assert(selected.includes('We rewrote the first-run flow.'), 'the turn under the playhead must be the highlighted one');
        assert(markup.indexOf('data-current-turn="true"') > markup.indexOf('data-current-turn="false"'), 'only the turn containing the playhead is current');
        assert(!markup.includes('role="alertdialog"'), 'delete must stay behind a confirm step');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: replay reports analysing, failed analysis and a deleted recording without losing the transcript',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const analysing = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, analysis: { status: 'analyzing' } }, api: {} }));
        assert(analysing.includes('aria-label="Analysis status"') && analysing.includes('Analysis is still running'), 'an analysing call must say the analysis is still running');
        const failed = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, analysis: { status: 'failed', error: 'Tone model unavailable' } }, api: {} }));
        assert(failed.includes('role="alert"') && failed.includes('aria-label="Analysis failed"') && failed.includes('Tone model unavailable'), 'a failed analysis must surface the error');
        assert(failed.includes('Tell me about onboarding.'), 'a failed analysis keeps the transcript available');
        const deleted = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, audioUrl: null }, api: {} }));
        assert(deleted.includes('aria-label="Recording unavailable"') && deleted.includes('The recording for this call is not available.'), 'a missing recording must explain itself');
        assert(deleted.includes('aria-label="Play recording"') && deleted.includes('disabled'), 'play must be disabled without a recording');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: replay positioning helpers pick chapters, segment geometry and turns and format times',
    async run() {
      const model = await import(pathToFileURL(path.join(PRACTICE, 'replayModel.js')).href);
      const { chapterAt, segmentStyles, turnAt, formatTime } = model;
      assert(chapterAt(REPLAY.chapters, 0) === 0, 'the start of the call is in the first chapter');
      assert(chapterAt(REPLAY.chapters, 140_000) === 1, 'a position inside a chapter must resolve to it');
      assert(chapterAt(REPLAY.chapters, 590_000) === 2, 'the last chapter covers the tail of the call');
      assert(chapterAt(REPLAY.chapters, -1) === -1, 'nothing precedes the start of the call');
      assert(chapterAt([], 10) === -1, 'an empty chapter list has no chapter');
      const segments = segmentStyles(REPLAY.chapters, 600_000);
      assert(segments.length === 3, 'every chapter becomes a segment');
      assert(segments[0].leftPct === 0 && segments[0].widthPct === 20, 'the first segment spans 0-20%');
      assert(segments[1].leftPct === 20 && segments[1].widthPct === 50, 'the middle segment spans 20-70%');
      assert(segments[2].leftPct === 70 && segments[2].widthPct === 30, 'the final segment spans 70-100%');
      assert(segmentStyles(REPLAY.chapters, 0).length === 0, 'a replay with no duration has no segments');
      assert(turnAt(REPLAY.transcript, 120_000) === 0, 'the interviewer turn owns its start time');
      assert(turnAt(REPLAY.transcript, 140_000) === 1, 'the candidate turn owns its window');
      assert(turnAt(REPLAY.transcript, 10_000) === -1, 'a position before the transcript has no turn');
      assert(turnAt([], 10) === -1, 'an empty transcript has no turn');
      assert(formatTime(0) === '0:00', 'zero formats as 0:00');
      assert(formatTime(72_000) === '1:12', 'milliseconds format as m:ss');
      assert(formatTime(-5) === '0:00', 'negative times clamp at zero');
    },
  },
  {
    name: 'practice call render: the practice call window follows every pushed phase from consent to replay',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
      try {
        await withDom(async window => {
          const listeners = [];
          const invoked = [];
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'consent' }),
            onState: listener => { listeners.push(listener); return () => { const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1); }; },
            onEvent: () => () => {},
            agreeModelDownload: async () => { invoked.push('agree'); },
            getReplay: async () => REPLAY,
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const push = patch => act(() => { listeners.forEach(listener => listener(patch)); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            assert(byLabel('Practice call setup'), 'the consent phase renders once getState resolves');
            await act(() => [...window.document.querySelectorAll('button')].find(node => node.textContent === 'Agree and download').click());
            assert(invoked.includes('agree'), 'agreeing must call agreeModelDownload');
            await push({ phase: 'downloading', modelDownload: { receivedBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } });
            assert(byLabel('Model download progress')?.getAttribute('aria-valuenow') === '25', 'downloading must follow the pushed progress');
            await push({ phase: 'precheck', level: 0.5, persona: PERSONA });
            assert(byLabel('Microphone level')?.getAttribute('aria-valuenow') === '50', 'precheck must meter the live level');
            await push({ phase: 'ringing', persona: PERSONA });
            assert(byLabel('Answer call') && byLabel('Decline call'), 'ringing must offer Answer and Decline');
            await push({ phase: 'in-call', persona: PERSONA, elapsedMs: 65_000, speaking: 'interviewer' });
            assert(byLabel('Hang up') && byLabel('Mute microphone') && byLabel('Captions'), 'in-call must expose the control bar');
            assert(byLabel('Call timer')?.textContent === '1:05', 'the in-call timer must follow elapsedMs');
            await push({ phase: 'replay' });
            assert(byLabel('Replay position')?.getAttribute('aria-valuemax') === '600000', 'replay must render the loaded replay payload');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: deleting a recording asks for confirmation before the audio source is removed',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/Replay.jsx'), {});
      try {
        await withDom(async window => {
          const deletedCalls = [];
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.Replay, {
              replay: REPLAY, api: { deleteRecording: async () => { deletedCalls.push(REPLAY.callId); } },
            })));
            assert(window.document.querySelector('audio')?.getAttribute('src') === REPLAY.audioUrl, 'the audio element is bound to the recording URL');
            assert(!window.document.querySelector('[role="alertdialog"]'), 'delete must not be armed before the first click');
            await act(() => byLabel('Delete recording').click());
            assert(window.document.querySelector('[role="alertdialog"]'), 'the first delete click must open the confirm step');
            assert(deletedCalls.length === 0, 'nothing is deleted before the user confirms');
            await act(() => byLabel('Confirm delete recording').click());
            assert(deletedCalls.length === 1, 'confirming must call deleteRecording');
            assert(!window.document.querySelector('audio')?.hasAttribute('src'), 'the audio source is removed after the delete');
            assert(byLabel('Recording unavailable')?.textContent.includes('Recording deleted'), 'the replay must say the recording was deleted');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the extracted view-model helpers drive the screens and the replay delivery section',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay, callModel } = bundle.module;
        assert(callModel.formatBytes(100 * 1024 * 1024) === '100 MB', 'formatBytes rounds whole megabytes');
        assert(callModel.downloadPercent({ receivedBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 }) === 25, 'downloadPercent reports the received fraction');
        assert(callModel.levelPercent(0.426) === 43, 'levelPercent rounds the meter level');
        assert(callModel.humanizeKey('pauseCount') === 'pause count', 'humanizeKey splits camelCase keys');
        assert(JSON.stringify(callModel.mergeState({ phase: 'consent', level: 0 }, { phase: 'precheck' })) === JSON.stringify({ phase: 'precheck', level: 0 }), 'mergeState keeps the previous fields');
        const merged = callModel.mergeEvent({ phase: 'in-call', captions: [] }, { kind: 'caption', caption: { speaker: 'candidate', text: 'Hi', atMs: 1 } });
        assert(merged.captions.length === 1 && merged.phase === 'in-call', 'mergeEvent appends captions without dropping the phase');
        assert(callModel.MODEL_SIZES.length === 2, 'both model sizes are listed once, in the shared module');
        assert(callModel.describeDeliveryValue({ wpm: { cited: '168 words per minute' }, pauseCount: 3 }) === 'wpm: 168 words per minute; pause count: 3', 'describeDeliveryValue labels each metric and keeps cited text');
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY }));
        for (const fragment of ['aria-label="Delivery"', '168 words per minute', 'pause count']) {
          assert(markup.includes(fragment), `the replay delivery section is missing ${fragment}`);
        }
      } finally { await bundle.dispose(); }
    },
  },
];
