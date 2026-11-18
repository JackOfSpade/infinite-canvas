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
  const client = require.resolve('react-dom/client');
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
    SharedScreen: 'SharedScreen.jsx',
    CodingPad: 'CodingPad.jsx',
  };
  const namespaces = { callModel: 'callModel.js', replayModel: 'replayModel.js', ringtone: 'ringtone.js', persona: 'persona.js', screenMarkup: 'screenMarkup.js' };
  const lines = [
    `import React from ${JSON.stringify(react)};`,
    `import { renderToStaticMarkup } from ${JSON.stringify(server)};`,
    `import { createRoot } from ${JSON.stringify(client)};`,
    'export { React, renderToStaticMarkup, createRoot };',
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

const PRESENT_STATE = {
  ...IN_CALL_STATE,
  participants: [{ id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' }, { id: 'B', name: 'John Park', role: 'Engineer', status: 'joined' }],
  speakingId: 'B',
};
const SCREEN = { title: 'Two sum', content: 'Given an array, return **two** indices.\n\n- Input: `[2, 7]`\n- Output: `[0, 1]`\n\n```js\nif (a < b && c > d) { return `x`; }\n```', speakerId: 'B', presenterName: 'John Park' };
const group = (n) => Array.from({ length: n }, (_, i) => ({ id: String.fromCharCode(65 + i), name: `Person ${String.fromCharCode(65 + i)}`, role: 'Panel', status: 'joined' }));

export const presentingTests = [
  {
    name: 'practice call render: the grid is used until something is shared, then the presenting layout, then the grid again',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const html = state => renderToStaticMarkup(React.createElement(InCall, { state, api: {} }));
        assert(html(PRESENT_STATE).includes('data-layout="grid"') && !html(PRESENT_STATE).includes('data-strip'), 'no screen and no pad keeps the grid');
        const shared = html({ ...PRESENT_STATE, screen: SCREEN });
        assert(shared.includes('data-layout="presenting"') && shared.includes('data-stage="true"') && shared.includes('data-strip="true"'), 'a screen switches to the presenting layout');
        assert(shared.includes('data-presenting-banner="true"') && shared.includes('John Park is presenting') && !shared.includes('(Presentation)'), 'a bar across the top names the presenter, as Meet does');
        assert(/data-presenting="true"[^>]*>/.test(shared), 'the presenter tile is marked for the page, with no label of its own');
        assert(shared.indexOf('data-presenting="true"') > shared.indexOf('aria-label="John Park"') - 400, 'the marked tile is the presenter');
        assert(!shared.includes('data-coding-pad'), 'no pad unless it is open');
        const padOnly = html({ ...PRESENT_STATE, pad: { open: true, lang: 'python', text: 'print(1)' } });
        assert(padOnly.includes('data-layout="presenting"') && padOnly.includes('data-coding-pad="live"') && !padOnly.includes('data-shared-screen'), 'the pad alone fills the stage');
        assert(padOnly.includes('python') && padOnly.includes('print(1)'), 'the pad shows its language and seeded text');
        const closed = html({ ...PRESENT_STATE, screen: null, pad: { open: false, lang: '', text: 'old' } });
        assert(closed.includes('data-layout="grid"') && !closed.includes('data-coding-pad'), 'both ended restores the grid and hides the pad');
        const both = html({ ...PRESENT_STATE, screen: SCREEN, pad: { open: true, lang: 'js', text: '' } });
        assert(both.includes('data-shared-screen') && both.includes('data-coding-pad="live"'), 'screen and pad together');
        assert(both.indexOf('data-shared-screen') < both.indexOf('data-coding-pad'), 'the problem comes before the pad');
        const withChat = renderToStaticMarkup(React.createElement(InCall, { state: { ...PRESENT_STATE, screen: SCREEN }, api: {}, leaveRequest: 0 }));
        assert(withChat.includes('data-layout="presenting"'), 'presenting without a side panel');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: nothing shows while the interviewer is still setting a share up, then the content',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const html = state => renderToStaticMarkup(React.createElement(InCall, { state, api: {} }));
        const sharing = { speakerId: 'B', presenterName: 'John Park', title: null };
        const starting = html({ ...PRESENT_STATE, screen: null, sharing });
        // On a real call nothing appears while the other person is finding their window: the call stays on its tiles.
        assert(starting.includes('data-layout="grid"') && !starting.includes('data-layout="presenting"'), 'the call stays on the tile grid');
        assert(!starting.includes('data-share-placeholder') && !starting.includes('data-shared-screen') && !starting.includes('present'), 'no bar, no placeholder, no content yet');
        const shown = html({ ...PRESENT_STATE, screen: SCREEN, sharing: null });
        assert(shown.includes('John Park is presenting') && shown.includes('data-shared-screen') && !shown.includes('data-share-placeholder'), 'the content arrives with the presenting bar');
        const replacing = html({ ...PRESENT_STATE, screen: SCREEN, sharing });
        assert(replacing.includes('data-shared-screen') && replacing.includes('John Park is presenting') && !replacing.includes('data-share-placeholder'), 'the old content stays until the new arrives');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the strip holds one to five interviewers',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        for (const count of [1, 5]) {
          const markup = renderToStaticMarkup(React.createElement(InCall, { state: { ...PRESENT_STATE, participants: group(count), speakingId: 'A', screen: { title: 'T', content: 'x', speakerId: 'A' } }, api: {} }));
          const strip = markup.slice(markup.indexOf('data-strip="true"'));
          assert(strip.includes(`data-tiles="${count}"`), `strip reports ${count} tiles`);
          assert((strip.match(/data-speaking=/g) || []).length === count, `strip has ${count} tiles`);
          assert(markup.includes('Person A is presenting'), 'the bar names the lead as presenter');
          // While something is shared the interviewers are chips in the bar, whatever their number, and the stage has the full width.
          assert((strip.match(/data-chip="true"/g) || []).length === count, `every interviewer is a chip (${count})`);
          assert(!strip.includes('data-chip-tight'), 'with the chat panel closed every chip keeps its name');
          assert(markup.includes('data-chip="you"') && /aria-label="Your camera"[^>]*class="[^"]*hidden/.test(markup), 'with the camera off the candidate is a chip too, not a floating picture');
        }
        // A presenter id that matches nobody falls back to the lead.
        const lone = renderToStaticMarkup(React.createElement(InCall, { state: { ...PRESENT_STATE, participants: group(2), screen: { title: 'T', content: 'x', speakerId: 'Z' } }, api: {} }));
        assert(lone.includes('Person A is presenting'), 'unknown presenter id uses the lead');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: screen markup parses to the contract format and shows code as plain text',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, SharedScreen, screenMarkup } = bundle.module;
        const blocks = screenMarkup.parseScreenContent(SCREEN.content);
        assert(JSON.stringify(blocks.map(block => block.type)) === JSON.stringify(['p', 'ul', 'code']), `block types ${JSON.stringify(blocks.map(block => block.type))}`);
        assert(blocks[1].items.length === 2 && blocks[2].lang === 'js', 'bullets and the code language label');
        assert(JSON.stringify(screenMarkup.parseInline('a **b** `c` **open')) === JSON.stringify([{ type: 'text', text: 'a ' }, { type: 'bold', text: 'b' }, { type: 'text', text: ' ' }, { type: 'code', text: 'c' }, { type: 'text', text: ' **open' }]), 'inline parsing keeps unclosed markers literal');
        assert(screenMarkup.parseScreenContent('```\nnever closed').at(0).text === 'never closed', 'an open fence runs to the end');
        assert(screenMarkup.parseScreenContent('x'.repeat(7000))[0].text.length === 6000, 'content is cut at the cap');
        const markup = renderToStaticMarkup(React.createElement(SharedScreen, { title: 'Two sum', content: SCREEN.content, presenterName: 'John Park' }));
        assert(markup.includes('if (a &lt; b &amp;&amp; c &gt; d) { return `x`; }'), 'angle brackets and backticks inside a code block are text');
        assert(markup.includes('<strong') && markup.includes('<ul') && markup.includes('<pre'), 'bold, bullets and code block are elements');
        const hostile = renderToStaticMarkup(React.createElement(SharedScreen, { title: '<b>t</b>', content: '<script>alert(1)</script> <img src=x onerror=y>' }));
        assert(!hostile.includes('<script') && !hostile.includes('<img') && hostile.includes('&lt;script&gt;'), 'HTML in content is never interpreted');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the read-only replay pad lets Tab move focus on instead of swallowing it',
    async run() {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
      const saved = {};
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, CodingPad } = bundle.module;
        const root = createRoot(dom.window.document.getElementById('root'));
        await React.act(async () => root.render(React.createElement(CodingPad, { readOnly: true, value: 'print(1)' })));
        const area = dom.window.document.querySelector('textarea[aria-label="Coding pad contents"]');
        const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        await React.act(async () => { area.dispatchEvent(tab); });
        assert(tab.defaultPrevented === false, 'Tab in the replay pad must keep its default so focus can leave');
        await React.act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
  {
    name: 'practice call render: the pad is not overwritten by later state, Tab indents, and edits are sent debounced with a typing heartbeat',
    async run() {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
      const saved = {};
      // act() opens a MessageChannel per call and never closes it; they are closed here so the process can exit.
      const realChannel = globalThis.MessageChannel;
      const channels = [];
      globalThis.MessageChannel = class { constructor() { const channel = new realChannel(); channels.push(channel); return channel; } };
      const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'];
      for (const name of names) { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true }); }
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      // react-dom reads window when it loads, so the bundle is imported after the globals exist.
      let bundle = null;
      try {
        bundle = await loadServerBundle();
        const { React, createRoot, InCall } = bundle.module;
        const calls = [];
        const api = { updatePad: text => calls.push(['pad', text]), setTyping: value => calls.push(['typing', value]) };
        const root = createRoot(dom.window.document.getElementById('root'));
        const render = state => root.render(React.createElement(InCall, { state, api }));
        const { act } = React;
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: 'python', text: 'seed' } }));
        const area = () => dom.window.document.querySelector('textarea[aria-label="Code"]');
        assert(area().value === 'seed', 'seeded once from state.pad.text');
        const setValue = value => { const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set; setter.call(area(), value); area().dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
        await act(async () => setValue('seed\nmore'));
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: 'python', text: 'from the service' } }));
        assert(area().value === 'seed\nmore', 'a later state.pad.text never overwrites what the user typed');
        // Writing in the pad sends no chat typing signal: the call sees the edits themselves as activity.
        assert(calls.filter(call => call[0] === 'typing').length === 0, 'the pad sends no typing signal');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
        assert(JSON.stringify(calls.filter(call => call[0] === 'pad')) === JSON.stringify([['pad', 'seed\nmore']]), `debounced send ${JSON.stringify(calls)}`);
        area().setSelectionRange(0, 0);
        await act(async () => { area().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
        assert(area().value === '  seed\nmore', 'Tab inserts two spaces');
        await act(async () => setValue('x'));
        assert(!dom.window.document.querySelector('button[aria-label="Ready"]'), 'the pad has no Ready button: the interviewer watches the pad');
        await act(async () => render({ ...PRESENT_STATE, pad: { open: false, lang: '', text: 'x' } }));
        assert(!area(), 'closing the pad removes it');
        await act(async () => render({ ...PRESENT_STATE, pad: { open: true, lang: '', text: 'reopened' } }));
        assert(area().value === 'reopened', 'a reopened pad is seeded again');
        await act(async () => root.unmount());
      } finally {
        for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; }
        delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        globalThis.MessageChannel = realChannel;
        for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
        dom.window.close();
        if (bundle) await bundle.dispose();
      }
    },
  },
  {
    name: 'practice call render: the replay shows the screen and pad current at the playback time, and nothing without them',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay, screenMarkup } = bundle.module;
        const replay = {
          ...REPLAY, persona: { name: 'Dana Whitfield' }, panel: [{ id: 'B', name: 'John Park' }],
          screens: [{ atMs: 100_000, title: 'Problem one', content: 'Reverse a list', speakerId: 'B', endMs: 300_000 }, { atMs: 300_000, title: 'Problem two', content: 'Merge lists', speakerId: 'A', endMs: null }],
          pad: { lang: 'python', snapshots: [{ atMs: 150_000, text: 'def rev(xs):' }, { atMs: 400_000, text: 'def merge(a, b):' }] },
        };
        const at = ms => renderToStaticMarkup(React.createElement(Replay, { replay, api: {}, initialPositionMs: ms }));
        const early = at(50_000);
        assert(early.includes('data-replay-share-empty="screen"') && early.includes('data-replay-share-empty="pad"') && !early.includes('Problem one'), 'before any screen the area is there, empty, so the layout does not jump later');
        assert(!at(200_000).includes('data-replay-share-empty'), 'nothing is marked empty while both are shown');
        const mid = at(200_000);
        assert(mid.includes('Problem one') && mid.includes('John Park (Presentation)') && mid.includes('def rev(xs):') && mid.includes('data-coding-pad="readonly"'), 'mid call shows the first screen and snapshot');
        assert(!mid.includes('Problem two'), 'only the current screen');
        const late = at(500_000);
        assert(late.includes('Problem two') && late.includes('Dana Whitfield (Presentation)') && late.includes('def merge(a, b):') && !late.includes('def rev'), 'late call shows the second screen and the latest snapshot');
        assert(screenMarkup.screenAt([{ atMs: 0, endMs: 10 }], 10) === null, 'a screen ended at the time is gone');
        // Pad keys: Tab writes two spaces, Enter keeps the indentation of the line it leaves.
        assert(screenMarkup.padKeyInsert('Tab', 'x') === '  ', 'tab is two spaces');
        assert(screenMarkup.padKeyInsert('Enter', 'def f():\n    if x:') === '\n    ', 'enter keeps four spaces');
        assert(screenMarkup.padKeyInsert('Enter', 'a\n\tb') === '\n\t' && screenMarkup.padKeyInsert('Enter', 'top') === '\n' && screenMarkup.padKeyInsert('Enter', '') === '\n', 'tabs kept, no indentation invented');
        const plain = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY, api: {}, initialPositionMs: 200_000 }));
        assert(!plain.includes('data-replay-share') && !plain.includes('Coding pad'), 'a replay without screens looks as before');
      } finally { await bundle.dispose(); }
    },
  },
];

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
        const unhandled = [];
        const onUnhandled = reason => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        class RejectingAudioContext extends FakeAudioContext { resume() { return Promise.reject(new Error('autoplay blocked')); } }
        ringtone.startRingtone({ AudioContext: RejectingAudioContext })();
        ringtone.playJoinChime({ AudioContext: RejectingAudioContext });
        await new Promise(resolve => setTimeout(resolve, 20));
        process.off('unhandledRejection', onUnhandled);
        assert(unhandled.length === 0, 'a rejected AudioContext.resume() must not become an unhandled rejection');
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
          'aria-label="Practice call in progress"', 'aria-label="Interviewer"', 'data-speaking="true"', '>D<',
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
    name: 'practice call render: chat panel lists the turns, never labels the candidate typing as the interviewer and labels the message box',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ChatPanel } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(ChatPanel, { chat: IN_CALL_STATE.chat, typing: true, onSend: () => {}, onTyping: () => {} }));
        for (const fragment of ['aria-label="Call chat"', 'One moment, checking my notes.', 'aria-label="Chat message"', 'maxLength="2000"', '<textarea', 'aria-label="Send chat message"', 'aria-live="polite"']) {
          assert(markup.includes(fragment), `chat panel is missing ${fragment}`);
        }
        assert(!markup.includes('Interviewer is typing') && !markup.includes('chat-typing'), 'the candidate typing must not be shown as the interviewer typing');
        const left = renderToStaticMarkup(React.createElement(ChatPanel, { chat: [], disabled: true, onSend: () => {}, onTyping: () => {} }));
        assert(left.includes('disabled=""') && left.includes('The interviewer left the call'), 'the chat box is disabled once the interviewer left');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: while paused the chat box stays editable, sending is blocked and a reminder shows; the pad has no Ready button or paused reminder',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, ChatPanel, CodingPad } = bundle.module;
        const chat = paused => renderToStaticMarkup(React.createElement(ChatPanel, { chat: [], draft: 'kept', paused, onSend: () => {}, onTyping: () => {} }));
        const on = chat(true);
        const area = on.match(/<textarea[^>]*>/)[0];
        assert(!area.includes('disabled=""'), 'the textarea stays editable while paused');
        assert(/<button[^>]*aria-label="Send chat message"[^>]*disabled=""/.test(on) || /<button[^>]*disabled=""[^>]*aria-label="Send chat message"/.test(on), 'send is disabled while paused');
        assert(on.includes('Paused. Press ⌘P to resume and send.') && on.includes('kept'));
        const off = chat(false);
        assert(!off.includes('Press ⌘P') && !/<button[^>]*aria-label="Send chat message"[^>]*disabled=""/.test(off));
        const padOn = renderToStaticMarkup(React.createElement(CodingPad, { initialText: 'x', paused: true, onChange: () => {}, onTyping: () => {} }));
        assert(!padOn.includes('aria-label="Ready"') && !padOn.includes('Press ⌘P to resume'));
        assert(!padOn.match(/<textarea[^>]*>/)[0].includes('disabled=""'));
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
        // The processing steps tick off in order: earlier ones done, the reported one active, the rest pending.
        const reviewing = renderToStaticMarkup(React.createElement(EndedScreen, { state: { phase: 'analyzing', analysisStage: 'review', elapsedMs: 72_000, persona: PERSONA } }));
        for (const fragment of ['aria-label="Processing steps"', 'data-stage="recording" data-status="done"', 'data-stage="transcribing" data-status="done"', 'data-stage="metrics" data-status="done"', 'data-stage="review" data-status="active" aria-current="step"', 'data-stage="saving" data-status="pending"', 'Writing the feedback']) {
          assert(reviewing.includes(fragment), `the processing screen is missing ${fragment}`);
        }
        assert(analysing.includes('data-stage="recording" data-status="active"'), 'an unreported stage reads as the first step in progress');
        assert(!analysing.includes('data-status="done"'), 'no step is shown finished before the service reports progress');
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
          'aria-label="Play recording"', 'role="slider"', 'aria-valuemax="600000"', 'aria-valuenow="140000"', 'aria-valuetext="2:20 of 10:00, Onboarding story"',
          'data-chapter="0"', 'data-chapter="1"', 'data-chapter="2"', 'style="left:20%;width:calc(50% - 2px);transform:scaleY(0.6)"',
          ...MARKERS_BY_KIND,
          'aria-label="Seek to Onboarding story at 2:00"', 'aria-label="Seek to Talked over at 3:00"', 'aria-label="Seek to We rewrote the first-run flow. at 2:15"',
          'aria-label="Delete recording"', 'aria-label="Call transcript"', 'data-current-turn="true"', 'data-current-turn="false"',
          'aria-label="Feedback"', 'data-testid="practice-feedback"', 'aria-label="Delivery"', '168 words per minute', 'pause count',
        ]) assert(markup.includes(fragment), `replay view is missing ${fragment}`);
        const bar = markup.slice(markup.indexOf('aria-label="Replay position"'), markup.indexOf('class="flex min-w-0 items-baseline'));
        assert(bar.length > 0, 'the seek bar must render before the time row');
        assert(!bar.includes('title='), 'the seek bar must not fall back to native title tooltips');
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
    name: 'practice call render: replay positioning helpers pick turns and format times',
    async run() {
      const model = await import(pathToFileURL(path.join(PRACTICE, 'replayModel.js')).href);
      const { turnAt, formatTime } = model;
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
          const hangUps = [];
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'consent' }),
            onState: listener => { listeners.push(listener); return () => { const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1); }; },
            onEvent: () => () => {},
            agreeModelDownload: async () => { invoked.push('agree'); },
            hangUp: async options => { hangUps.push(options); },
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
            // The interviewer leaving keeps the call screen up; the red button asks how to leave.
            await push({ interviewerLeft: true, speaking: null });
            assert(byLabel('Interviewer left')?.textContent.includes('Dana Whitfield left the call'), 'the call screen must say the interviewer left');
            assert(byLabel('Hang up') && !byLabel('Leave the call'), 'the call stays up with no dialog until Hang up is pressed');
            await act(() => byLabel('Hang up').click());
            assert(hangUps.length === 0, 'pressing Hang up alone must not end the call');
            const choices = [...byLabel('Leave the call').querySelectorAll('button')].map(node => node.textContent);
            assert(choices.join('|') === 'Leave and generate feedback|Leave without feedback|Stay on the call', `unexpected leave choices: ${choices.join('|')}`);
            await act(() => [...byLabel('Leave the call').querySelectorAll('button')].find(node => node.textContent === 'Stay on the call').click());
            assert(!byLabel('Leave the call') && byLabel('Hang up'), 'staying closes the dialog and keeps the call');
            await act(() => byLabel('Hang up').click());
            await act(() => [...byLabel('Leave the call').querySelectorAll('button')].find(node => node.textContent === 'Leave without feedback').click());
            assert(hangUps.length === 1 && hangUps[0]?.feedback === false, 'leaving without feedback must pass feedback: false');
            await push({ phase: 'replay' });
            assert(byLabel('Replay position')?.getAttribute('aria-valuemax') === '600000', 'replay must render the loaded replay payload');
          } finally { await act(() => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the call screen shows a notice banner, an unread dot for interviewer chat, and a disabled chat after the interviewer left',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} };
        const render = state => renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, ...state }, api }));
        const plain = render({});
        assert(!plain.includes('call-notice') && !plain.includes('chat-unread'), 'no banner and no unread dot without a notice or an interviewer message');
        const noticed = render({ notice: { code: 'voice-failed', message: 'The interviewer voice stopped.' } });
        assert(noticed.includes('data-testid="call-notice"') && noticed.includes('The interviewer voice stopped.'), 'the notice message appears in the call screen');
        const unread = render({ chat: [{ from: 'candidate', text: 'hi', atMs: 1 }, { from: 'interviewer', text: 'Hello there', atMs: 2 }] });
        assert(unread.includes('data-testid="chat-unread"'), 'an interviewer message with the panel closed leaves a dot on the chat button');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: an unsent chat answer survives closing the panel and typing is re-reported every 3 s while the box has text and focus',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        const realSet = globalThis.setInterval;
        const realClear = globalThis.clearInterval;
        const timers = new Map();
        let nextId = 1000;
        const fakeSet = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
        const fakeClear = id => { timers.delete(id); };
        try {
          const listeners = [];
          const typing = [];
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'in-call', persona: PERSONA, chat: [] }),
            onState: listener => { listeners.push(listener); return () => {}; },
            onEvent: () => () => {},
            sendChat: async () => {},
            setTyping: async value => { typing.push(value); },
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const setValue = (node, value) => {
            node.focus();
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(node, value);
            node.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          };
          const refreshers = () => [...timers.values()].filter(timer => timer.ms === 3000);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await act(() => byLabel('Chat').click());
            globalThis.setInterval = fakeSet; window.setInterval = fakeSet;
            globalThis.clearInterval = fakeClear; window.clearInterval = fakeClear;
            await act(() => setValue(byLabel('Chat message'), 'half an answer'));
            assert(refreshers().length === 1, 'a focused box with text re-reports typing every 3 s');
            typing.length = 0;
            await act(() => { refreshers()[0].fn(); });
            assert(typing.join() === 'true', 'each tick re-sends typing true');
            await act(() => byLabel('Close chat').click());
            assert(refreshers().length === 0, 'closing the panel stops the refresh');
            await act(() => byLabel('Chat').click());
            assert(byLabel('Chat message').value === 'half an answer', 'the unsent answer is still there');
            assert(refreshers().length === 0, 'no refresh without focus');
            await act(() => { byLabel('Chat message').focus(); });
            assert(refreshers().length === 1, 'focusing a box with text starts the refresh');
            await act(() => { byLabel('Chat message').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
            assert(refreshers().length === 0, 'blur stops the refresh');
            await act(() => setValue(byLabel('Chat message'), ''));
            assert(refreshers().length === 0, 'an empty draft has no refresh');
          } finally { await act(() => root.unmount()); }
        } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: chat sends on Enter, keeps Shift+Enter for new lines, reports typing only while the draft has text, and clears the unread dot when opened',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      // The bundle is built inside the DOM so React sees a browser and handles input events natively.
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        try {
          const listeners = [];
          const sent = [];
          const typing = [];
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'in-call', persona: PERSONA, chat: [] }),
            onState: listener => { listeners.push(listener); return () => {}; },
            onEvent: () => () => {},
            sendChat: async text => { sent.push(text); },
            setTyping: async value => { typing.push(value); },
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const push = patch => act(() => { listeners.forEach(listener => listener(patch)); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          const setValue = (node, value) => {
            node.focus();
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(node, value);
            node.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          };
          const key = (node, init) => node.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            await push({ chat: [{ from: 'interviewer', text: 'Quick question', atMs: 1000 }] });
            assert(window.document.querySelector('[data-testid="chat-unread"]'), 'the unread dot shows while the panel is closed');
            await act(() => byLabel('Chat').click());
            assert(!window.document.querySelector('[data-testid="chat-unread"]'), 'opening the panel clears the dot');
            await push({ chat: [{ from: 'interviewer', text: 'Quick question', atMs: 1000 }, { from: 'interviewer', text: 'Another', atMs: 2000 }] });
            assert(!window.document.querySelector('[data-testid="chat-unread"]'), 'no dot while the panel is open');
            const box = byLabel('Chat message');
            assert(box.tagName === 'TEXTAREA' && box.maxLength === 2000, 'the message box is a textarea limited to 2000 characters');
            await act(() => setValue(box, 'x'.repeat(1799)));
            assert(!window.document.querySelector('[data-testid="chat-counter"]'), 'no counter below 1800 characters');
            await act(() => setValue(box, 'x'.repeat(1800)));
            assert(window.document.querySelector('[data-testid="chat-counter"]')?.textContent === '1800/2000', 'the counter shows from 1800 characters');
            await act(() => setValue(box, ''));
            assert(typing.join() === 'true,true,false', `typing follows the draft, got ${typing.join()}`);
            typing.length = 0;
            await act(() => setValue(box, 'line one'));
            await act(() => key(box, { key: 'Enter', shiftKey: true }));
            assert(sent.length === 0, 'Shift+Enter does not send');
            await act(() => key(box, { key: 'Enter' }));
            assert(sent.join('|') === 'line one', 'Enter sends the draft');
            assert(typing[typing.length - 1] === false && box.value === '', 'sending clears the draft and ends typing');
            typing.length = 0;
            await act(() => setValue(box, 'again'));
            await act(() => { box.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
            assert(typing[typing.length - 1] === false, 'leaving the box ends typing');
            typing.length = 0;
            await act(() => byLabel('Close chat').click());
            assert(typing[typing.length - 1] === false, 'closing the panel ends typing');
            await act(() => byLabel('Chat').click());
            await push({ interviewerLeft: true });
            assert(byLabel('Chat message').disabled === true, 'the chat box is disabled once the interviewer left');
          } finally { await act(() => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: Decline hangs up without feedback and a replay window shows the replay whatever the call state says',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
      try {
        for (const replayWindow of [false, true]) {
          await withDom(async window => {
            if (replayWindow) window.history.replaceState({}, '', '/?view=practice-call&replay=1&callId=call-dana-1');
            const hangUps = [];
            let replayLoads = 0;
            window.practiceCallAPI = {
              getState: async () => ({ phase: replayWindow ? 'precheck' : 'ringing', persona: PERSONA }),
              onState: () => () => {},
              onEvent: () => () => {},
              hangUp: async options => { hangUps.push(options); },
              getReplay: async () => { replayLoads += 1; return REPLAY; },
            };
            const root = bundle.module.createRoot(window.document.getElementById('root'));
            const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
            const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
            try {
              await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
              if (replayWindow) {
                assert(byLabel('Replay position') && replayLoads >= 1, 'a replay window loads and shows the replay instead of the precheck screen');
              } else {
                await act(() => byLabel('Decline call').click());
                assert(hangUps.length === 1 && hangUps[0]?.feedback === false, 'declining must pass feedback: false so the window closes');
              }
            } finally { await act(() => root.unmount()); }
          });
        }
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
  {
    name: 'practice call render: scrubber helpers clamp positions, chapters, fills, bubbles, markers and keys',
    async run() {
      const model = await import(pathToFileURL(path.join(PRACTICE, 'replayModel.js')).href);
      const { positionToMs, chapterIndexAt, segmentLayout, segmentFill, bubbleLeftPx, nearestMarker, prevChapterStart, nextChapterStart, scrubberKeyTarget } = model;
      const chapters = REPLAY.chapters;

      assert(positionToMs(0, 300, 600_000) === 0, 'the left edge of the bar is time zero');
      assert(positionToMs(150, 300, 600_000) === 300_000, 'the middle of the bar is half the duration');
      assert(positionToMs(300, 300, 600_000) === 600_000, 'the right edge of the bar is the duration');
      assert(positionToMs(-40, 300, 600_000) === 0, 'x left of the bar clamps to zero');
      assert(positionToMs(900, 300, 600_000) === 600_000, 'x right of the bar clamps to the duration');
      assert(positionToMs(150, 0, 600_000) === 0, 'a bar with no width has no position');
      assert(positionToMs(150, 300, 0) === 0, 'a recording with no duration has no position');

      assert(chapterIndexAt(chapters, 0) === 0, 'time zero is in the first chapter');
      assert(chapterIndexAt(chapters, 119_999) === 0, 'the last millisecond before a boundary stays in the earlier chapter');
      assert(chapterIndexAt(chapters, 120_000) === 1, 'a chapter start belongs to the new chapter');
      assert(chapterIndexAt(chapters, 419_999) === 1, 'the middle chapter owns its tail');
      assert(chapterIndexAt(chapters, 420_000) === 2, 'the final chapter starts at its own start');
      assert(chapterIndexAt(chapters, 599_999) === 2, 'the final millisecond of the call is in the last chapter');
      assert(chapterIndexAt(chapters, -1) === -1, 'nothing before the call has a chapter');
      assert(chapterIndexAt(chapters, 620_000) === -1, 'a position past the last chapter end has no chapter');
      assert(chapterIndexAt([], 10) === -1, 'an empty chapter list has no chapter');
      assert(chapterIndexAt([{ startMs: 0 }, { startMs: 100_000 }], 50_000) === 0, 'a chapter without an endMs runs to the next start');

      const layout = segmentLayout(chapters, 600_000);
      assert(layout.length === 3, 'every chapter becomes a segment');
      assert(layout[0].startMs === 0 && layout[0].endMs === 120_000 && layout[0].leftPct === 0 && layout[0].widthPct === 20, 'the first segment spans 0-20%');
      assert(layout[1].startMs === 120_000 && layout[1].endMs === 420_000 && layout[1].leftPct === 20 && layout[1].widthPct === 50, 'the middle segment spans 20-70%');
      assert(layout[2].startMs === 420_000 && layout[2].endMs === 600_000 && layout[2].leftPct === 70 && layout[2].widthPct === 30, 'the last segment spans 70-100%');
      assert(layout[1].title === 'Onboarding story', 'a segment keeps its chapter title');
      assert(segmentLayout([{ title: 'Solo', startMs: 0 }], 100_000)[0].endMs === 100_000, 'a chapter without an endMs fills to the end of the recording');
      assert(segmentLayout([], 600_000).length === 0, 'no chapters means no segments');
      assert(segmentLayout(chapters, 0).length === 0, 'no duration means no segments');

      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 120_000) === 0, 'a segment is empty at its start');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 270_000) === 0.5, 'a segment is half filled at its midpoint');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 420_000) === 1, 'a segment is full at its end');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 600_000) === 1, 'a segment stays full past its end');
      assert(segmentFill({ startMs: 120_000, endMs: 420_000 }, 0) === 0, 'a segment is empty before it starts');
      assert(segmentFill({ startMs: 5_000, endMs: 5_000 }, 5_000) === 0, 'a zero-width segment never fills');

      assert(bubbleLeftPx(0, 300, 80) === 0, 'a bubble at the left edge is clamped to zero');
      assert(bubbleLeftPx(150, 300, 80) === 110, 'a centred bubble is offset by half its width');
      assert(bubbleLeftPx(300, 300, 80) === 220, 'a bubble at the right edge stays inside the bar');
      assert(bubbleLeftPx(-20, 300, 80) === 0, 'a bubble left of the bar clamps to zero');
      assert(bubbleLeftPx(150, 60, 80) === 0, 'a bubble wider than the bar sits at zero');
      assert(bubbleLeftPx(150, 0, 80) === 0, 'a bar with no width has no bubble offset');

      const pause = { kind: 'pause', label: 'Long pause', atMs: 30_000 };
      const talkOver = { kind: 'interruption', label: 'Talked over', atMs: 33_000 };
      assert(nearestMarker([pause], 30_600, 600_000, 600).label === 'Long pause', 'a marker within a pixel under the cursor is picked');
      assert(nearestMarker([pause], 36_000, 600_000, 600).label === 'Long pause', 'a marker exactly 6px away still counts');
      assert(nearestMarker([pause], 37_000, 600_000, 600) === null, 'a marker 7px away does not count');
      assert(nearestMarker([pause, talkOver], 32_000, 600_000, 600).label === 'Talked over', 'the closest of two markers wins');
      assert(nearestMarker([pause], 30_000, 600_000, 600).atMs === 30_000, 'the returned marker carries its clamped time');
      assert(nearestMarker([], 30_000, 600_000, 600) === null, 'no markers means no hint');
      assert(nearestMarker([pause], 0, 0, 600) === null, 'a recording with no duration has no marker hint');
      assert(nearestMarker([pause], 30_000, 600_000, 0) === null, 'a bar with no width has no marker hint');

      assert(prevChapterStart(chapters, 122_000) === 120_000, 'past the first second a previous jump restarts the chapter');
      assert(prevChapterStart(chapters, 120_500) === 0, 'inside the first second of a chapter a previous jump goes back one');
      assert(prevChapterStart(chapters, 0) === 0, 'the first chapter cannot go back further than zero');
      assert(prevChapterStart(chapters, 300_000) === 120_000, 'the middle of a chapter restarts at its own start');
      assert(prevChapterStart([], 50_000) === 0, 'no chapters means the previous jump is zero');
      assert(prevChapterStart(chapters, 1_000, 2_000) === 0, 'a longer grace still keeps the first chapter at zero');

      assert(nextChapterStart(chapters, 0, 600_000) === 120_000, 'the next chapter starts at 2:00');
      assert(nextChapterStart(chapters, 120_000, 600_000) === 420_000, 'the next jump from a chapter start is the following chapter');
      assert(nextChapterStart(chapters, 420_000, 600_000) === 600_000, 'past the last chapter the next jump is the end of the call');
      assert(nextChapterStart(chapters, 590_000, 600_000) === 600_000, 'the tail of the last chapter jumps to the end');
      assert(nextChapterStart([], 590_000, 600_000) === 600_000, 'no chapters means the next jump is the end of the call');

      assert(scrubberKeyTarget('ArrowRight', {}, 100_000, 600_000, chapters) === 105_000, 'ArrowRight moves five seconds');
      assert(scrubberKeyTarget('ArrowLeft', {}, 100_000, 600_000, chapters) === 95_000, 'ArrowLeft moves five seconds back');
      assert(scrubberKeyTarget('ArrowLeft', {}, 1_000, 600_000, chapters) === 0, 'ArrowLeft clamps at zero');
      assert(scrubberKeyTarget('ArrowRight', {}, 598_000, 600_000, chapters) === 600_000, 'ArrowRight clamps at the end');
      assert(scrubberKeyTarget('l', {}, 100_000, 600_000, chapters) === 110_000, 'L moves ten seconds forward');
      assert(scrubberKeyTarget('L', {}, 100_000, 600_000, chapters) === 110_000, 'shift+L moves ten seconds forward');
      assert(scrubberKeyTarget('j', {}, 100_000, 600_000, chapters) === 90_000, 'J moves ten seconds back');
      assert(scrubberKeyTarget('J', {}, 100_000, 600_000, chapters) === 90_000, 'shift+J moves ten seconds back');
      assert(scrubberKeyTarget('Home', {}, 300_000, 600_000, chapters) === 0, 'Home jumps to the start');
      assert(scrubberKeyTarget('End', {}, 300_000, 600_000, chapters) === 600_000, 'End jumps to the end');
      assert(scrubberKeyTarget('PageUp', {}, 300_000, 600_000, chapters) === 120_000, 'PageUp restarts the current chapter');
      assert(scrubberKeyTarget('PageUp', {}, 120_800, 600_000, chapters) === 0, 'PageUp inside the first second goes back one chapter');
      assert(scrubberKeyTarget('PageDown', {}, 120_000, 600_000, chapters) === 420_000, 'PageDown jumps to the next chapter');
      assert(scrubberKeyTarget('PageDown', {}, 420_000, 600_000, chapters) === 600_000, 'PageDown past the last chapter jumps to the end');
      assert(scrubberKeyTarget('ArrowRight', { altKey: true }, 300_000, 600_000, chapters) === 420_000, 'Alt+ArrowRight jumps to the next chapter');
      assert(scrubberKeyTarget('ArrowLeft', { altKey: true }, 300_000, 600_000, chapters) === 120_000, 'Alt+ArrowLeft restarts the current chapter');
      assert(scrubberKeyTarget('ArrowRight', {}, 0, 600_000, []) === 5_000, 'keys still work without chapters');
      assert(scrubberKeyTarget('Enter', {}, 300_000, 600_000, chapters) === null, 'unhandled keys return null');
      assert(scrubberKeyTarget(' ', { altKey: true }, 300_000, 600_000, chapters) === null, 'unhandled keys with Alt return null');
    },
  },
  {
    name: 'practice call render: the scrubber draws chapter segments, fill layers, a knob and a chapter readout without native tooltips',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY, api: {}, initialPositionMs: 270_000 }));
        const bar = markup.slice(markup.indexOf('data-scrubber="true"'), markup.indexOf('class="flex min-w-0 items-baseline'));
        assert(bar.length > 0, 'the seek bar renders before the time row');
        assert((bar.match(/data-chapter="/g) || []).length === 3, 'one segment element per chapter');
        assert(bar.includes('data-chapter="1"'), 'the middle chapter has its own segment');
        assert(bar.includes('style="left:0%;width:calc(20% - 2px);transform:scaleY(0.6)"'), 'the first segment is 2px short and idles at scaleY(0.6)');
        assert(bar.includes('style="left:20%;width:calc(50% - 2px);transform:scaleY(0.6)"'), 'the middle segment keeps the 2px gap');
        assert(bar.includes('style="left:70%;width:30%;transform:scaleY(0.6)"'), 'the last segment has no gap after it');
        assert(bar.includes('transition-transform duration-100 ease-out'), 'segment growth is a 100ms transform transition');
        assert(bar.includes('class="absolute inset-0 bg-white/20"'), 'each segment draws its unplayed track');
        assert(bar.includes('class="absolute inset-y-0 left-0 bg-violet-400" style="width:50%"'), 'the current chapter is filled to the playhead');
        assert(bar.includes('class="absolute inset-y-0 left-0 bg-violet-400" style="width:0%"'), 'a later chapter has no played fill');
        assert(bar.includes('h-[13px] w-[13px]'), 'the knob is 13px round');
        assert(bar.includes('data-scrubber-knob="true"'), 'the knob is part of the bar');
        assert(bar.includes('transform:translate(-50%, -50%) scale(0)'), 'the knob is hidden until the bar is hovered');
        assert(!bar.includes('title='), 'no native title tooltips anywhere in the bar');
        assert(bar.includes('data-marker-kind="pause"') && bar.includes('data-marker-kind="interruption"'), 'moment markers stay as coloured ticks');
        assert(markup.includes('aria-valuetext="4:30 of 10:00, Onboarding story"'), 'aria-valuetext reports the time and chapter');
        assert(/<span class="[^"]*font-mono[^"]*">4:30 \/ 10:00<\/span>/u.test(markup), 'the time row reads current / duration');
        assert(/<span class="[^"]*whitespace-nowrap[^"]*">4:30 \/ 10:00<\/span>/u.test(markup), 'the time stays on one line beside a long chapter title');
        assert(markup.includes('aria-label="Current chapter: Onboarding story. Show chapters"'), 'the time row offers the current chapter');
        const unchaptered = renderToStaticMarkup(React.createElement(Replay, { replay: { durationMs: 60_000, chapters: [], transcript: [] }, api: {} }));
        const plainBar = unchaptered.slice(unchaptered.indexOf('data-scrubber="true"'), unchaptered.indexOf('class="flex min-w-0 items-baseline'));
        assert((plainBar.match(/data-chapter="/g) || []).length === 1, 'a recording without chapters still has one full-width segment');
        assert(plainBar.includes('style="left:0%;width:100%;transform:scaleY(0.6)"'), 'the fallback segment spans the whole bar');
        assert(!unchaptered.includes('aria-label="Current chapter:'), 'no chapter readout without chapters');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: avatarOf gives one upper-case letter of the first name and a stable colour per name, neutral without a name',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { avatarOf, AVATAR_PALETTE, NEUTRAL_AVATAR_COLOR } = bundle.module.persona;
        const dana = avatarOf({ name: 'dana whitfield' });
        assert(dana.letter === 'D', `one letter expected, got ${dana.letter}`);
        assert(avatarOf({ name: 'dana whitfield' }).color === dana.color, 'the same name always gets the same colour');
        assert(AVATAR_PALETTE.includes(dana.color), 'the colour comes from the palette');
        const colours = new Set(['Dana Whitfield', 'John Park', 'Priya Nair', 'Marcus Lee', 'Sofia Reyes', 'Tom Ide'].map(name => avatarOf({ name }).color));
        assert(colours.size > 1, 'different names do not all share one colour');
        const none = avatarOf({});
        assert(none.letter === '' && none.color === NEUTRAL_AVATAR_COLOR, 'no name gives a neutral colour and no letter');
        assert(avatarOf(null).letter === '', 'a missing person never throws');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: a panel call shows one tile per interviewer with letter, name and role, rings only the speaking one and says everyone left',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} };
        const participants = [
          { id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' },
          { id: 'B', name: 'John Park', role: 'Senior engineer', status: 'joined' },
          { id: 'C', name: 'Priya Nair', role: 'Designer', status: 'joined' },
        ];
        const render = state => renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants, ...state }, api }));
        const markup = render({ speakingId: 'B', captions: [{ speaker: 'interviewer', speakerId: 'B', text: 'Hello', atMs: 1 }, { speaker: 'interviewer', text: 'Hi', atMs: 2 }] });
        assert((markup.match(/data-avatar="true"/g) || []).length === 3, 'one avatar per interviewer');
        for (const fragment of ['aria-label="John Park"', 'Senior engineer', '>J<', '>P<', 'data-tiles="3"', 'grid-cols-3']) assert(markup.includes(fragment), `panel call is missing ${fragment}`);
        assert((markup.match(/data-speaking="true"/g) || []).length === 1 && /aria-label="John Park" data-speaking="true"/.test(markup), 'only the speakingId tile is ringed');
        assert(/aria-label="Dana Whitfield" data-speaking="false"/.test(markup), 'the lead is not ringed while a colleague speaks');
        assert(markup.includes('aria-label="Your camera"') && markup.includes('z-10'), 'the self-view stays on top of the tiles');
        const duo = render({ participants: participants.slice(0, 2), speakingId: null });
        assert(duo.includes('grid-cols-2') && !duo.includes('data-speaking="true"'), 'two tiles sit side by side and a null speakingId rings nobody');
        const withCaptions = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants, captions: [{ speaker: 'interviewer', speakerId: 'B', text: 'Hello', atMs: 1 }, { speaker: 'interviewer', text: 'Hi', atMs: 2 }, { speaker: 'interviewer', speakerId: 'Z', text: 'Yo', atMs: 3 }] }, api }));
        // Captions are hidden until switched on, so check the label rule through the DOM test below; here only the markup of tiles.
        assert(!withCaptions.includes('Live captions'), 'captions stay off by default');
        const wrapped = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants }, api, leaveRequest: 0 }));
        assert(!wrapped.includes('col-span-2'), 'three tiles stay in one row while no side panel is open');
        const left = render({ interviewerLeft: true, speaking: null });
        assert(left.includes('Everyone left the call') && !left.includes('Dana Whitfield left the call'), 'with several interviewers the notice says everyone left');
        assert((left.match(/data-left="true"/g) || []).length === 3, 'every tile dims');
        const solo = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, interviewerLeft: true }, api }));
        assert(solo.includes('Dana Whitfield left the call'), 'a solo call keeps the named notice');
        // Four and five interviewers (ids A to E), with obviously synthetic names.
        const crowd = ['Test Person One', 'Test Person Two', 'Test Person Three', 'Test Person Four', 'Test Person Five']
          .map((name, at) => ({ id: 'ABCDE'[at], name, role: `Role ${at + 1}`, status: 'joined' }));
        const four = render({ participants: crowd.slice(0, 4), speakingId: 'D' });
        assert(four.includes('data-tiles="4"') && four.includes('grid-cols-2') && four.includes('grid-rows-2'), 'four tiles form a 2 by 2 grid');
        assert(!four.includes('col-span-2') && !four.includes('grid-cols-3'), 'four tiles are all the same size');
        for (const person of crowd.slice(0, 4)) assert(four.includes(`aria-label="${person.name}"`) && four.includes(person.role), `four-tile call shows ${person.name}`);
        const five = render({ participants: crowd, speakingId: 'E' });
        assert(five.includes('data-tiles="5"') && five.includes('grid-cols-6') && five.includes('grid-rows-2'), 'five tiles use a six-column, two-row grid');
        assert((five.match(/col-span-2/g) || []).length === 5 && five.includes('col-start-2') && five.includes('col-start-4'), 'five tiles are equal and the bottom pair is centred');
        // The candidate's own picture floats over the bottom right, so only the last tile carries its name at the top.
        assert((five.match(/data-label-top="true"/g) || []).length === 1 && (four.match(/data-label-top="true"/g) || []).length === 1, 'one tile moves its name clear of the self view');
        assert(!render({ participants: crowd.slice(0, 2), speakingId: 'A' }).includes('data-label-top'), 'two tiles keep their names at the bottom');
        for (const person of crowd) assert(five.includes(`aria-label="${person.name}"`) && five.includes(person.role), `five-tile call shows ${person.name}`);
        assert((five.match(/data-avatar="true"/g) || []).length === 5 && /aria-label="Test Person Five" data-speaking="true"/.test(five), 'five avatars and the fifth speaker is ringed');
        const { avatarOf, replaySpeakerName } = await import('../../src/practice-call/persona.js');
        assert(new Set(crowd.map(person => avatarOf(person).letter)).size === 1 && crowd.every(person => avatarOf(person).color), 'avatars resolve for every colleague');
        const replay = { persona: { name: crowd[0].name }, panel: crowd.slice(1) };
        assert(['B', 'C', 'D', 'E'].every((id, at) => replaySpeakerName(replay, id) === crowd[at + 1].name) && replaySpeakerName(replay, 'A') === crowd[0].name, 'replay names every id A to E');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: a colleague who joins late rises in with a toast for 4 s and one chime, captions name the speaker, and three tiles wrap 2+1 beside a side panel',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/practice-call/PracticeCallApp.jsx'), {});
        const realSet = globalThis.setTimeout;
        const realClear = globalThis.clearTimeout;
        const timers = new Map();
        let nextId = 5000;
        const fakeSet = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
        const fakeClear = id => { timers.delete(id); };
        const chimes = [];
        window.AudioContext = class { constructor() { chimes.push(this); this.currentTime = 0; this.destination = {}; } createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } resume() {} close() {} };
        try {
          const listeners = [];
          const lead = { id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' };
          window.practiceCallAPI = {
            getState: async () => ({ phase: 'in-call', persona: PERSONA, participants: [lead], captions: [], chat: [] }),
            onState: listener => { listeners.push(listener); return () => {}; },
            onEvent: () => () => {},
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const act = fn => bundle.module.act(async () => { await fn(); await Promise.resolve(); await Promise.resolve(); });
          const push = patch => act(() => { listeners.forEach(listener => listener(patch)); });
          const byLabel = label => window.document.querySelector(`[aria-label="${label}"]`);
          try {
            await act(() => root.render(bundle.module.React.createElement(bundle.module.PracticeCallApp)));
            assert(!byLabel('Participant joined') && chimes.length === 0, 'the opening cast makes no toast and no chime');
            globalThis.setTimeout = fakeSet; window.setTimeout = fakeSet;
            globalThis.clearTimeout = fakeClear; window.clearTimeout = fakeClear;
            const john = { id: 'B', name: 'John Park', role: 'Senior engineer', status: 'joined' };
            await push({ participants: [lead, john], speakingId: 'B', captions: [{ speaker: 'interviewer', speakerId: 'B', text: 'Welcome.', atMs: 1 }, { speaker: 'interviewer', text: 'Plain.', atMs: 2 }] });
            assert(byLabel('Participant joined')?.textContent === 'John Park joined', 'a toast names the colleague');
            assert(chimes.length === 1, 'one join chime plays');
            assert(byLabel('John Park')?.className.includes('pc-rise') && !byLabel('Dana Whitfield')?.className.includes('pc-rise'), 'only the newcomer rises in');
            const toastTimer = [...timers.values()].find(timer => timer.ms === 4000);
            assert(toastTimer, 'the toast is on a 4 s timer');
            await act(() => { toastTimer.fn(); });
            assert(!byLabel('Participant joined'), 'the toast goes away after 4 s');
            await push({ participants: [lead, john] });
            assert(chimes.length === 1 && !byLabel('Participant joined'), 'an unchanged list does not chime again');
            await act(() => byLabel('Captions').click());
            const labels = [...window.document.querySelectorAll('[aria-label="Live captions"] p span')].map(node => node.textContent);
            assert(labels.join('|') === 'John:|Interviewer:', `captions are labelled by speaker, got ${labels.join('|')}`);
            const priya = { id: 'C', name: 'Priya Nair', role: 'Designer', status: 'joined' };
            await push({ participants: [lead, john, priya] });
            assert(byLabel('Participant joined')?.textContent === 'Priya Nair joined', 'a third interviewer gets a toast too');
            assert(!byLabel('Priya Nair').className.includes('col-span-2'), 'three tiles stay in one row without a side panel');
            await act(() => byLabel('Chat').click());
            assert(byLabel('Priya Nair').className.includes('col-span-2'), 'with a side panel open three tiles wrap 2+1');
            assert(byLabel('Your camera'), 'the self-view stays on the call');
          } finally { await act(() => root.unmount()); }
        } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; await bundle.dispose(); }
      });
    },
  },
  {
    name: 'practice call render: the join chime is two soft notes and never throws without audio; panel events reach the window state',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { ringtone, callModel } = bundle.module;
        const notes = [];
        class Fake {
          constructor() { this.currentTime = 2; this.destination = {}; }
          createOscillator() { const o = { frequency: { setValueAtTime: hz => notes.push(hz) }, connect() {}, start() {}, stop() {} }; return o; }
          createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
          resume() {}
          close() {}
        }
        ringtone.playJoinChime({ AudioContext: Fake });
        assert(JSON.stringify(notes) === '[660,880]', `two rising notes expected, got ${JSON.stringify(notes)}`);
        for (const win of [null, {}, { AudioContext: class { constructor() { throw new Error('blocked'); } } }]) ringtone.playJoinChime(win);
        const joined = callModel.mergeEvent({ phase: 'in-call', participants: [{ id: 'A', name: 'Dana' }] }, { type: 'participant-joined', id: 'B', name: 'John' });
        assert(joined.participants.length === 2 && joined.participants[1].name === 'John', 'a joined event adds the colleague');
        assert(callModel.mergeEvent(joined, { type: 'participant-joined', id: 'B', name: 'John' }).participants.length === 2, 'a repeated join is not duplicated');
        assert(callModel.mergeEvent(joined, { type: 'speaker', speakerId: 'B' }).speakingId === 'B', 'a speaker event moves the ring');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: replay turns name the interviewer, and a multi-speaker turn lists each segment under its speaker',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, Replay } = bundle.module;
        const replay = {
          ...REPLAY,
          persona: { name: 'Dana Whitfield' },
          panel: [{ id: 'B', name: 'John Park' }],
          transcript: [
            { role: 'interviewer', speakerId: 'B', text: 'Walk me through the design.', startMs: 120_000, endMs: 130_000 },
            { role: 'interviewer', speakerId: 'A', text: 'Thanks. John, over to you.', startMs: 131_000, endMs: 140_000, segments: [{ speakerId: 'A', text: 'Thanks.' }, { speakerId: 'B', text: 'Over to me.' }] },
            { role: 'interviewer', text: 'Plain turn.', startMs: 150_000, endMs: 160_000 },
          ],
        };
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay, api: {}, initialPositionMs: 0 }));
        assert(markup.includes('John Park · 2:00'), 'a turn with speakerId shows the interviewer name');
        assert(markup.includes('Dana Whitfield · 2:11'), 'the lead is named from the replay persona');
        assert(markup.includes('data-segment-speaker="A"') && markup.includes('data-segment-speaker="B"') && markup.includes('Over to me.'), 'segments show each speaker');
        assert(markup.includes('Interviewer · 2:30'), 'a turn without speakerId stays Interviewer');
        assert(!renderToStaticMarkup(React.createElement(Replay, { replay: { ...replay, panel: undefined, persona: undefined }, api: {} })).includes('John Park'), 'no panel on the replay falls back to Interviewer');
      } finally { await bundle.dispose(); }
    },
  },
  ...presentingTests,
  {
    name: 'practice call render: a colleague heard over the speaker rings with them, captions as its own line, and the replay marks the overlay turn',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall, Replay } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {} };
        const participants = [
          { id: 'A', name: 'Dana Whitfield', role: 'Hiring manager', status: 'joined' },
          { id: 'B', name: 'John Park', role: 'Senior engineer', status: 'joined' },
        ];
        const render = state => renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, participants, ...state }, api }));
        const both = render({ speakingId: 'A', overSpeakingId: 'B' });
        assert((both.match(/data-speaking="true"/g) || []).length === 2, 'the speaker and the overlaid colleague both ring');
        assert(/aria-label="John Park" data-speaking="true"/.test(both) && /aria-label="Dana Whitfield" data-speaking="true"/.test(both));
        assert((render({ speakingId: 'A', overSpeakingId: null }).match(/data-speaking="true"/g) || []).length === 1, 'no overlay rings only the speaker');
        const strip = render({ speakingId: 'A', overSpeakingId: 'B', screen: { title: 'Q', content: 'Body', speakerId: 'A' } });
        assert((strip.match(/data-speaking="true"/g) || []).length === 2, 'chips in the sharing bar ring too');
        const turns = [...REPLAY.transcript, { speaker: 'interviewer', speakerId: 'B', text: 'Over remark.', startMs: 1000, endMs: 1500, overlay: true }];
        const markup = renderToStaticMarkup(React.createElement(Replay, { replay: { ...REPLAY, transcript: turns }, api: {}, initialPositionMs: 200_000 }));
        assert(markup.includes('data-over-mark="true"') && markup.includes('Over remark.'), 'the overlay turn carries its marker');
        const plain = renderToStaticMarkup(React.createElement(Replay, { replay: REPLAY, api: {}, initialPositionMs: 200_000 }));
        assert(!plain.includes('data-over-mark'), 'a call without overlays shows no marker');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: the pause pill shows only while paused and the timer text stays on the published time',
    async run() {
      const bundle = await loadServerBundle();
      try {
        const { React, renderToStaticMarkup, InCall } = bundle.module;
        const api = { setMuted: () => {}, hangUp: () => {}, getPreparedCards: async () => [], sendChat: () => {}, setTyping: () => {}, setPaused: () => {} };
        const running = renderToStaticMarkup(React.createElement(InCall, { state: IN_CALL_STATE, api }));
        assert(!running.includes('Paused'), 'no pill while running');
        const paused = renderToStaticMarkup(React.createElement(InCall, { state: { ...IN_CALL_STATE, paused: true }, api }));
        assert(paused.includes('Paused \u00b7 press P to resume'), 'the pill names the key');
        assert(paused.includes('1:12'), 'the timer shows the frozen published time');
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'practice call render: shouldTogglePause toggles on bare P outside editable fields and on Command or Control P anywhere',
    async run() {
      const { default: strict } = await import('node:assert/strict');
      const { shouldTogglePause } = await import('../../src/practice-call/pauseKey.js');
      const assert = Object.assign((value, message) => strict.ok(value, message), strict);
      const div = { tagName: 'DIV' };
      assert.deepEqual(shouldTogglePause({ key: 'p', target: div }), { toggle: true, preventDefault: false });
      assert.deepEqual(shouldTogglePause({ key: 'P', target: div }), { toggle: true, preventDefault: false });
      for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
        assert.equal(shouldTogglePause({ key: 'p', target }).toggle, false, `${target.tagName} keeps typing`);
        assert.deepEqual(shouldTogglePause({ key: 'p', metaKey: true, target }), { toggle: true, preventDefault: true });
        assert.deepEqual(shouldTogglePause({ key: 'p', ctrlKey: true, target }), { toggle: true, preventDefault: true });
      }
      assert.equal(shouldTogglePause({ key: 'p', repeat: true, target: div }).toggle, false);
      assert.equal(shouldTogglePause({ key: 'p', repeat: true, metaKey: true, target: div }).toggle, false);
      assert.equal(shouldTogglePause({ key: 'p', altKey: true, target: div }).toggle, false);
      assert.equal(shouldTogglePause({ key: 'q', target: div }).toggle, false);
    },
  },
];
