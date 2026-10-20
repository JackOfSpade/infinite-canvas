import assert from 'node:assert/strict';
import { createQuitAutosaveAttempt } from '../../electron/utils/quitAutosave.js';
import { createDraftWriteBarrier } from '../../electron/utils/draftWriteBarrier.js';

function fixture(overrides = {}) {
  const events = [];
  const windows = ['first', 'second'];
  const options = {
    windows,
    beginPause: win => events.push(`gate:${win}`),
    releasePause: win => events.push(`ungate:${win}`),
    holdBridge: async () => { events.push('hold'); return { success: true }; },
    resumeBridge: async () => { events.push('resume'); return { success: true }; },
    pauseRenderer: async win => { events.push(`pause:${win}`); return { success: true, requiresCanvasSave: win === 'first' }; },
    drainSender: async win => { events.push(`drain:${win}`); return { settled: true }; },
    flushPersistence: async () => { events.push('flush'); },
    freezeRenderer: async win => { events.push(`freeze:${win}`); return true; },
    saveRenderer: async (win, state) => { events.push(`save:${win}:${state.requiresCanvasSave}`); return true; },
    releaseRenderer: win => events.push(`release:${win}`),
    windowsAreCurrent: () => true,
    ...overrides,
  };
  return { events, attempt: createQuitAutosaveAttempt(options) };
}

export default [
  {
    name: 'Quit autosave gates every window before await, checkpoints work before freezing, and saves every canvas',
    async run() {
      const { events, attempt } = fixture();
      const running = attempt.run();
      assert.deepEqual(events, ['gate:first', 'gate:second', 'hold']);
      assert.equal(await running, true);
      assert.deepEqual(events, ['gate:first', 'gate:second', 'hold', 'pause:first', 'pause:second',
        'drain:first', 'drain:second', 'flush', 'freeze:first', 'freeze:second', 'save:first:true', 'save:second:false']);
    },
  },
  ...['bridge', 'pause', 'drain', 'flush', 'windows', 'freeze', 'save'].map(stage => ({
    name: `Quit autosave keeps windows recoverable and releases admissions after ${stage} failure`,
    async run() {
      const overrides = {
        bridge: { holdBridge: async () => ({ success: false }) },
        pause: { pauseRenderer: async () => ({ success: false }) },
        drain: { drainSender: async () => ({ settled: false }) },
        flush: { flushPersistence: async () => { throw new Error('disk full'); } },
        windows: { windowsAreCurrent: () => false },
        freeze: { freezeRenderer: async () => false },
        save: { saveRenderer: async () => false },
      };
      const { events, attempt } = fixture(overrides[stage]);
      if (stage === 'save') assert.equal(await attempt.run(), false);
      else await assert.rejects(attempt.run());
      await attempt.release();
      const released = [...events];
      await attempt.release();
      assert.deepEqual(events, released, 'release is idempotent');
      assert.ok(events.includes('ungate:first') && events.includes('ungate:second') && events.includes('resume'));
      if (stage !== 'bridge') assert.ok(events.includes('release:first'), 'even an unacknowledged renderer is released');
      if (!['save'].includes(stage)) assert.ok(!events.some(event => event.startsWith('save:')));
    },
  })),
  {
    name: 'Quit retry is exposed only after sender admissions and bridge restoration settle',
    async run() {
      let finishResume;
      const resumeGate = new Promise(resolve => { finishResume = resolve; });
      const { attempt, events } = fixture({ resumeBridge: async () => {
        events.push('resume-start');
        await resumeGate;
        events.push('resume-done');
        return { success: true };
      } });
      await attempt.run();
      const release = attempt.release();
      try {
        await Promise.resolve();
        assert.ok(events.includes('ungate:first') && events.includes('ungate:second'));
        assert.ok(!events.some(event => event.startsWith('release:')),
          'an unfrozen renderer can immediately retry Quit; host release must finish first');
      } finally { finishResume(); }
      await release;
      assert.deepEqual(events.slice(-3), ['resume-done', 'release:first', 'release:second']);
    },
  },
  {
    name: 'Quit cancellation releases other windows and bridge even if one renderer release throws',
    async run() {
      const released = [];
      const { attempt, events } = fixture({ releaseRenderer: win => {
        released.push(win);
        if (win === 'first') throw new Error('destroyed');
      } });
      await attempt.run();
      await assert.rejects(attempt.release());
      assert.deepEqual(released, ['first', 'second']);
      assert.ok(events.includes('ungate:second') && events.includes('resume'));
    },
  },
  {
    name: 'Quit autosave revalidates windows after a human-paced save completes',
    async run() {
      let current = true;
      const { attempt } = fixture({
        windowsAreCurrent: () => current,
        saveRenderer: async () => { current = false; return true; },
      });
      await assert.rejects(attempt.run(), /changed while saving/);
      await attempt.release();
    },
  },
  {
    name: 'Quit cancellation surfaces a bridge restore refusal after releasing canvas gates',
    async run() {
      const { attempt, events } = fixture({ resumeBridge: async () => ({ success: false }) });
      await attempt.run();
      await assert.rejects(attempt.release());
      assert.ok(events.includes('release:second') && events.includes('ungate:second'));
    },
  },
  {
    name: 'Draft quit barrier retries a rejected invoke with its latest text before flushing the host',
    async run() {
      const writes = [];
      let fail = true;
      const barrier = createDraftWriteBarrier({ write: async (id, text) => {
        writes.push([id, text]);
        if (fail) throw new Error('temporary IPC failure');
        return { saved: true };
      }, flush: async () => { writes.push('flush'); return { flushed: true }; } });
      await assert.rejects(barrier.write('request', 'draft'));
      fail = false;
      await barrier.flush();
      assert.deepEqual(writes, [['request', 'draft'], ['request', 'draft'], 'flush']);
    },
  },
  {
    name: 'Draft quit barrier retains failed writes and refuses an unconfirmed host flush',
    async run() {
      let confirmed = false;
      let writes = 0;
      const barrier = createDraftWriteBarrier({ write: async () => { writes++; return { saved: confirmed }; },
        flush: async () => ({ flushed: false }) });
      await assert.rejects(barrier.write('request', 'draft'));
      await assert.rejects(barrier.flush(), /latest AI draft/);
      confirmed = true;
      await assert.rejects(barrier.flush(), /checkpoint/);
      assert.equal(writes, 3);
    },
  },
  {
    name: 'Draft quit barrier never retries an obsolete failure over a newer saved response',
    async run() {
      let rejectOld;
      const writes = [];
      const barrier = createDraftWriteBarrier({ write: async (_id, text) => {
        writes.push(text);
        if (text === 'old') return new Promise((_resolve, reject) => { rejectOld = reject; });
        return { saved: true };
      }, flush: async () => ({ flushed: true }) });
      const old = barrier.write('request', 'old');
      await barrier.write('request', 'new');
      rejectOld(new Error('late old failure'));
      await assert.rejects(old);
      await barrier.flush();
      assert.deepEqual(writes, ['old', 'new']);
    },
  },
  {
    name: 'Draft quit barrier retires only saved or already settled drafts',
    async run() {
      for (const code of ['MCP_ROUTE', 'REQUEST_SETTLING', 'REQUEST_OWNER_MISMATCH', 'REQUEST_SETTLED']) {
        const barrier = createDraftWriteBarrier({ write: async () => ({ saved: false, code }), flush: async () => ({ flushed: true }) });
        if (code === 'REQUEST_SETTLED') { await barrier.write('request', 'draft'); await barrier.flush(); }
        else { await assert.rejects(barrier.write('request', 'draft')); await assert.rejects(barrier.flush()); }
      }
    },
  },
];
