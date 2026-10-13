// A released application lane whose canvas cannot be opened is held as
// needs_user/canvas_unavailable. These tests pin the lifecycle that keeps such
// a lane from becoming a permanent, unclearable "needs you" row:
//   * the application source classifies the released location from
//     filesystem shape only ('present' | 'orphaned' | 'unavailable');
//   * the engine re-probes held canvas lanes and retires a lane only after a
//     bounded confirmation window with repeated orphaned observations;
//   * a returning canvas or a surviving job folder prevents retirement;
//   * a stale canvas lane never blocks a newly released job.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './testHelpers.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { createHandoffEngine } from '../../electron/ipc/handoffBridge/engine.js';
import { createLaneStore } from '../../electron/ipc/handoffBridge/laneStore.js';
import { createApplicationSource, probeApplicationCanvasPresence } from '../../electron/ipc/handoffBridge/sources/application.js';
import { normalizeBridgeStatus, EMPTY_BRIDGE_STATUS } from '../../src/utils/handoffBridgeStatus.js';
import { describeJobRow } from '../../src/utils/handoffBridgeView.js';
import { JOB_ROW_COPY, BRIDGE_UI_COPY } from '../../src/utils/handoffBridgeCopy.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { withConsoleCollector } from './fixtures/handoff-bridge/renderHarness.js';
import { withTimeout } from './fixtures/handoff-bridge/harness.js';
import { __resetHandoffBridgeStoreForTests } from '../../src/utils/handoffBridgeStore.js';
import { __resetBridgeUiForTests } from '../../src/utils/handoffBridgeUiStore.js';

const LINK = 'link-synthetic';
const CONFIRM_MS = 60_000;
// Three synthetic projects in different domains. Only folder shape matters.
const PROJECTS = [
  { folder: 'greenhouse-sensor-study', canvas: 'irrigation-plan.json', jobId: 'a1a1a1a1-1111-4111-8111-111111111111' },
  { folder: 'harbor-logistics-board', canvas: 'berth-schedule.json', jobId: 'b2b2b2b2-2222-4222-8222-222222222222' },
  { folder: 'museum-archive-index', canvas: 'catalog-notes.json', jobId: 'c3c3c3c3-3333-4333-8333-333333333333' },
];
const FRESH_JOB = 'd4d4d4d4-4444-4444-8444-444444444444';

function tempRoot(label) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ic-canvas-orphan-${label}-`))); }
function enoent() { return Object.assign(new Error('synthetic missing canvas'), { code: 'ENOENT' }); }
async function settle(turns = 60) { for (let index = 0; index < turns; index += 1) await new Promise(resolve => setImmediate(resolve)); }

// A project folder with a canvas and (optionally) its private job folder.
function makeProject(root, project, { canvas = true, jobFolder = false, jobsRoot = false } = {}) {
  const folder = path.join(root, project.folder);
  fs.mkdirSync(folder, { recursive: true });
  const canvasFilePath = path.join(folder, project.canvas);
  if (canvas) fs.writeFileSync(canvasFilePath, '{"nodes":[]}\n');
  if (jobsRoot || jobFolder) fs.mkdirSync(path.join(folder, '.local-ai', 'jobs'), { recursive: true });
  if (jobFolder) fs.mkdirSync(path.join(folder, '.local-ai', 'jobs', project.jobId));
  return { folder, canvasFilePath };
}

function heldLane(ord, project, canvasFilePath) {
  return { ord, jobId: project.jobId, canvasFilePath, releasedAt: ord, phase: 'needs_user', reason: 'canvas_unavailable', heldFrom: 'awaiting', counters: {} };
}

// The production application source with only the app-side calls replaced.
// Presence is the REAL filesystem probe, so the tests flip real folders.
function sourceFor({ missing, fresh = null }) {
  return createApplicationSource({
    getHandoff: async ({ jobId }) => {
      if (missing.has(jobId)) throw enoent();
      return { handoff: { handoffCode: `CODE-${jobId.slice(0, 4)}`, stage: 'resume', revision: 1, prompt: 'Synthetic prompt.' } };
    },
    getStatus: async jobId => {
      if (missing.has(jobId)) throw enoent();
      return fresh?.(jobId) ?? { status: 'queued', stage: 'resume' };
    },
    submitHandoff: async () => ({ accepted: true, completed: true }),
    discover: async () => [],
    subscribeDiscards: () => () => undefined,
  });
}

async function tickAndSettle(engine, clock, advanceMs = 0) {
  if (advanceMs) clock.advance(advanceMs);
  await engine.tick(clock.now());
  await settle();
}

function rowFor(engine, jobId) { return engine.snapshot().queue.jobs.find(job => job.jobId === jobId); }

async function assertOrphanRetires(factory = createHandoffEngine) {
  const root = tempRoot('sabotage');
  let engine;
  try {
    const project = PROJECTS[0];
    const { canvasFilePath } = makeProject(root, project, { canvas: false });
    const clock = createFakeClock();
    engine = factory({ source: sourceFor({ missing: new Set([project.jobId]) }),
      restoredLanes: [heldLane(1, project, canvasFilePath)], now: clock.now, timers: clock, holdMs: 0 });
    await tickAndSettle(engine, clock);
    assert(rowFor(engine, project.jobId), 'one orphan observation cannot drop the lane');
    await tickAndSettle(engine, clock, CONFIRM_MS + 1);
    assert(!rowFor(engine, project.jobId), 'repeated orphan proof must retire the lane');
  } finally {
    await engine?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export default [
  {
    name: 'handoff bridge: canvas orphan: sabotage of confirmed retirement fails the lifecycle proof',
    run: async () => {
      await assertOrphanRetires();
      const enginePath = path.resolve('electron/ipc/handoffBridge/engine.js');
      const original = fs.readFileSync(enginePath, 'utf8');
      const needle = "if (orphanRevision !== null) await dropProvenGoneLane(lane, 'canvas_orphaned', generation, orphanRevision);";
      assert(original.includes(needle), 'the confirmed retirement branch exists for sabotage');
      const mutant = original.replace(needle, 'if (false) await dropProvenGoneLane(lane, \'canvas_orphaned\', generation, orphanRevision);')
        .replace(/from '(\.{1,2}\/[^']+)'/g, (_whole, relative) => `from '${new URL(relative, pathToFileURL(enginePath)).href}'`);
      const module = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}`);
      let failed = false;
      try { await assertOrphanRetires(module.createHandoffEngine); }
      catch (error) { failed = /repeated orphan proof must retire/.test(String(error?.message)); }
      assert(failed, 'the lifecycle test fails without the confirmed retirement branch');
    },
  },
  {
    name: 'handoff bridge: canvas orphan: presence probe classifies three synthetic project layouts and flips with the evidence',
    run: async () => {
      const root = tempRoot('presence');
      try {
        for (const project of PROJECTS) {
          const { folder, canvasFilePath } = makeProject(root, project, { canvas: true });
          const probe = () => probeApplicationCanvasPresence({ jobId: project.jobId, canvasFilePath });
          assert(await probe() === 'present', `${project.folder}: an existing canvas is present`);
          fs.unlinkSync(canvasFilePath);
          assert(await probe() === 'orphaned', `${project.folder}: canvas gone and no app folder at all is orphaned`);
          fs.mkdirSync(path.join(folder, '.local-ai', 'jobs'), { recursive: true });
          assert(await probe() === 'orphaned', `${project.folder}: canvas gone and no job folder is orphaned`);
          // Mutation: the job's private state reappears -> it could come back.
          fs.mkdirSync(path.join(folder, '.local-ai', 'jobs', project.jobId));
          assert(await probe() === 'unavailable', `${project.folder}: a surviving job folder means the canvas may come back (moved/renamed)`);
          fs.rmSync(path.join(folder, '.local-ai', 'jobs', project.jobId), { recursive: true });
          assert(await probe() === 'orphaned', `${project.folder}: removing the job folder flips back to orphaned`);
          fs.writeFileSync(canvasFilePath, '{}\n');
          assert(await probe() === 'present', `${project.folder}: a restored canvas is present again`);
        }
        // An unmounted volume or a moved project folder: the folder is gone.
        const away = path.join(root, 'unmounted-volume', 'project', 'canvas.json');
        assert(await probeApplicationCanvasPresence({ jobId: PROJECTS[0].jobId, canvasFilePath: away }) === 'unavailable',
          'a missing project folder is never orphaned (it can come back)');
        // A symlinked app folder whose target is gone is not proof of anything.
        const linked = makeProject(root, { ...PROJECTS[1], folder: 'linked-app-folder' }, { canvas: false });
        fs.symlinkSync(path.join(root, 'nowhere'), path.join(linked.folder, '.local-ai'));
        assert(await probeApplicationCanvasPresence({ jobId: PROJECTS[1].jobId, canvasFilePath: linked.canvasFilePath }) === 'unavailable',
          'a symlinked app folder is never treated as proof the job is gone');
        // Malformed inputs fail closed.
        for (const bad of [
          { jobId: '../escape', canvasFilePath: path.join(root, 'x.json') },
          { jobId: PROJECTS[2].jobId, canvasFilePath: 'relative/canvas.json' },
          { jobId: PROJECTS[2].jobId, canvasFilePath: `${root}/a/../b.json` },
          { jobId: PROJECTS[2].jobId, canvasFilePath: `${root}/nul\0.json` },
        ]) assert(await probeApplicationCanvasPresence(bad) === 'unavailable', `malformed probe input fails closed: ${JSON.stringify(bad.jobId)}`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: canvas orphan: a previously live held lane is rechecked after external restore removes its bundle',
    run: async () => {
      const root = tempRoot('later-restore');
      const project = PROJECTS[1];
      let engine;
      try {
        const { folder, canvasFilePath } = makeProject(root, project, { canvas: true, jobFolder: true });
        const missing = new Set();
        const clock = createFakeClock();
        engine = createHandoffEngine({ source: sourceFor({ missing }),
          restoredLanes: [heldLane(1, project, canvasFilePath)], now: clock.now, timers: clock, holdMs: 0 });
        await tickAndSettle(engine, clock);
        assert(rowFor(engine, project.jobId), 'the initially live held lane remains available');
        fs.unlinkSync(canvasFilePath);
        fs.rmSync(path.join(folder, '.local-ai', 'jobs', project.jobId), { recursive: true });
        missing.add(project.jobId);
        await tickAndSettle(engine, clock, 5 * 60_000 + 1);
        assert(rowFor(engine, project.jobId), 'the first later orphan probe cannot retire the lane');
        await tickAndSettle(engine, clock, 5 * 60_000 + 1);
        assert(!rowFor(engine, project.jobId), 'the second later orphan probe retires it');
      } finally {
        await engine?.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: canvas orphan: restored lanes retire only after repeated orphan proof and stay retired across restart',
    run: async () => {
      const root = tempRoot('restart');
      const userDataPath = path.join(root, 'user-data');
      const engines = [];
      try {
        // Three released jobs whose canvases were deleted (with their job
        // folders) while the app was off, plus one still-reachable control.
        const lanes = PROJECTS.map((project, index) => {
          const { canvasFilePath } = makeProject(root, project, { canvas: false, jobsRoot: index === 1 });
          return heldLane(index + 1, project, canvasFilePath);
        });
        const store = createLaneStore({ userDataPath });
        assert(await store.saveLanes(lanes), 'synthetic lanes persist');
        const missing = new Set(PROJECTS.map(project => project.jobId));
        const clock = createFakeClock();
        const start = () => {
          const engine = createHandoffEngine({
            source: sourceFor({ missing }), store: createLaneStore({ userDataPath }),
            restoredLanes: createLaneStore({ userDataPath }).loadLanes(clock.now()), now: clock.now, timers: clock, holdMs: 0,
          });
          engines.push(engine);
          return engine;
        };
        let engine = start();
        await tickAndSettle(engine, clock);
        for (const project of PROJECTS) {
          assert(rowFor(engine, project.jobId)?.reason === 'canvas_unavailable', 'one orphaned observation is not enough to call a canvas missing');
        }
        await tickAndSettle(engine, clock, CONFIRM_MS / 2);
        assert(rowFor(engine, PROJECTS[0].jobId)?.reason === 'canvas_unavailable', 'still inside the confirmation window');
        await tickAndSettle(engine, clock, CONFIRM_MS / 2 + 1);
        for (const project of PROJECTS) {
          const row = rowFor(engine, project.jobId);
          assert(!row, `${project.folder}: repeated orphan proof retires the lane`);
        }
        const onDisk = createLaneStore({ userDataPath }).readLanes();
        assert(onDisk.length === 0, 'retirement persists to the lane store');
        await engine.close();
        engine = start();
        assert(engine.snapshot().queue.jobs.length === 0, 'retired lanes never return after restart');
      } finally {
        for (const engine of engines) { try { await engine.close(); } catch { /* closed */ } }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: canvas orphan: a canvas that can come back is never called missing, and a returning canvas clears the refinement',
    run: async () => {
      const root = tempRoot('return');
      const engines = [];
      try {
        // Lane 1: project folder gone (unmounted volume / moved folder).
        // Lane 2: canvas file gone but its job folder survives (moved file).
        // Lane 3: orphaned, then the canvas and job state are put back.
        const away = path.join(root, 'detached-volume', PROJECTS[0].folder, PROJECTS[0].canvas);
        const moved = makeProject(root, PROJECTS[1], { canvas: false, jobFolder: true });
        const back = makeProject(root, PROJECTS[2], { canvas: false });
        const missing = new Set(PROJECTS.map(project => project.jobId));
        const clock = createFakeClock();
        const engine = createHandoffEngine({
          source: sourceFor({ missing, fresh: () => ({ status: 'completed' }) }),
          restoredLanes: [heldLane(1, PROJECTS[0], away), heldLane(2, PROJECTS[1], moved.canvasFilePath), heldLane(3, PROJECTS[2], back.canvasFilePath)],
          now: clock.now, timers: clock, holdMs: 0,
        });
        engines.push(engine);
        await tickAndSettle(engine, clock);
        await tickAndSettle(engine, clock, CONFIRM_MS / 2);
        assert(rowFor(engine, PROJECTS[0].jobId)?.reason === 'canvas_unavailable', 'a missing project folder stays canvas_unavailable indefinitely');
        assert(rowFor(engine, PROJECTS[1].jobId)?.reason === 'canvas_unavailable', 'a surviving job folder stays canvas_unavailable indefinitely');
        assert(rowFor(engine, PROJECTS[2].jobId)?.reason === 'canvas_unavailable', 'one orphan observation cannot retire a lane');
        assert(engine.snapshot().queue.jobs.length === 3, 'no lane is dropped on one observation');
        // The canvas comes back: the app answers again and the row is no
        // longer called missing (it stays held for the person to resume).
        fs.writeFileSync(back.canvasFilePath, '{}\n');
        missing.delete(PROJECTS[2].jobId);
        await tickAndSettle(engine, clock, 5 * 60_000 + 1);
        const row = rowFor(engine, PROJECTS[2].jobId);
        assert(row?.phase === 'needs_user' && row.reason === 'canvas_unavailable', `a returning canvas retains the lane (got ${row?.reason})`);
        await tickAndSettle(engine, clock, 5 * 60_000 + 1);
        assert(engine.snapshot().queue.jobs.length === 3, 'a returning canvas and surviving job state defeat retirement');
      } finally {
        for (const engine of engines) { try { await engine.close(); } catch { /* closed */ } }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: canvas orphan: a lane that loses its canvas while running is re-probed and can be confirmed missing',
    run: async () => {
      const root = tempRoot('runtime');
      const engines = [];
      try {
        const { canvasFilePath } = makeProject(root, PROJECTS[0], { canvas: true, jobFolder: true });
        const missing = new Set();
        const clock = createFakeClock();
        const engine = createHandoffEngine({ source: sourceFor({ missing }), now: clock.now, timers: clock, holdMs: 0 });
        engines.push(engine);
        assert((await engine.release({ jobs: [{ jobId: PROJECTS[0].jobId, canvasFilePath }] })).ok, 'the job releases');
        // The canvas and its job folder are deleted while the bridge runs.
        fs.rmSync(path.join(root, PROJECTS[0].folder), { recursive: true });
        fs.mkdirSync(path.join(root, PROJECTS[0].folder));
        missing.add(PROJECTS[0].jobId);
        const chat = await engine.newChat({ linkId: LINK });
        const got = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(got.status !== 'served', 'a missing canvas is never served');
        assert(rowFor(engine, PROJECTS[0].jobId)?.reason === 'canvas_unavailable', 'the lane is held canvas_unavailable');
        await tickAndSettle(engine, clock);
        await tickAndSettle(engine, clock, CONFIRM_MS + 1);
        assert(!rowFor(engine, PROJECTS[0].jobId), 'a runtime canvas hold is retired after repeated orphan proof');
      } finally {
        for (const engine of engines) { try { await engine.close(); } catch { /* closed */ } }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: canvas orphan: stale missing-canvas lanes on other canvases never block a newly released job',
    run: async () => {
      const root = tempRoot('ordering');
      const engines = [];
      try {
        const stale = PROJECTS.map((project, index) => heldLane(index + 1, project, makeProject(root, project, { canvas: false }).canvasFilePath));
        const fresh = makeProject(root, { folder: 'orchard-yield-forecast', canvas: 'harvest.json', jobId: FRESH_JOB }, { canvas: true, jobFolder: true });
        const missing = new Set(PROJECTS.map(project => project.jobId));
        const clock = createFakeClock();
        const engine = createHandoffEngine({ source: sourceFor({ missing }), restoredLanes: stale, now: clock.now, timers: clock, holdMs: 0 });
        engines.push(engine);
        await tickAndSettle(engine, clock);
        await tickAndSettle(engine, clock, CONFIRM_MS + 1);
        const chat = await engine.newChat({ linkId: LINK });
        const idle = await engine.get({ session: chat.sessionCode, linkId: LINK });
        assert(idle.status !== 'served', `retired stale lanes cannot be served (${idle.status})`);
        assert((await engine.release({ jobs: [{ jobId: FRESH_JOB, canvasFilePath: fresh.canvasFilePath }] })).ok, 'a new job releases beside the stale rows');
        const nextChat = await engine.newChat({ linkId: LINK });
        const next = await engine.get({ session: nextChat.sessionCode, linkId: LINK });
        assert(next.status === 'served' && next.handoffCode === `CODE-${FRESH_JOB.slice(0, 4)}`,
          `the newly released job is served ahead of the stale needs-you rows (${next.status}/${next.reason || ''})`);
      } finally {
        for (const engine of engines) { try { await engine.close(); } catch { /* closed */ } }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'handoff bridge: canvas orphan: rows for an unavailable or missing canvas offer an explicit Remove; other holds do not',
    run: () => {
      const missingRow = describeJobRow({ phase: 'needs_user', reason: 'canvas_missing' });
      const unavailableRow = describeJobRow({ phase: 'needs_user', reason: 'canvas_unavailable' });
      assert(missingRow.removable === true && missingRow.text === JOB_ROW_COPY.canvas_missing, 'a missing canvas row is removable and uses its own sentence');
      assert(unavailableRow.removable === true && unavailableRow.action === 'dock', 'an unavailable canvas row keeps the dock route and adds Remove');
      for (const reason of ['read_failed', 'app_fix_required', 'job_broken', 'review_stop', 'write_failed']) {
        assert(describeJobRow({ phase: 'needs_user', reason }).removable !== true, `${reason} is never offered as a bridge removal`);
      }
      assert(describeJobRow({ phase: 'held', reason: 'user_hold' }).removable !== true, 'a kept job is resumed, not removed');
      const status = JSON.parse(JSON.stringify(EMPTY_BRIDGE_STATUS));
      status.v = 1; status.seq = 1;
      status.queue = { ...status.queue, jobs: [{ jobId: PROJECTS[0].jobId, phase: 'needs_user', reason: 'canvas_missing' }] };
      assert(normalizeBridgeStatus(status).queue.jobs[0]?.reason === 'canvas_missing', 'the renderer status normalizer keeps canvas_missing');
      assert(typeof BRIDGE_UI_COPY.removeFromBridge === 'string' && BRIDGE_UI_COPY.removeFromBridge.length > 0, 'the Remove control has copy');
    },
  },
  {
    name: 'handoff bridge: canvas orphan: the panel Remove control unreleases exactly that job through the existing IPC',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-handoff-remove-'));
      const entry = path.join(directory, 'RemoveProbe.jsx'); const panel = path.resolve('src/components/HandoffBridgePanel.jsx'); const store = path.resolve('src/utils/handoffBridgeStore.js'); const uiStore = path.resolve('src/utils/handoffBridgeUiStore.js');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { HandoffBridgePanel } from ${JSON.stringify(panel)};\nexport { applyHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${JSON.stringify(store)};\nexport { openBridgePopover, __resetBridgeUiForTests } from ${JSON.stringify(uiStore)};\nexport function RemoveProbe() { return <HandoffBridgePanel />; }\n`);
      const status = (seq, extra = {}) => {
        const base = JSON.parse(JSON.stringify(EMPTY_BRIDGE_STATUS));
        Object.assign(base, { v: 1, seq, at: 1_700_000_000_000, enabled: true, autoStart: false, autoRelease: false, serving: 'live', paused: false });
        base.availability = { ...base.availability, ok: true };
        base.config.scope = { ...base.config.scope, applications: true, scoring: false };
        base.windows.canvasOpen = true;
        if (extra.queue) base.queue = { ...base.queue, ...extra.queue, applications: { ...base.queue.applications, ...(extra.queue.applications || {}) } };
        return base;
      };
      const controller = new AbortController(); let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 5000);
        await withDom(async window => withConsoleCollector(async entries => {
          const calls = [];
          window.electronAPI = {
            handoffBridgeGetStatus: async () => ({ status: status(1) }),
            onHandoffBridgeStatus: () => () => {},
            handoffBridgeGetActivity: async () => ({ items: [] }),
            handoffBridgePublishJobs: () => undefined,
            handoffBridgeHoldJob: async payload => { calls.push(['hold', payload]); return { success: true }; },
            handoffBridgeUnrelease: async payload => { calls.push(['unrelease', payload]); return { success: true }; },
          };
          bundle.module.__resetHandoffBridgeStoreForTests(); bundle.module.__resetBridgeUiForTests(); const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.RemoveProbe));
              bundle.module.applyHandoffBridgeStatus(status(2, { queue: { applications: { needsYou: 3 }, jobs: [
                { jobId: PROJECTS[0].jobId, phase: 'needs_user', stage: 'resume', reason: 'canvas_missing' },
                { jobId: PROJECTS[1].jobId, phase: 'needs_user', stage: 'resume', reason: 'canvas_unavailable' },
                { jobId: PROJECTS[2].jobId, phase: 'needs_user', stage: 'review', reason: 'app_fix_required' },
              ] } }));
              bundle.module.openBridgePopover(); await Promise.resolve(); await Promise.resolve();
            });
            const remove = [...window.document.querySelectorAll('button')].filter(button => button.textContent.trim() === BRIDGE_UI_COPY.removeFromBridge);
            assert(remove.length === 2 && remove.every(button => !button.disabled), `only the two canvas rows offer an enabled Remove (got ${remove.length})`);
            assert(window.document.body.textContent.includes('no longer where the job was released'), 'the missing-canvas sentence is visible');
            await bundle.module.act(async () => { remove[0].click(); await Promise.resolve(); await Promise.resolve(); });
            assert(JSON.stringify(calls) === JSON.stringify([['unrelease', { jobId: PROJECTS[0].jobId }]]),
              `Remove calls only the scoped unrelease IPC for that job (${JSON.stringify(calls)})`);
          } finally { await bundle.module.act(async () => rootNode.unmount()); }
          assert(entries.length === 0, `the panel renders without console output: ${entries.map(item => item.args.join(' ')).join(' | ')}`);
        }));
      } finally { controller.abort(); await bundle?.dispose(); await fsPromises.rm(directory, { recursive: true, force: true }); __resetHandoffBridgeStoreForTests(); __resetBridgeUiForTests(); }
    },
  },
];
