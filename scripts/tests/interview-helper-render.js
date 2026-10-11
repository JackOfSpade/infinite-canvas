import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { withConsoleCollector } from './fixtures/handoff-bridge/renderHarness.js';
import { withTimeout } from './fixtures/handoff-bridge/harness.js';
import { buildInterviewPlan } from '../../src/utils/interviewHelper.js';

const SNAPSHOT_A = 'a'.repeat(64);
const SNAPSHOT_B = 'b'.repeat(64);

function profile() {
  return {
    identity: { name: 'Ada Example', contacts: [], evidenceSegmentIds: ['segment-0001'] },
    roles: [{ id: 'role-acme', title: 'Product Manager', employer: 'Acme', startDate: '2021', endDate: 'Present', location: 'Toronto', achievementIds: ['achievement-onboarding'], skillIds: [], evidenceSegmentIds: ['segment-0002'] }],
    achievements: [{ id: 'achievement-onboarding', roleId: 'role-acme', claim: 'Improved onboarding conversion with a simpler setup flow.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0003'] }],
    projects: [{ id: 'project-dashboard', roleId: 'role-acme', name: 'Analytics Dashboard', description: 'Built an analytics dashboard for weekly retention reviews.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0004'] }],
    skills: [], education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
  };
}

function snapshot(id = SNAPSHOT_A) {
  return { snapshotId: id, profile: profile() };
}

function sourceNodes(id = SNAPSHOT_A) {
  return [{
    id: 'job-source', type: 'jobhub', position: { x: 0, y: 0 },
    data: { careerSnapshotId: id, activeTargetRole: 'Product Manager', searchLocation: { city: 'Toronto' } },
  }];
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

function text(window) {
  return window.document.body.textContent;
}

function button(window, label) {
  return [...window.document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
}

function setTextarea(window, textarea, value) {
  textarea.focus();
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  descriptor.set.call(textarea, value);
  textarea.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

function setInput(window, input, value) {
  input.focus();
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  descriptor.set.call(input, value);
  input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
}

const BUNDLE_ID = 'b'.repeat(64);
const BUNDLE_DIGEST = 'c'.repeat(64);
const BRIEF_RECORD_ID = 'f'.repeat(64);
const JOB_URL = 'https://jobs.example.test/role';
function publicBundle(artifactId = BUNDLE_ID, digest = BUNDLE_DIGEST) {
  return { bundle: { artifactId, displayName: 'Acme application', applicationArtifactDigest: digest, verification: { status: 'verified' } } };
}
function publicBrief() {
  return {
    version: 1, briefId: 'd'.repeat(64), createdAt: '2026-10-08T00:00:00.000Z',
    inputs: { careerSnapshotId: SNAPSHOT_A, jobUrlSha256: 'e'.repeat(64), applicationArtifactId: BUNDLE_ID, applicationArtifactDigest: BUNDLE_DIGEST },
    role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Owns product outcomes.' },
    roleThemes: ['Customer discovery'], companyFacts: [], recentContext: [], likelyQuestions: ['How do you prioritize?'], questionsToAsk: [],
    applicationPositioning: [{ documentKind: 'resume', point: 'Emphasizes delivery leadership.' }], sources: [], warnings: [],
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

const PROBE_SOURCE = (nodePath, contextPath) => `
  import React, { useCallback, useState } from 'react';
  import { ReactFlowProvider } from '@xyflow/react';
  import { InterviewHelperNode } from ${JSON.stringify(nodePath)};
  import { CanvasNavigationContext } from ${JSON.stringify(contextPath)};
  export function InterviewHelperProbe({ initialData, nodes, onPersist, nodeId = 'interview-helper' }) {
    const [data, setData] = useState(initialData);
    const update = useCallback((id, patch) => {
      setData(previous => {
        const next = { ...previous, ...patch };
        onPersist?.(patch, next);
        return next;
      });
      return true;
    }, [onPersist]);
    return <ReactFlowProvider initialNodes={nodes} initialWidth={1000} initialHeight={700}>
      <CanvasNavigationContext.Provider value={{ updateNodeDataGlobally: update }}>
        <InterviewHelperNode id={nodeId} data={data} />
      </CanvasNavigationContext.Provider>
    </ReactFlowProvider>;
  }
`;

const UNDO_PROBE_SOURCE = hookPath => `
  import React, { useState } from 'react';
  import { useUndoRedo } from ${JSON.stringify(hookPath)};
  export function UndoProbe({ initialNodes, onApi }) {
    const [nodes, setNodes] = useState(initialNodes);
    const [edges, setEdges] = useState([]);
    const [drawings, setDrawings] = useState([]);
    const api = useUndoRedo({ nodes, edges, drawings, setNodes, setEdges, setDrawings });
    onApi({ ...api, setNodes, nodes, setEdges, edges });
    return <div data-nodes={nodes.map(node => node.id).join(',')} />;
  }
`;

// Mounts the real useUndoRedo hook (UNDO_PROBE_SOURCE) in JSDOM and hands `fn` a
// small driver. Every step lets the isRestoringRef animation-frame window clear;
// `debounce()` additionally outwaits the hook's 500ms auto-snapshot.
async function withUndoHarness(fn) {
  return withDom(async window => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-undo-history-'));
    const entry = path.join(directory, 'UndoProbe.jsx');
    const controller = new AbortController();
    let bundle;
    let root = null;
    try {
      await fsPromises.writeFile(entry, UNDO_PROBE_SOURCE(path.resolve('src/hooks/useUndoRedo.js')));
      // EventLogger polls window.electronAPI.onSettingsChanged from module load
      // until it exists; provide it before bundling so no interval outlives this DOM.
      window.electronAPI = { cancelNodeTask() {}, onSettingsChanged: () => {} };
      bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
      let api;
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const step = async action => { await bundle.module.act(async () => { action(); await flush(); await sleep(40); await flush(); }); };
      const driver = {
        window,
        get api() { return api; },
        step,
        note: (id, extra = {}) => ({ id, type: 'note', position: { x: 0, y: 0 }, data: { text: id }, ...extra }),
        visible: () => api.nodes.map(node => node.id).join('') || '(empty)',
        flags: () => `canUndo=${api.canUndo} canRedo=${api.canRedo}`,
        // Outwait the 500ms auto-snapshot debounce (the way real edits are recorded).
        debounce: () => bundle.module.act(async () => { await sleep(650); }),
        // Fast edit: mutate, then record the new state explicitly.
        edit: async id => { await step(() => api.setNodes(previous => [...previous, driver.note(id)])); await step(() => api.takeSnapshot()); },
        // Canvas-style edit: snapshot BEFORE mutating, then let the debounce record the result.
        createLikeCanvas: async id => {
          await step(() => { api.takeSnapshot(); api.setNodes(previous => [...previous, driver.note(id)]); });
          await driver.debounce();
        },
        // The real keydown path (the hook listens on window).
        press: (key, shiftKey = false) => step(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key, metaKey: true, shiftKey, bubbles: true, cancelable: true }))),
        mount: async (initialNodes = []) => {
          if (root) await bundle.module.act(async () => root.unmount());
          root = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.UndoProbe, { initialNodes, onApi: next => { api = next; } })); await flush(); });
        },
        expect: (nodes, label, flags) => {
          const detail = `${label}: expected ${nodes}, got ${driver.visible()} (${driver.flags()})`;
          assert(driver.visible() === nodes, detail);
          if (flags) assert(driver.flags() === flags, `${label}: expected ${flags}, got ${driver.flags()} on ${driver.visible()}`);
        },
      };
      await driver.mount();
      try {
        return await fn(driver);
      } finally {
        if (root) await bundle.module.act(async () => root.unmount());
      }
    } finally {
      controller.abort();
      await bundle?.dispose();
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });
}

async function withBundledProbe(fn) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-helper-render-'));
  const entry = path.join(directory, 'InterviewHelperProbe.jsx');
  const controller = new AbortController();
  let bundle;
  try {
    await fsPromises.writeFile(entry, PROBE_SOURCE(path.resolve('src/nodes/InterviewHelperNode.jsx'), path.resolve('src/contexts/CanvasNavigationContext.jsx')));
    bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
    return await fn(bundle);
  } finally {
    controller.abort();
    await bundle?.dispose();
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

// React's controlled-input event plugin detects DOM support while its bundled
// module initializes. Build/import this particular probe after JSDOM is live
// so textarea input is exercised through the real React event path.
async function withDomBundledProbe(fn) {
  return withDom(async window => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-helper-render-dom-'));
    const entry = path.join(directory, 'InterviewHelperProbe.jsx');
    const controller = new AbortController();
    let bundle;
    try {
      await fsPromises.writeFile(entry, PROBE_SOURCE(path.resolve('src/nodes/InterviewHelperNode.jsx'), path.resolve('src/contexts/CanvasNavigationContext.jsx')));
      bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
      return await fn(bundle, window);
    } finally {
      controller.abort();
      await bundle?.dispose();
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });
}

async function mount(bundle, window, { initialData = {}, nodes = [], nodeId = 'interview-helper', onPersist = () => undefined } = {}) {
  const root = bundle.module.createRoot(window.document.getElementById('root'));
  await bundle.module.act(async () => {
    root.render(bundle.module.React.createElement(bundle.module.InterviewHelperProbe, { initialData, nodes, nodeId, onPersist }));
    await flush();
  });
  return root;
}

export default [
  {
    name: 'interview helper render: empty state requires an approved Job Search snapshot',
    async run() {
      await withDomBundledProbe(async (bundle, window) => withConsoleCollector(async entries => {
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: null }) };
        const root = await mount(bundle, window);
        try {
          assert(text(window).includes('Add a Job Search module with an approved career snapshot'), 'node must show the no-snapshot empty state');
          assert(!window.document.querySelector('[aria-label="Paste or type the interviewer question"]'), 'node must not offer retrieval without a source snapshot');
          assert(entries.length === 0, 'empty state must render silently');
        } finally {
          await bundle.module.act(async () => root.unmount());
        }
      }));
    },
  },
  {
    name: 'interview helper render: setup uses opaque bundle metadata, distinguishes cancellation, and fails closed without reload IPC',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        let pickerResult = { cancelled: true };
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          selectInterviewApplicationBundle: async () => pickerResult,
          loadInterviewApplicationBundle: async () => publicBundle(),
        };
        const root = await mount(bundle, window, { nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Choose application bundle').click(); await flush(); });
          assert(!text(window).includes('could not be read'), 'picker cancellation must remain quiet');
          pickerResult = publicBundle();
          await bundle.module.act(async () => { button(window, 'Choose application bundle').click(); await flush(); });
          const bundlePatch = updates.find(item => item.patch.interviewHelperApplicationBundle);
          assert(bundlePatch?.patch.interviewHelperApplicationBundle?.artifactId === BUNDLE_ID, 'picker must persist the opaque artifact id');
          assert(!JSON.stringify(bundlePatch.patch).includes('listingText') && !JSON.stringify(bundlePatch.patch).includes('Application.html'), 'bundle projection must never persist source text or paths');
          pickerResult = Promise.reject(new Error('read failed'));
          await bundle.module.act(async () => { button(window, 'Replace application bundle').click(); await flush(); });
          assert(text(window).includes('could not be read'), 'a picker/read failure must be visible and recoverable');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
      await withDomBundledProbe(async (bundle, window) => {
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
        const root = await mount(bundle, window, { initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('cannot be checked in this app version'), 'a persisted bundle must fail closed if reload IPC is unavailable');
          assert(button(window, 'Prepare interview brief').disabled, 'preparation must remain disabled without authoritative bundle reload');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: native career drop resolves via preload path API and persists only receipt metadata',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = []; let parseArgs; const pendingParse = deferred();
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          parseCareerData: async args => { parseArgs = args; return pendingParse.promise; },
          selectInterviewApplicationBundle: async () => publicBundle(),
          completeNonApiAiRun: async () => ({ cleared: true }),
        };
        const root = await mount(bundle, window, { onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          const target = window.document.querySelector('.border-dashed');
          const event = new window.Event('drop', { bubbles: true });
          Object.defineProperty(event, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          let bubbledToCanvas = false;
          const canvasDropListener = () => { bubbledToCanvas = true; };
          window.document.body.addEventListener('drop', canvasDropListener);
          await bundle.module.act(async () => { target.dispatchEvent(event); await flush(); });
          window.document.body.removeEventListener('drop', canvasDropListener);
          assert(parseArgs?.filePaths?.[0] === '/private/candidate/career.md', 'native drop must use getPathForFile through filesToDropPayloads');
          assert(!bubbledToCanvas, 'career-file drops must not bubble to the canvas document-drop handler');
          // A separate bundle picker must not cancel an in-flight career
          // compilation merely because both actions update setup state.
          await bundle.module.act(async () => { button(window, 'Choose application bundle').click(); await flush(); pendingParse.resolve({ success: true, careerSnapshotId: SNAPSHOT_A, fingerprint: 'fingerprint', profile: { identity: { name: 'Private Candidate' } }, careerData: 'raw private source' }); await flush(); });
          const persisted = JSON.stringify(updates.map(item => item.patch));
          assert(!persisted.includes('/private/candidate/career.md') && !persisted.includes('Private Candidate') && !persisted.includes('raw private source'), 'career import persistence must contain no path, profile, or raw source');
          assert(updates.some(item => item.patch.interviewHelperCareerFilenames?.[0] === 'career.md'), 'only a safe filename may be retained');
          assert(updates.some(item => item.patch.interviewHelperCareerCompilation?.status === 'approved'), 'an unrelated bundle picker must not discard the valid career compilation result');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: direct import clears a Job Search pin and can switch back',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          parseCareerData: async () => ({ success: true, careerSnapshotId: SNAPSHOT_B, fingerprint: 'independent-career' }),
          completeNonApiAiRun: async () => ({ cleared: true }),
          loadInterviewHelperCareerSnapshot: async ({ snapshotId: requested }) => ({ snapshot: snapshot(requested) }),
          loadInterviewApplicationBundle: async () => publicBundle(),
        };
        const root = await mount(bundle, window, {
          initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          const target = window.document.querySelector('.border-dashed');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          const importing = updates.find(item => item.patch.interviewHelperCareerMode === 'import');
          assert(importing?.patch.interviewHelperSourceNodeId === null && importing.patch.interviewHelperSourceSnapshotId === null, 'starting an independent import must clear the old Job Search source pin');
          const select = window.document.querySelector('[aria-label="Career source for Interview Helper"]');
          assert(select.value === '', 'the Job Search selector must not show a stale source while an independent import is active');
          assert(window.document.querySelector('[aria-label="Clear imported career source"]'), 'an approved direct import must provide an explicit accessible removal action');
          await bundle.module.act(async () => { window.document.querySelector('[aria-label="Clear imported career source"]').click(); await flush(); });
          assert(updates.some(item => item.patch.interviewHelperCareerMode === 'none'
            && item.patch.interviewHelperCareerCompilation === null
            && item.patch.interviewHelperCareerSnapshotId === null
            && item.patch.interviewHelperPreparation === null
            && item.patch.interviewHelperJobUrl === undefined
            && item.patch.interviewHelperApplicationBundle === undefined),
          'clearing an imported source must remove only import/dependent state while preserving URL and bundle setup');
          await bundle.module.act(async () => {
            select.value = 'job-source';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            await flush();
          });
          assert(updates.some(item => item.patch.interviewHelperCareerMode === 'job-search' && item.patch.interviewHelperSourceNodeId === 'job-source' && item.patch.interviewHelperSourceSnapshotId === SNAPSHOT_A), 'the selector must still permit explicitly switching back to Job Search');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: unsafe career filenames fail before parse IPC',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        let parseCalls = 0;
        window.electronAPI = {
          getPathForFile: file => `/private/candidate/${file.name}`,
          parseCareerData: async () => { parseCalls += 1; return { success: true, careerSnapshotId: SNAPSHOT_A, fingerprint: 'unused' }; },
        };
        const root = await mount(bundle, window);
        try {
          const target = window.document.querySelector('.border-dashed');
          for (const name of ['bad\u0001.md', 'bad\u007f.md', 'bad\u0085.md', 'bad\u202e.md']) {
            const drop = new window.Event('drop', { bubbles: true });
            Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name }] } });
            await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
            assert(text(window).includes('safe visible filename'), `unsafe filename ${JSON.stringify(name)} must produce a visible input error`);
          }
          assert(parseCalls === 0, 'a selection containing C0, DEL, C1, or Unicode format characters must not reach parse IPC');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: maximum-length node ids still create bounded career and preparation worker ids',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const nodeId = 'n'.repeat(160);
        const careerUpdates = []; let careerArgs;
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          parseCareerData: async args => { careerArgs = args; return { success: false, error: 'retryable' }; },
        };
        const careerRoot = await mount(bundle, window, { nodeId, onPersist: (patch, next) => careerUpdates.push({ patch, next }) });
        try {
          const target = window.document.querySelector('.border-dashed');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          const compiling = careerUpdates.find(item => item.patch.interviewHelperCareerCompilation?.status === 'compiling');
          assert(careerArgs?.nodeId === nodeId && careerArgs.manualAiRunId.length <= 160, 'career compilation must reach IPC with a bounded run id even for a 160-character node id');
          assert(compiling?.patch.interviewHelperCareerGeneration.length <= 160 && compiling.patch.interviewHelperCareerCompilation.manualAiRunId === careerArgs.manualAiRunId, 'career generation and receipt ids must not embed the oversized node id');
        } finally { await bundle.module.act(async () => careerRoot.unmount()); }

        let preparationArgs;
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async args => { preparationArgs = args; return { brief: publicBrief(), briefRecordId: BRIEF_RECORD_ID }; },
          completeNonApiAiRun: async () => ({ absent: true }),
        };
        const preparationRoot = await mount(bundle, window, { nodeId, initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => { setInput(window, url, JOB_URL); await flush(); button(window, 'Prepare interview brief').click(); await flush(); });
          assert(preparationArgs?.nodeId === nodeId && preparationArgs.manualAiRunId.length <= 160, 'preparation must reach IPC with a bounded run id even for a 160-character node id');
        } finally { await bundle.module.act(async () => preparationRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: preparation is fenced after URL invalidation and a valid public brief launches the narrow view',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred(); const updates = []; const launches = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => pending.promise,
          launchInterviewWindow: async args => { launches.push(args); },
        };
        const root = await mount(bundle, window, { initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => { setInput(window, url, JOB_URL); await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          await bundle.module.act(async () => { setInput(window, url, 'https://jobs.example.test/changed'); pending.resolve({ brief: publicBrief() }); await flush(); });
          assert(!updates.some(item => item.patch.interviewHelperPreparation?.briefId === publicBrief().briefId), 'a late preparation response must not resurrect a stale brief after URL invalidation');
          const binding = `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`;
          await bundle.module.act(async () => {
            // Inject an already validated public brief only through the probe's
            // normal persistence callback path, emulating a completed request.
            const replacement = updates.find(item => item.next.interviewHelperJobUrl === 'https://jobs.example.test/changed');
            assert(replacement, 'fixture must commit the changed URL');
          });
          // Relaunch coverage uses a fresh prepared mount below; this instance
          // specifically proves late async preparation cannot overwrite it.
          assert(launches.length === 0 && binding.includes(BUNDLE_ID), 'stale preparation must not make the launch path available');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
      await withDomBundledProbe(async (bundle, window) => {
        const launches = [];
        const ready = publicBrief();
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewApplicationBundle: async () => publicBundle(), loadInterviewPreparedBrief: async () => ({ brief: ready }), launchInterviewWindow: async args => { launches.push(args); } };
        const root = await mount(bundle, window, { initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST }, interviewHelperPreparation: ready, interviewHelperPreparationRecordId: BRIEF_RECORD_ID, interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}` }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          const launch = button(window, 'Launch interview view');
          assert(launch && !launch.disabled, 'a validated public brief plus reloaded bundle must enable launch');
          await bundle.module.act(async () => { launch.click(); await flush(); });
          assert(launches.length === 1 && launches[0].nodeId === 'interview-helper' && launches[0].snapshotId === SNAPSHOT_A && launches[0].jobUrl === JOB_URL && launches[0].brief.briefId === ready.briefId, 'launch must bind the narrow window to the current canonical job URL');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: cached briefs wait for main verification and never preview on failure',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred(); const ready = publicBrief();
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => pending.promise,
        };
        const root = await mount(bundle, window, { initialData: {
          interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A,
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: ready, interviewHelperPreparationRecordId: BRIEF_RECORD_ID,
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
        }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('Checking saved brief…') && button(window, 'Prepare interview brief')?.disabled && !button(window, 'Launch interview view'), 'cached brief content must remain hidden and preparation disabled while main verification is pending');
          await bundle.module.act(async () => { pending.resolve({ brief: null }); await flush(); });
          assert(text(window).includes('Saved brief could not be verified; prepare again.') && !text(window).includes('Ready · Product Manager') && !button(window, 'Launch interview view'), 'a missing/mismatched main record must not create a renderer preview or launch path');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: authoritative async snapshot loads a locked rail, supports navigation, and shows truthful no-fit',
    async run() {
      await withDomBundledProbe(async (bundle, window) => withConsoleCollector(async entries => {
        const pending = deferred();
        const updates = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: () => pending.promise };
        const root = await mount(bundle, window, { nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          assert(window.document.querySelector('[role="status"]')?.textContent.includes('Loading the pinned career snapshot'), 'source selection must visibly wait for its authoritative async snapshot');
          await bundle.module.act(async () => {
            pending.resolve({ snapshot: snapshot() });
            await flush();
          });
          const textarea = window.document.querySelector('[aria-label="Paste or type the interviewer question"]');
          assert(textarea && !textarea.disabled, 'authoritative snapshot completion must enable question input');
          assert(textarea.maxLength === 2000, 'canvas question entry must enforce the same 2,000-character boundary as the interview window');
          await bundle.module.act(async () => { setTextarea(window, textarea, `How did you improve onboarding conversion? ${'x'.repeat(2000)}`); await flush(); });
          assert(button(window, 'Find grounded evidence').disabled, 'an oversized canvas question must not create a rail the interview window would reject');
          assert(updates.some(item => item.patch.interviewHelperSourceSnapshotId === SNAPSHOT_A), 'sole source must be persisted with its exact immutable snapshot pin');

          const question = 'How did you improve onboarding conversion and build the analytics dashboard?';
          const expected = buildInterviewPlan({ question, profile: snapshot(), snapshotId: SNAPSHOT_A });
          assert(expected.status === 'supported' && expected.steps.length >= 2, 'fixture must produce a navigable grounded rail');
          await bundle.module.act(async () => { setTextarea(window, textarea, question); await flush(); });
          const find = button(window, 'Find grounded evidence');
          assert(find && !find.disabled, `supported question must enable retrieval (value=${textarea.value})`);
          await bundle.module.act(async () => { find.click(); await flush(); });
          const rail = window.document.querySelector('[aria-label="Locked interview answer rail"]');
          assert(rail, 'supported question must render a locked rail');
          assert(text(window).includes(expected.analysis.transcript), 'locked rail must render the extracted question');
          assert(text(window).includes('Role: Product Manager · Acme'), 'locked rail must show role attribution from the authoritative snapshot');
          const initialRailItems = [...rail.querySelectorAll('[aria-label="All grounded interview evidence"] > li')];
          const initialRailText = initialRailItems.map(item => item.textContent);
          assert(initialRailItems.length === expected.steps.length, 'complete stable rail must show every selected cue without a View all interaction');
          assert(initialRailText.every((item, index) => item.includes(expected.steps[index].cue)), 'visible rail must preserve every exact cue in finished plan order');
          assert(initialRailItems.filter(item => item.getAttribute('aria-current') === 'step').length === 1 && initialRailItems[0].getAttribute('aria-current') === 'step', 'first thought must be the sole accessible current rail item');
          assert(!button(window, 'View all'), 'complete rail must not hide future steps behind an obsolete toggle');
          const previous = window.document.querySelector('[aria-label="Previous interview thought"]');
          const next = window.document.querySelector('[aria-label="Next interview thought"]');
          assert(previous.disabled && !next.disabled, 'rail must expose disabled previous and enabled next controls at the first thought');
          await bundle.module.act(async () => { next.click(); await flush(); });
          const movedRailItems = [...rail.querySelectorAll('[aria-label="All grounded interview evidence"] > li')];
          assert(movedRailItems.map(item => item.textContent).join('\n') === initialRailText.join('\n'), 'previous/current/upcoming movement must not reorder or replace the fixed rail text');
          assert(movedRailItems.filter(item => item.getAttribute('aria-current') === 'step').length === 1 && movedRailItems[1].getAttribute('aria-current') === 'step', 'next control must move the accessible current marker without hiding any cue');

          await bundle.module.act(async () => { button(window, 'Next question').click(); await flush(); });
          const nextTextarea = window.document.querySelector('[aria-label="Paste or type the interviewer question"]');
          await bundle.module.act(async () => { setTextarea(window, nextTextarea, 'How do you negotiate a real-estate lease?'); await flush(); });
          await bundle.module.act(async () => { button(window, 'Find grounded evidence').click(); await flush(); });
          assert(text(window).includes('No matching example appears in saved career data'), 'unsupported question must display the truthful no-fit message');
          assert(!text(window).includes('closest real example'), 'unsupported state must not fabricate or suggest a weak saved match');
          assert(!window.document.querySelector('[aria-label="Locked interview answer rail"]'), 'unsupported question must not render a fabricated rail');
          assert(entries.length === 0, `async rail interaction must stay silent: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
        } finally {
          await bundle.module.act(async () => root.unmount());
        }
      }));
    },
  },
  {
    name: 'interview helper render: Job Search snapshot pins remain stable until explicitly refreshed',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const original = buildInterviewPlan({ question: 'How did you improve onboarding conversion?', profile: snapshot(), snapshotId: SNAPSHOT_A });
        assert(original.status === 'supported', 'fixture must provide a saved supported rail');
        const initialData = {
          interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A,
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: publicBrief(), interviewHelperPreparationRecordId: BRIEF_RECORD_ID,
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          interviewHelperLockedPlan: original, interviewHelperCurrentStep: 0,
        };
        const updates = []; const launches = []; const loadedSnapshotIds = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async ({ snapshotId: requested }) => { loadedSnapshotIds.push(requested); return { snapshot: snapshot(requested) }; },
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => ({ brief: publicBrief() }),
          launchInterviewWindow: async args => { launches.push(args); },
        };
        const root = await mount(bundle, window, { initialData, nodes: sourceNodes(SNAPSHOT_B), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(loadedSnapshotIds.includes(SNAPSHOT_A)
            && window.document.querySelector('[aria-label="Locked interview answer rail"]')
            && text(window).includes('newer approved snapshot')
            && !updates.some(item => item.patch.interviewHelperSourceSnapshotId === SNAPSHOT_B || item.patch.interviewHelperLockedPlan === null),
          'a newer Job Search snapshot must not silently replace the saved pin or clear prepared state');
          await bundle.module.act(async () => { button(window, 'Launch interview view').click(); await flush(); });
          assert(launches[0]?.snapshotId === SNAPSHOT_A && launches[0]?.plan?.snapshotId === SNAPSHOT_A, 'the launched interview view must use the same saved snapshot as the canvas rail');
          await bundle.module.act(async () => { window.document.querySelector('[aria-label="Use latest Job Search snapshot"]').click(); await flush(); });
          assert(updates.some(item => item.patch.interviewHelperSourceSnapshotId === SNAPSHOT_B
            && item.patch.interviewHelperPreparation === null
            && item.patch.interviewHelperLockedPlan === null),
          'the explicit latest-snapshot action must atomically repin and clear dependent preparation and rail state');
        } finally { await bundle.module.act(async () => root.unmount()); }

        const missingUpdates = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async ({ snapshotId: requested }) => ({ snapshot: snapshot(requested) }) };
        const missingRoot = await mount(bundle, window, { initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperLockedPlan: original, interviewHelperCurrentStep: 0 }, nodes: [], onPersist: (patch, next) => missingUpdates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('source is no longer on this canvas')
            && window.document.querySelector('[aria-label="Locked interview answer rail"]')
            && window.document.querySelector('[aria-label="Clear selected Job Search source"]')
            && !window.document.querySelector('[aria-label="Use latest Job Search snapshot"]')
            && !missingUpdates.some(item => item.patch.interviewHelperLockedPlan === null),
          'a missing source must retain its rail, offer clearing the saved pin, and not offer a dead latest-snapshot action');
        } finally { await bundle.module.act(async () => missingRoot.unmount()); }

        const noneLoads = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async ({ snapshotId: requested }) => { noneLoads.push(requested); return { snapshot: snapshot(requested) }; } };
        const noneRoot = await mount(bundle, window, {
          initialData: { interviewHelperCareerMode: 'none', interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperLockedPlan: original, interviewHelperCurrentStep: 0 },
          nodes: sourceNodes(),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(noneLoads.length === 0 && !window.document.querySelector('[aria-label="Locked interview answer rail"]'), 'an explicit no-source mode must ignore stale legacy source ids and never load their snapshot');
        } finally { await bundle.module.act(async () => noneRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: tampered persisted rail is rejected against canonical snapshot recomputation',
    async run() {
      await withBundledProbe(async bundle => withDom(async window => withConsoleCollector(async entries => {
        const canonical = buildInterviewPlan({ question: 'How did you improve onboarding conversion?', profile: snapshot(), snapshotId: SNAPSHOT_A });
        const tampered = structuredClone(canonical);
        tampered.steps[0].cue = 'Invented success metric that is absent from career data.';
        const updates = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
        const root = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperLockedPlan: tampered, interviewHelperCurrentStep: 0 },
          onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(!text(window).includes('Invented success metric'), 'tampered cue must never be displayed');
          assert(!window.document.querySelector('[aria-label="Locked interview answer rail"]'), 'tampered persisted plan must be rejected rather than rendered');
          assert(updates.some(item => item.patch.interviewHelperLockedPlan === null && item.patch.interviewHelperCurrentStep === 0), 'invalid plan must be cleared after authoritative recomputation');
          assert(entries.length === 0, 'tamper rejection render must stay silent');
        } finally {
          await bundle.module.act(async () => root.unmount());
        }
      })));
    },
  },
  {
    name: 'interview helper render: locked rails retain ordinary line breaks and disclose unsupported requested parts',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const newlineProfile = profile();
        newlineProfile.achievements[0].claim = 'Improved onboarding conversion\nwith a simpler setup flow.';
        const newlinePlan = buildInterviewPlan({ question: 'How did you improve onboarding conversion?', profile: newlineProfile, snapshotId: SNAPSHOT_A });
        assert(newlinePlan.status === 'supported' && newlinePlan.steps.some(step => step.cue.includes('\n')), 'fixture must create a canonical cue with an ordinary line break');
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: { snapshotId: SNAPSHOT_A, profile: newlineProfile } }) };
        const newlineRoot = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperLockedPlan: newlinePlan, interviewHelperCurrentStep: 0 },
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          const rail = window.document.querySelector('[aria-label="Locked interview answer rail"]');
          assert(rail && rail.textContent.includes('Improved onboarding conversion\nwith a simpler setup flow.'), 'canonical career cues with tabs or line breaks must remain renderable');
        } finally { await bundle.module.act(async () => newlineRoot.unmount()); }

        const warningPlan = buildInterviewPlan({ question: 'What decision did you make to improve onboarding and what did you learn?', profile: profile(), snapshotId: SNAPSHOT_A });
        assert(warningPlan.status === 'supported' && warningPlan.missingComponents.includes('decision') && warningPlan.missingComponents.includes('lesson'), 'fixture must contain documented missing requested components');
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
        const warningRoot = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperLockedPlan: warningPlan, interviewHelperCurrentStep: 0 },
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('Saved evidence does not document: decision/trade-off, lesson learned. Do not fill that gap from this rail.'), 'canvas rails must disclose missing decision/outcome/lesson evidence without invention');
        } finally { await bundle.module.act(async () => warningRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: setup controls safely revert or remove persisted choices',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const base = runId => ({
          interviewHelperCareerMode: 'job-search', interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A,
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: { status: 'failed', error: 'Retryable worker interruption.' },
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          interviewHelperPreparationRunId: runId,
        });
        const mountCase = async (runId, action) => {
          const updates = []; const completions = [];
          window.electronAPI = {
            loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
            loadInterviewApplicationBundle: async () => publicBundle(),
            completeNonApiAiRun: async id => { completions.push(id); return { cleared: true }; },
          };
          const root = await mount(bundle, window, { initialData: base(runId), nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
          try {
            await bundle.module.act(async () => { await flush(); });
            await action(updates, completions);
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        await mountCase('interview-helper:prepare:interview-helper:clear-url', async (updates, completions) => {
          await bundle.module.act(async () => { window.document.querySelector('[aria-label="Clear saved job listing URL"]').click(); await flush(); });
          assert(completions[0] === 'interview-helper:prepare:interview-helper:clear-url'
            && updates.some(item => item.patch.interviewHelperJobUrl === null && item.patch.interviewHelperPreparation === null),
          'clearing a URL must retire a settled preparation recovery before invalidating it');
        });
        await mountCase('interview-helper:prepare:interview-helper:remove-bundle', async (updates, completions) => {
          await bundle.module.act(async () => { window.document.querySelector('[aria-label="Remove selected application bundle"]').click(); await flush(); });
          assert(completions[0] === 'interview-helper:prepare:interview-helper:remove-bundle'
            && updates.some(item => item.patch.interviewHelperApplicationBundle === null && item.patch.interviewHelperPreparation === null),
          'removing a bundle must retire a settled preparation recovery before clearing its opaque reference');
        });
        await mountCase('interview-helper:prepare:interview-helper:clear-source', async (updates, completions) => {
          await bundle.module.act(async () => { window.document.querySelector('[aria-label="Clear selected Job Search source"]').click(); await flush(); });
          assert(completions[0] === 'interview-helper:prepare:interview-helper:clear-source'
            && updates.some(item => item.patch.interviewHelperCareerMode === 'none' && item.patch.interviewHelperSourceNodeId === null && item.patch.interviewHelperSourceSnapshotId === null && item.patch.interviewHelperPreparation === null),
          'clearing a Job Search source must retire the preparation recovery and persist an explicit no-source state');
        });

        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }), loadInterviewApplicationBundle: async () => publicBundle() };
        const updates = [];
        const revertRoot = await mount(bundle, window, { initialData: base('interview-helper:prepare:interview-helper:revert'), nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          url.focus();
          const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          descriptor.set.call(url, 'https://jobs.example.test/draft');
          await bundle.module.act(async () => { url.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'draft' })); await flush(); button(window, 'Revert edit').click(); await flush(); });
          assert(url.value === JOB_URL && !updates.some(item => item.patch.interviewHelperJobUrl === 'https://jobs.example.test/draft'), 'reverting an unsaved URL edit must restore the persisted value without replacing it');
        } finally { await bundle.module.act(async () => revertRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: preparation exceptions persist only a generic recovery error',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = []; const rawError = 'provider rejected /private/candidate/resume.pdf';
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => { throw new Error(rawError); },
        };
        const root = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => { setInput(window, url, JOB_URL); await flush(); button(window, 'Prepare interview brief').click(); await flush(); });
          const failure = updates.find(item => item.patch.interviewHelperPreparation?.status === 'failed');
          assert(failure?.patch.interviewHelperPreparation?.error === 'Preparation did not complete. Resume or change setup to try again.'
            && !JSON.stringify(failure?.patch).includes(rawError)
            && text(window).includes('Preparation did not complete. Resume or change setup to try again.')
            && !text(window).includes(rawError),
          'provider exception details must not enter canvas persistence or the rendered recovery message');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: hostile persisted setup display text is never rendered raw',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const hostileLabel = 'Unsafe\u202E bundle';
        const hostileFilename = 'career\u202E.md';
        const hostileError = 'Provider failure at /private/candidate/resume.pdf';
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
        const root = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'approved-generation',
            interviewHelperCareerSnapshotId: SNAPSHOT_A,
            interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A },
            interviewHelperCareerFilenames: ['career.md', hostileFilename],
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: hostileLabel, digest: BUNDLE_DIGEST, integritySummary: 'Verified\u202E status' },
            interviewHelperPreparation: { status: 'failed', error: hostileError },
          },
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('Independent career snapshot ready · career.md')
            && !text(window).includes(hostileFilename)
            && text(window).includes('Selected application bundle')
            && !text(window).includes(hostileLabel)
            && !text(window).includes('Verified\u202E status')
            && text(window).includes('Preparation did not complete. Resume or change setup to try again.')
            && !text(window).includes(hostileError),
          'untrusted persisted filenames, bundle metadata, and failures must be filtered or replaced before rendering');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: malformed, deep, extra, and cyclic persisted rails are cleared without rendering',
    async run() {
      const canonical = buildInterviewPlan({ question: 'How did you improve onboarding conversion?', profile: snapshot(), snapshotId: SNAPSHOT_A });
      const malformed = { status: 'supported', snapshotId: SNAPSHOT_A, steps: [{}] };
      const extra = { ...structuredClone(canonical), unrecognizedPayload: { rawProfile: profile() } };
      const deep = { ...structuredClone(canonical), unrecognizedPayload: {} };
      let cursor = deep.unrecognizedPayload;
      for (let index = 0; index < 20_000; index += 1) { cursor.child = {}; cursor = cursor.child; }
      const cyclic = structuredClone(canonical);
      cyclic.analysis = cyclic;
      for (const [name, lockedPlan] of [['malformed', malformed], ['extra', extra], ['deep', deep], ['cyclic', cyclic]]) {
        await withDomBundledProbe(async (bundle, window) => withConsoleCollector(async entries => {
          const updates = [];
          window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
          const root = await mount(bundle, window, {
            nodes: sourceNodes(),
            initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperLockedPlan: lockedPlan, interviewHelperCurrentStep: 0 },
            onPersist: (patch, next) => updates.push({ patch, next }),
          });
          try {
            await bundle.module.act(async () => { await flush(); });
            assert(!window.document.querySelector('[aria-label="Locked interview answer rail"]'), `${name} plan must never render`);
            assert(updates.some(item => item.patch.interviewHelperLockedPlan === null && item.patch.interviewHelperCurrentStep === 0), `${name} plan must be cleared without canonicalizing hostile nested state`);
            assert(entries.length === 0, `${name} plan rejection must stay silent`);
          } finally { await bundle.module.act(async () => root.unmount()); }
        }));
      }
    },
  },
  {
    name: 'interview helper render: a stale terminal response is retired once, and failed cleanup remains retryable',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred();
        const updates = [];
        const completions = [];
        let cleanupOutcome = 'fail';
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => pending.promise,
          completeNonApiAiRun: async runId => {
            completions.push(runId);
            if (cleanupOutcome === 'fail') throw new Error('offline');
            if (cleanupOutcome === 'invalid') return { cleared: false };
            return { cleared: true };
          },
        };
        const root = await mount(bundle, window, { initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
        try {
          await bundle.module.act(async () => { await flush(); });
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => { setInput(window, url, JOB_URL); await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          await bundle.module.act(async () => { setInput(window, url, 'https://jobs.example.test/changed'); await flush(); });
          assert(completions.length === 0, 'input invalidation must not retire an in-flight manual worker before its response is terminal');
          await bundle.module.act(async () => { pending.resolve({ brief: publicBrief() }); await flush(); });
          assert(completions.length === 1, 'a terminal stale response must be retired exactly once');
          const failedReceipt = updates.find(item => item.patch.interviewHelperManualAiCleanup?.status === 'failed');
          assert(failedReceipt?.patch.interviewHelperManualAiCleanup?.kind === 'preparation', 'a failed terminal cleanup must persist an exact preparation receipt');
          assert(button(window, 'Prepare interview brief').disabled, 'a pending cleanup must block a new manual worker operation');
          cleanupOutcome = 'invalid';
          await bundle.module.act(async () => { button(window, 'Retry manual-AI cleanup').click(); await flush(); });
          assert(!updates.some(item => item.patch.interviewHelperManualAiCleanup === null), 'an unacknowledged cleanup retry must retain its receipt');
          cleanupOutcome = 'success';
          await bundle.module.act(async () => { button(window, 'Retry manual-AI cleanup').click(); await flush(); });
          assert(completions.length === 3 && updates.some(item => item.patch.interviewHelperManualAiCleanup === null), 'only an authoritative cleared response may remove the cleanup receipt');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: reload lets terminal cleanup retry despite persisted active receipts',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const cases = [
          ['career', 'interview-helper:compile:interview-helper:reload', {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', manualAiRunId: 'interview-helper:compile:interview-helper:reload' },
          }],
          ['preparation', 'interview-helper:prepare:interview-helper:reload', {
            interviewHelperPreparation: { status: 'preparing' },
            interviewHelperPreparationRunId: 'interview-helper:prepare:interview-helper:reload',
          }],
        ];
        for (const [kind, runId, receipt] of cases) {
          const updates = []; const completions = [];
          window.electronAPI = {
            completeNonApiAiRun: async completedRunId => { completions.push(completedRunId); return { cleared: true }; },
          };
          const root = await mount(bundle, window, {
            initialData: {
              ...receipt,
              interviewHelperManualAiCleanup: { version: 1, kind, runId, status: 'failed' },
            },
            onPersist: (patch, next) => updates.push({ patch, next }),
          });
          try {
            await bundle.module.act(async () => { await flush(); });
            const retry = button(window, 'Retry manual-AI cleanup');
            assert(retry && !retry.disabled, `reloaded ${kind} receipt must not masquerade as a live worker`);
            await bundle.module.act(async () => { retry.click(); await flush(); });
            assert(completions.length === 1 && completions[0] === runId, `reloaded ${kind} cleanup must retire its exact run`);
            assert(updates.some(item => item.patch.interviewHelperManualAiCleanup === null), `reloaded ${kind} cleanup receipt must clear after confirmation`);
          } finally { await bundle.module.act(async () => root.unmount()); }
        }
      });
    },
  },
  {
    name: 'interview helper render: restored deletion receipts block work and retry exact ids atomically',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const receipt = (runId, cancellationPending = true) => ({
          runId,
          retirementPending: true,
          retirementReason: 'node-deleted',
          cancellationPending,
          cancellationReason: 'node-deleted',
        });
        const careerRunId = 'interview-helper:compile:interview-helper:restored-career';
        const preparationRunId = 'interview-helper:prepare:interview-helper:restored-preparation';
        const markerRunId = 'interview-helper:prepare:interview-helper:restored-marker';
        const acknowledgedRunId = 'interview-helper:prepare:interview-helper:restored-ack';
        const hostileReceipt = Object.assign(Object.create({ inheritedPayload: 'must-not-survive' }), receipt('interview-helper:prepare:interview-helper:inherited'));
        const expectedRunIds = new Set([careerRunId, preparationRunId, markerRunId, acknowledgedRunId]);
        const updates = [];
        const cancellationCalls = [];
        const completionBatches = [];
        let completionFails = true;
        window.electronAPI = {
          cancelNodeTaskAndWait: async (nodeId, reason) => {
            cancellationCalls.push({ nodeId, reason });
            return { settled: true, manualAiRunIds: [acknowledgedRunId, acknowledgedRunId, 'not a valid run id'] };
          },
          completeNonApiAiRuns: async runIds => {
            completionBatches.push([...runIds]);
            if (completionFails) throw new Error('retirement unavailable');
            return { completed: true, clearedRunIds: [...runIds], absentRunIds: [] };
          },
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'job-search',
            interviewHelperSourceNodeId: 'job-source',
            interviewHelperSourceSnapshotId: SNAPSHOT_A,
            interviewHelperCareerGeneration: 'restored-career-generation',
            interviewHelperCareerCompilation: { version: 1, status: 'failed', manualAiRunId: careerRunId },
            interviewHelperPreparation: { status: 'failed', error: 'Saved worker interruption.' },
            interviewHelperPreparationRunId: preparationRunId,
            interviewHelperManualAiCleanup: { version: 1, kind: 'preparation', runId: markerRunId, status: 'failed' },
            interviewHelperManualAiRetirementReceipts: [
              receipt(careerRunId), receipt(preparationRunId), receipt(markerRunId), receipt(careerRunId, false),
              receipt('not a valid run id'), { ...receipt('interview-helper:prepare:interview-helper:extra'), unexpectedPayload: 'must-not-survive' },
              hostileReceipt, { runId: 'interview-helper:prepare:unfenced' },
            ],
          },
          nodes: sourceNodes(),
          onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes('A restored deletion cleanup is still pending')
            && button(window, 'Resume preparation').disabled
            && button(window, 'choose canvas files').disabled,
          'only strictly valid restored deletion receipts must block new career and preparation work with an explicit recovery alert');

          await bundle.module.act(async () => { button(window, 'Retry restored cleanup').click(); await flush(); });
          const retainedAfterFailure = updates.at(-1)?.patch.interviewHelperManualAiRetirementReceipts;
          assert(cancellationCalls.length === 1
            && cancellationCalls[0].nodeId === 'interview-helper'
            && cancellationCalls[0].reason === 'cleanup-retry'
            && completionBatches[0].length === expectedRunIds.size
            && completionBatches[0].every(runId => expectedRunIds.has(runId))
            && retainedAfterFailure?.length === expectedRunIds.size
            && retainedAfterFailure.every(item => expectedRunIds.has(item.runId) && item.cancellationPending === false && !Object.hasOwn(item, 'unexpectedPayload') && !Object.hasOwn(item, 'inheritedPayload')),
          'a failed atomic retirement must retain only allowlisted deduped receipts for another explicit retry');

          completionFails = false;
          await bundle.module.act(async () => { button(window, 'Retry restored cleanup').click(); await flush(); });
          const cleared = updates.at(-1);
          assert(cancellationCalls.length === 2
            && completionBatches[1].length === expectedRunIds.size
            && completionBatches[1].every(runId => expectedRunIds.has(runId))
            && cleared.patch.interviewHelperManualAiRetirementReceipts === null
            && cleared.patch.interviewHelperCareerCompilation === null
            && cleared.patch.interviewHelperPreparation === null
            && cleared.patch.interviewHelperPreparationRunId === null
            && cleared.patch.interviewHelperManualAiCleanup === null,
          'only a fully acknowledged atomic retirement may clear its receipts and matching resumable worker state');
        } finally { await bundle.module.act(async () => root.unmount()); }

        const preservedUpdates = [];
        const completedBrief = publicBrief();
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          cancelNodeTaskAndWait: async () => ({ settled: true, manualAiRunIds: [] }),
          completeNonApiAiRuns: async runIds => ({ completed: true, clearedRunIds: [...runIds], absentRunIds: [] }),
        };
        const preservedRoot = await mount(bundle, window, {
          nodes: sourceNodes(),
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'approved-generation',
            interviewHelperCareerSnapshotId: SNAPSHOT_A,
            interviewHelperCareerCompilation: { version: 1, status: 'approved', generation: 'approved-generation', careerSnapshotId: SNAPSHOT_A, manualAiRunId: 'interview-helper:compile:approved' },
            interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperPreparation: completedBrief,
            interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
            interviewHelperManualAiCleanup: { version: 1, kind: 'preparation', runId: markerRunId, status: 'failed' },
            interviewHelperManualAiRetirementReceipts: [receipt(markerRunId)],
          },
          onPersist: (patch, next) => preservedUpdates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); button(window, 'Retry restored cleanup').click(); await flush(); });
          const cleared = preservedUpdates.at(-1);
          assert(cleared.patch.interviewHelperManualAiRetirementReceipts === null
            && cleared.patch.interviewHelperManualAiCleanup === null
            && cleared.next.interviewHelperCareerCompilation?.status === 'approved'
            && cleared.next.interviewHelperCareerSnapshotId === SNAPSHOT_A
            && cleared.next.interviewHelperPreparation?.briefId === completedBrief.briefId,
          'retiring a separate cleanup receipt must preserve approved snapshots and completed preparation briefs');
        } finally { await bundle.module.act(async () => preservedRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: stale rejected workers retire while current failures remain resumable',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const careerPending = deferred(); const careerCompletions = [];
        window.electronAPI = {
          getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          parseCareerData: async () => careerPending.promise,
          completeNonApiAiRun: async runId => { careerCompletions.push(runId); return { cleared: true }; },
        };
        const alternateSource = { ...sourceNodes(SNAPSHOT_B)[0], id: 'job-source-2' };
        const careerRoot = await mount(bundle, window, { nodes: [...sourceNodes(), alternateSource] });
        try {
          const target = window.document.querySelector('.border-dashed');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          const source = window.document.querySelector('[aria-label="Career source for Interview Helper"]');
          await bundle.module.act(async () => {
            source.value = 'job-source-2';
            source.dispatchEvent(new window.Event('change', { bubbles: true }));
            await flush();
            assert(careerCompletions.length === 0, 'switching away must not retire a genuinely local compiling worker before it settles');
            careerPending.reject(new Error('terminal compilation rejection'));
            await flush();
          });
          assert(careerCompletions.length === 1 && careerCompletions[0].startsWith('interview-helper:compile:'), 'a stale rejected compilation must retire its exact worker run');
        } finally { await bundle.module.act(async () => careerRoot.unmount()); }

        const stalePending = deferred(); const staleCompletions = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => stalePending.promise,
          completeNonApiAiRun: async runId => { staleCompletions.push(runId); return { cleared: true }; },
        };
        const staleRoot = await mount(bundle, window, { initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => { setInput(window, url, JOB_URL); await flush(); button(window, 'Prepare interview brief').click(); await flush(); });
          await bundle.module.act(async () => {
            setInput(window, url, 'https://jobs.example.test/changed');
            assert(staleCompletions.length === 0, 'changing input must not retire a genuinely local preparing worker before it settles');
            stalePending.reject(new Error('terminal preparation rejection'));
            await flush();
          });
          assert(staleCompletions.length === 1 && staleCompletions[0].startsWith('interview-helper:prepare:'), 'a stale rejected preparation must retire its exact worker run');
        } finally { await bundle.module.act(async () => staleRoot.unmount()); }

        const currentPending = deferred(); const currentCompletions = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async () => currentPending.promise,
          completeNonApiAiRun: async runId => { currentCompletions.push(runId); return { cleared: true }; },
        };
        const currentRoot = await mount(bundle, window, { initialData: { interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } }, nodes: sourceNodes() });
        try {
          await bundle.module.act(async () => { await flush(); });
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => { setInput(window, url, JOB_URL); await flush(); button(window, 'Prepare interview brief').click(); currentPending.reject(new Error('retryable preparation rejection')); await flush(); });
          assert(currentCompletions.length === 0, 'a current rejected preparation must retain its resumable worker identity');
          assert(button(window, 'Resume preparation') && !button(window, 'Resume preparation').disabled, 'a current rejected preparation must remain resumable');
        } finally { await bundle.module.act(async () => currentRoot.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: changing inputs retires settled recovery runs before clearing them',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const careerRunId = 'interview-helper:compile:interview-helper:failed-career';
        const careerUpdates = []; const careerCompletions = [];
        window.electronAPI = {
          completeNonApiAiRun: async runId => { careerCompletions.push(runId); return { cleared: true }; },
        };
        const careerRoot = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'interview-helper:interview-helper:failed-career',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', manualAiRunId: careerRunId },
            interviewHelperCareerFilenames: ['original-career.md'],
          },
          nodes: sourceNodes(), onPersist: (patch, next) => careerUpdates.push({ patch, next }),
        });
        try {
          const source = window.document.querySelector('[aria-label="Career source for Interview Helper"]');
          await bundle.module.act(async () => {
            source.value = 'job-source';
            source.dispatchEvent(new window.Event('change', { bubbles: true }));
            await flush();
          });
          assert(careerCompletions.length === 1 && careerCompletions[0] === careerRunId, 'switching from a failed career import must retire its resumable worker');
          assert(careerUpdates.some(item => item.patch.interviewHelperCareerMode === 'job-search' && item.patch.interviewHelperCareerCompilation === null && Array.isArray(item.patch.interviewHelperCareerFilenames) && item.patch.interviewHelperCareerFilenames.length === 0), 'switching sources must clear the retired career receipt so later imports are not filename-blocked');
        } finally { await bundle.module.act(async () => careerRoot.unmount()); }

        const discardRunId = 'interview-helper:compile:interview-helper:discard';
        const discardUpdates = []; const discardCompletions = [];
        window.electronAPI = {
          getPathForFile: file => file.name === 'different-career.md' ? '/private/candidate/different-career.md' : '',
          parseCareerData: async () => ({ success: false }),
          completeNonApiAiRun: async runId => { discardCompletions.push(runId); return { cleared: true }; },
        };
        const discardRoot = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import',
            interviewHelperCareerGeneration: 'interview-helper:interview-helper:discard',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', generation: 'interview-helper:interview-helper:discard', manualAiRunId: discardRunId },
            interviewHelperCareerFilenames: ['original-career.md'],
          },
          onPersist: (patch, next) => discardUpdates.push({ patch, next }),
        });
        try {
          const target = window.document.querySelector('.border-dashed');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'different-career.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          assert(button(window, 'Discard previous career recovery'), 'different files must expose an explicit safe abandon path for a reloaded recovery');
          await bundle.module.act(async () => { button(window, 'Discard previous career recovery').click(); await flush(); });
          assert(discardCompletions.length === 1 && discardCompletions[0] === discardRunId, 'discarding a reloaded compilation must retire its exact worker');
          assert(discardUpdates.some(item => item.patch.interviewHelperCareerCompilation === null), 'discarding a retired compilation must remove the filename-binding receipt');
          assert(text(window).includes('Choose or drop the new career files'), 'successful discard must tell the user how to start the replacement import');
        } finally { await bundle.module.act(async () => discardRoot.unmount()); }

        const failedPrep = (suffix, status = 'failed') => ({
          interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A,
          interviewHelperJobUrl: JOB_URL,
          interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          interviewHelperPreparation: { status, error: 'Retryable worker interruption.' },
          interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          interviewHelperPreparationRunId: `interview-helper:prepare:interview-helper:${suffix}`,
        });
        const runAbandonmentCase = async ({ suffix, status, picked = publicBundle(), action, assertion }) => {
          const completions = []; const updates = [];
          window.electronAPI = {
            loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
            loadInterviewApplicationBundle: async () => publicBundle(),
            selectInterviewApplicationBundle: async () => picked,
            getPathForFile: file => file.name === 'career.md' ? '/private/candidate/career.md' : '',
            parseCareerData: async () => ({ success: false, error: 'new career run is separately resumable' }),
            completeNonApiAiRun: async runId => { completions.push(runId); return { cleared: true }; },
          };
          const root = await mount(bundle, window, { initialData: failedPrep(suffix, status), nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }) });
          try {
            await bundle.module.act(async () => { await flush(); });
            await action();
            assert(completions[0] === `interview-helper:prepare:interview-helper:${suffix}`, `${suffix} change must retire the abandoned preparation run`);
            assertion(updates);
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        await runAbandonmentCase({
          suffix: 'url',
          status: 'preparing',
          action: async () => {
            const url = window.document.querySelector('[aria-label="Original job listing URL"]');
            await bundle.module.act(async () => { setInput(window, url, 'https://jobs.example.test/changed'); await flush(); });
          },
          assertion: updates => assert(updates.some(item => item.patch.interviewHelperJobUrl === 'https://jobs.example.test/changed' && item.patch.interviewHelperPreparation === null), 'URL replacement must clear preparation only after retirement'),
        });
        await runAbandonmentCase({
          suffix: 'bundle',
          picked: publicBundle('9'.repeat(64), '8'.repeat(64)),
          action: async () => {
            await bundle.module.act(async () => { button(window, 'Replace application bundle').click(); await flush(); });
          },
          assertion: updates => assert(updates.some(item => item.patch.interviewHelperApplicationBundle?.artifactId === '9'.repeat(64) && item.patch.interviewHelperPreparation === null), 'bundle replacement must clear preparation only after retirement'),
        });
        await runAbandonmentCase({
          suffix: 'career',
          action: async () => {
            const target = window.document.querySelector('.border-dashed');
            const drop = new window.Event('drop', { bubbles: true });
            Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'career.md' }] } });
            await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); });
          },
          assertion: updates => assert(updates.some(item => item.patch.interviewHelperCareerMode === 'import' && item.patch.interviewHelperPreparation === null), 'starting a career import must retire and clear the abandoned preparation run first'),
        });
      });
    },
  },
  {
    name: 'interview helper render: reload preserves a resumable preparation run',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        let prepareArgs;
        const runId = 'interview-helper:prepare:interview-helper:resume';
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          prepareInterviewBrief: async args => { prepareArgs = args; return { brief: publicBrief(), briefRecordId: BRIEF_RECORD_ID }; },
          completeNonApiAiRun: async () => ({ absent: true }),
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A,
            interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperPreparation: { status: 'failed', error: 'Retryable worker interruption.' },
            interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
            interviewHelperPreparationRunId: runId,
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(button(window, 'Resume preparation') && !button(window, 'Resume preparation').disabled, 'a persisted failed preparation must survive reload as an explicit resume action');
          assert(!updates.some(item => item.patch.interviewHelperPreparation === null), 'reload must not erase a valid resumable preparation receipt');
          await bundle.module.act(async () => { button(window, 'Resume preparation').click(); await flush(); });
          assert(prepareArgs?.manualAiRunId === runId, 'resume must retain the original manual worker identity');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: URL and bundle changes preserve the independent career rail',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        const rail = buildInterviewPlan({ question: 'How did you improve onboarding conversion?', profile: profile(), snapshotId: SNAPSHOT_A });
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          selectInterviewApplicationBundle: async () => publicBundle(),
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A,
            interviewHelperJobUrl: 'https://jobs.example.test/original',
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperLockedPlan: rail, interviewHelperCurrentStep: 0,
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(window.document.querySelector('[aria-label="Locked interview answer rail"]'), 'fixture must render the independent career rail before setup changes');
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => { setInput(window, url, JOB_URL); await flush(); button(window, 'Replace application bundle').click(); await flush(); });
          assert(window.document.querySelector('[aria-label="Locked interview answer rail"]'), 'unrelated URL and bundle setup changes must not clear the saved career rail');
          assert(!updates.some(item => item.patch.interviewHelperLockedPlan === null), 'URL/bundle updates must clear only preparation state, never career evidence');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: canonical-order rail disclosure remains visible',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const rail = buildInterviewPlan({ question: 'Tell me about yourself.', profile: profile(), snapshotId: SNAPSHOT_A });
        assert(rail.status === 'supported' && rail.message, 'fixture must create the canonical-order disclosure rail');
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }) };
        const root = await mount(bundle, window, {
          initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperLockedPlan: rail, interviewHelperCurrentStep: 0 },
          nodes: sourceNodes(),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          assert(text(window).includes(rail.message), 'a canvas rail must show the no-unsaved-ranking disclosure attached to its canonical plan');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: an uncommitted URL draft does not discard a completed brief for unchanged saved inputs',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const pending = deferred(); const updates = []; const completions = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => ({ brief: publicBrief() }),
          prepareInterviewBrief: async () => pending.promise,
          completeNonApiAiRun: async runId => { completions.push(runId); return { cleared: true }; },
        };
        const root = await mount(bundle, window, {
          initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperJobUrl: JOB_URL, interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST } },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          const url = window.document.querySelector('[aria-label="Original job listing URL"]');
          await bundle.module.act(async () => {
            // A draft edit only: no focusout/commit while the worker finishes.
            const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            descriptor.set.call(url, `${JOB_URL}x`);
            url.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
            await flush();
          });
          await bundle.module.act(async () => { pending.resolve({ brief: publicBrief(), briefRecordId: BRIEF_RECORD_ID }); await flush(); await flush(); });
          await bundle.module.act(async () => { button(window, 'Revert edit').click(); await flush(); await flush(); });
          assert(updates.some(item => item.patch.interviewHelperPreparation?.briefId === publicBrief().briefId), 'a brief for unchanged committed inputs must persist even while a URL draft is dirty');
          const final = updates.at(-1).next;
          assert(final.interviewHelperPreparationRunId == null && final.interviewHelperPreparation?.status !== 'preparing', 'the node must not keep a preparing receipt for a retired run');
          assert(completions.length === 1 && !button(window, 'Resume preparation'), 'the run is retired once, after its brief was saved');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a failed bundle reload keeps a durable preparation recovery until it is retired',
    async run() {
      const runId = 'interview-helper:prepare:interview-helper:bundle-reload';
      for (const [variant, loader] of [
        ['rejected', async () => { throw new Error('io'); }],
        ['missing', async () => ({ bundle: null })],
      ]) {
        for (const status of ['failed', 'preparing']) {
          await withDomBundledProbe(async (bundle, window) => {
            const updates = []; const completions = [];
            window.electronAPI = {
              loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
              loadInterviewApplicationBundle: loader,
              completeNonApiAiRun: async id => { completions.push(id); return { cleared: true }; },
            };
            const root = await mount(bundle, window, {
              initialData: {
                interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperJobUrl: JOB_URL,
                interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
                interviewHelperPreparation: status === 'failed' ? { status, error: 'Retryable worker interruption.' } : { status },
                interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
                interviewHelperPreparationRunId: runId,
              },
              nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
            });
            try {
              await bundle.module.act(async () => { await flush(); await flush(); });
              assert(!updates.some(item => item.patch.interviewHelperPreparationRunId === null), `${variant}/${status}: a failed bundle reload must not drop a durable preparation run without retiring it`);
              assert(text(window).includes('The selected application bundle is unavailable'), `${variant}/${status}: the bundle error must be visible`);
              const resume = button(window, 'Resume preparation');
              assert(!resume || resume.disabled, `${variant}/${status}: preparation must stay disabled while the bundle is unverified`);
              await bundle.module.act(async () => { window.document.querySelector('[aria-label="Remove selected application bundle"]').click(); await flush(); await flush(); });
              assert(completions.includes(runId), `${variant}/${status}: removing the bundle must retire the recovery run`);
              assert(updates.some(item => item.patch.interviewHelperApplicationBundle === null && item.patch.interviewHelperPreparationRunId === null), `${variant}/${status}: the recovery is cleared only after retirement`);
            } finally { await bundle.module.act(async () => root.unmount()); }
          });
        }
      }
    },
  },
  {
    name: 'interview helper render: a rail its own verifier would reject is never persisted and is explained',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const formatted = snapshot();
        formatted.profile.achievements[0].claim = `Improved onboarding conversion with a simpler set${String.fromCodePoint(0xAD)}up flow.`;
        const updates = [];
        window.electronAPI = { loadInterviewHelperCareerSnapshot: async () => ({ snapshot: formatted }) };
        const root = await mount(bundle, window, {
          initialData: { interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          const textarea = window.document.querySelector('[aria-label="Paste or type the interviewer question"]');
          await bundle.module.act(async () => { setTextarea(window, textarea, 'How did you improve onboarding conversion?'); await flush(); });
          await bundle.module.act(async () => { button(window, 'Find grounded evidence').click(); await flush(); await flush(); });
          assert(!updates.some(item => item.patch.interviewHelperLockedPlan), 'an unverifiable rail must not be persisted and then silently erased');
          const status = [...window.document.querySelectorAll('[role="status"]')].map(item => item.textContent).join(' ');
          assert(/cannot display safely/u.test(status), 'the user must be told why no rail appeared');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: a locked-rail launch refusal is explained while other launch failures stay generic',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        let rejection = new Error("Error invoking remote method 'interview-window:launch': Error: Another Interview Helper on this canvas has an active interview rail.");
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => ({ brief: publicBrief() }),
          launchInterviewWindow: async () => { throw rejection; },
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A,
            interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperPreparation: publicBrief(), interviewHelperPreparationRecordId: BRIEF_RECORD_ID,
            interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          },
          nodes: sourceNodes(),
        });
        try {
          await bundle.module.act(async () => { await flush(); });
          const launchButton = button(window, 'Launch interview view');
          assert(launchButton && !launchButton.disabled, 'fixture must render an enabled launch action');
          const alert = () => [...window.document.querySelectorAll('[role="alert"]')].map(item => item.textContent).join(' ');
          await bundle.module.act(async () => { launchButton.click(); await flush(); await flush(); });
          assert(/Another Interview Helper on this canvas has an active interview rail/u.test(alert()), `the locked-rail refusal must be repeated to the user, got: ${alert()}`);
          rejection = new Error("Error invoking remote method 'interview-window:launch': Error: open /Users/someone/Library/Application Support/private.json: EACCES");
          await bundle.module.act(async () => { button(window, 'Launch interview view').click(); await flush(); await flush(); });
          assert(/could not be opened/u.test(alert()) && !/EACCES|Library|Another Interview Helper/u.test(alert()), `other launch failures must stay generic and never echo paths, got: ${alert()}`);
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: undoing a helper creation or redoing its deletion retires the companion window like a deletion',
    async run() {
      await withDom(async window => {
        const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-undo-'));
        const entry = path.join(directory, 'UndoProbe.jsx');
        const controller = new AbortController();
        let bundle;
        try {
          await fsPromises.writeFile(entry, UNDO_PROBE_SOURCE(path.resolve('src/hooks/useUndoRedo.js')));
          const cancelled = [];
          // EventLogger polls window.electronAPI.onSettingsChanged from module
          // load until it exists; provide it before bundling so no interval
          // outlives this DOM.
          window.electronAPI = { cancelNodeTask: (nodeId, cause) => { cancelled.push(`${nodeId}:${cause}`); }, onSettingsChanged: () => {} };
          bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
          let api;
          const helper = { id: 'helper-1', type: 'interviewhelper', position: { x: 0, y: 0 }, data: {} };
          const nested = { id: 'helper-nested', type: 'interviewhelper', position: { x: 0, y: 0 }, data: {} };
          const group = { id: 'group-1', type: 'group', position: { x: 0, y: 0 }, data: { canvasData: { nodes: [nested] } } };
          const note = { id: 'note-1', type: 'note', position: { x: 0, y: 0 }, data: { text: 'keep' } };
          // Undo/redo hold a restoring flag until the next animation frame; let it clear between steps.
          const settle = () => new Promise(resolve => setTimeout(resolve, 40));
          const step = async action => { await bundle.module.act(async () => { action(); await flush(); await settle(); await flush(); }); };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.UndoProbe, { initialNodes: [note], onApi: next => { api = next; } })); await flush(); });
          try {
            await step(() => api.takeSnapshot());
            await step(() => api.setNodes([note, helper, group]));
            await step(() => api.takeSnapshot());
            assert(cancelled.length === 0, 'creating helpers must not cancel anything');
            await step(() => api.undo());
            assert(api.nodes.length === 1 && api.nodes[0].id === 'note-1', `undo must restore the pre-creation canvas, got ${api.nodes.map(node => node.id).join()}`);
            assert(cancelled.join('|') === 'helper-1:node-deleted|helper-nested:node-deleted', `undoing a creation must retire every removed helper's companion window, got ${cancelled.join('|')}`);
            await step(() => api.redo());
            assert(api.nodes.length === 3 && cancelled.length === 2, `redoing the creation re-adds the helpers without a cancellation, got ${api.nodes.length} nodes and ${cancelled.length} cancellations`);
            // Delete the helpers straight after the redo: the redone state is on
            // top of history, so undoing the deletion returns to it.
            await step(() => api.setNodes([note]));
            await step(() => api.takeSnapshot());
            await step(() => api.undo());
            assert(api.nodes.length === 3 && cancelled.length === 2, `undoing a deletion restores the helpers without a cancellation, got ${api.nodes.length} nodes and ${cancelled.length} cancellations`);
            await step(() => api.redo());
            assert(api.nodes.length === 1 && cancelled.join('|') === 'helper-1:node-deleted|helper-nested:node-deleted|helper-1:node-deleted|helper-nested:node-deleted', `redoing a deletion must retire the companion windows again, got ${cancelled.join('|')}`);
          } finally { await bundle.module.act(async () => root.unmount()); }
        } finally {
          controller.abort();
          await bundle?.dispose();
          await fsPromises.rm(directory, { recursive: true, force: true });
        }
      });
    },
  },
  {
    name: 'interview helper render: a prepare that fails while the bundle picker is open is retired, not orphaned, when another bundle is picked',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const prep = deferred(); const picker = deferred(); const completions = []; const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          selectInterviewApplicationBundle: () => picker.promise,
          prepareInterviewBrief: () => prep.promise,
          completeNonApiAiRun: async runId => { completions.push(runId); return { cleared: true }; },
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); await flush(); });
          await bundle.module.act(async () => { button(window, 'Prepare interview brief').click(); await flush(); });
          const runId = updates.map(item => item.patch.interviewHelperPreparationRunId).find(Boolean);
          assert(/^interview-helper:prepare:/u.test(runId || ''), 'prepare must record its durable run id');
          await bundle.module.act(async () => { button(window, 'Replace application bundle').click(); await flush(); });
          await bundle.module.act(async () => { prep.reject(new Error('worker interrupted')); await flush(); await flush(); await flush(); });
          assert(updates.some(item => item.patch.interviewHelperPreparation?.status === 'failed' && item.patch.interviewHelperPreparationRunId === runId), 'the interrupted prepare must leave a resumable recovery while the picker is open');
          await bundle.module.act(async () => { picker.resolve(publicBundle('9'.repeat(64), '8'.repeat(64))); await flush(); await flush(); await flush(); });
          assert(completions.includes(runId), `the recovery that appeared while the picker was open must be retired before it is cleared, got ${JSON.stringify(completions)}`);
          const clearIndex = updates.findIndex(item => item.patch.interviewHelperApplicationBundle?.artifactId === '9'.repeat(64) && item.patch.interviewHelperPreparationRunId === null);
          assert(clearIndex >= 0, 'picking a different bundle still clears the preparation state');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: re-picking the identical bundle keeps a finished brief',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const updates = [];
        window.electronAPI = {
          loadInterviewHelperCareerSnapshot: async () => ({ snapshot: snapshot() }),
          loadInterviewApplicationBundle: async () => publicBundle(),
          loadInterviewPreparedBrief: async () => ({ brief: publicBrief() }),
          selectInterviewApplicationBundle: async () => publicBundle(),
          launchInterviewWindow: async () => undefined,
        };
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperSourceNodeId: 'job-source', interviewHelperSourceSnapshotId: SNAPSHOT_A, interviewHelperJobUrl: JOB_URL,
            interviewHelperApplicationBundle: { artifactId: BUNDLE_ID, label: 'Acme application', digest: BUNDLE_DIGEST },
            interviewHelperPreparation: publicBrief(), interviewHelperPreparationRecordId: BRIEF_RECORD_ID,
            interviewHelperPreparationInputBinding: `v1:${SNAPSHOT_A}:${JOB_URL}:${BUNDLE_ID}`,
          },
          nodes: sourceNodes(), onPersist: (patch, next) => updates.push({ patch, next }),
        });
        try {
          await bundle.module.act(async () => { await flush(); await flush(); });
          assert(button(window, 'Launch interview view'), 'fixture must start with a ready brief');
          const before = updates.length;
          await bundle.module.act(async () => { button(window, 'Replace application bundle').click(); await flush(); await flush(); await flush(); });
          assert(!updates.slice(before).some(item => item.patch.interviewHelperPreparation === null || item.patch.interviewHelperPreparationRecordId === null), 'an identical bundle must not clear the finished brief');
          assert(button(window, 'Launch interview view'), 'the finished brief must still be launchable after re-picking the same bundle');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: the same career files in a different order resume the recorded run in the recorded order',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        const parseCalls = [];
        window.electronAPI = {
          getPathForFile: file => `/private/candidate/${file.name}`,
          parseCareerData: async args => { parseCalls.push(args); return { success: false }; },
        };
        const runId = 'interview-helper:compile:interview-helper:order';
        const root = await mount(bundle, window, {
          initialData: {
            interviewHelperCareerMode: 'import', interviewHelperCareerGeneration: 'interview-helper:interview-helper:order',
            interviewHelperCareerCompilation: { version: 1, status: 'compiling', generation: 'interview-helper:interview-helper:order', manualAiRunId: runId },
            interviewHelperCareerFilenames: ['resume.md', 'linkedin.md'],
          },
        });
        try {
          const target = window.document.querySelector('.border-dashed');
          const drop = new window.Event('drop', { bubbles: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'linkedin.md' }, { name: 'resume.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(drop); await flush(); await flush(); });
          assert(parseCalls.length === 1 && parseCalls[0].manualAiRunId === runId, `the same files in another order must resume the recorded run, got ${JSON.stringify(parseCalls.map(call => call.manualAiRunId))}`);
          assert(parseCalls[0].filePaths.join('|') === '/private/candidate/resume.md|/private/candidate/linkedin.md', `files must be resumed in the recorded order, got ${parseCalls[0].filePaths.join('|')}`);
          const other = new window.Event('drop', { bubbles: true });
          Object.defineProperty(other, 'dataTransfer', { value: { files: [{ name: 'resume.md' }, { name: 'different.md' }] } });
          await bundle.module.act(async () => { target.dispatchEvent(other); await flush(); await flush(); });
          assert(parseCalls.length === 1, 'a genuinely different file set must still be refused');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'interview helper render: Retry on a failed career import is disabled while the node is locked',
    async run() {
      await withDomBundledProbe(async (bundle, window) => {
        window.electronAPI = { getPathForFile: file => `/private/candidate/${file.name}`, parseCareerData: async () => ({ success: false }) };
        const root = await mount(bundle, window, {
          initialData: {
            locked: true, interviewHelperCareerMode: 'import', interviewHelperCareerGeneration: 'interview-helper:interview-helper:locked',
            interviewHelperCareerCompilation: { version: 1, status: 'failed', generation: 'interview-helper:interview-helper:locked', manualAiRunId: 'interview-helper:compile:interview-helper:locked' },
            interviewHelperCareerFilenames: ['resume.md'],
          },
        });
        try {
          const retry = button(window, 'Retry');
          assert(retry && retry.disabled, 'a locked node must not offer a Retry that silently does nothing');
        } finally { await bundle.module.act(async () => root.unmount()); }
      });
    },
  },
  {
    name: 'undo history: a redone state stays reachable after the next edit (A, B, undo, redo, C, undo lands on AB)',
    async run() {
      await withUndoHarness(async d => {
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A'); await d.edit('B');
        await d.step(() => d.api.undo());
        d.expect('A', 'undo from AB', 'canUndo=true canRedo=true');
        await d.step(() => d.api.redo());
        d.expect('AB', 'redo back to AB', 'canUndo=true canRedo=false');
        await d.edit('C');
        await d.step(() => d.api.undo());
        d.expect('AB', 'undo after redo + a fresh edit must land on the redone state');
        await d.step(() => d.api.undo());
        d.expect('A', 'the next undo');
        await d.step(() => d.api.undo());
        d.expect('(empty)', 'the next undo reaches the oldest state', 'canUndo=false canRedo=true');
        await d.step(() => d.api.redo());
        d.expect('A', 'redo from the oldest state', 'canUndo=true canRedo=true');
      });
    },
  },
  {
    name: 'undo history: the state an undo lands on stays reachable after the next edit with no redo involved (A, B, undo, C, undo lands on A)',
    async run() {
      await withUndoHarness(async d => {
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A'); await d.edit('B');
        await d.step(() => d.api.undo());
        d.expect('A', 'undo from AB', 'canUndo=true canRedo=true');
        await d.edit('C');
        d.expect('AC', 'a fresh edit after the undo', 'canUndo=true canRedo=false');
        await d.step(() => d.api.undo());
        d.expect('A', 'undo after a fresh edit must land on the state the earlier undo landed on');
        await d.step(() => d.api.undo());
        d.expect('(empty)', 'the next undo reaches the oldest state', 'canUndo=false canRedo=true');
        // An edit made while sitting on the oldest state must itself be undoable.
        await d.edit('X');
        assert(d.api.canUndo, 'an edit made at the oldest state must be undoable');
        await d.step(() => d.api.undo());
        d.expect('(empty)', 'undoing an edit made at the oldest state');
      });
    },
  },
  {
    name: 'undo history: undo x2, redo x2, then an edit keeps the topmost redone state reachable (A, B, C, undo, undo, redo, redo, D, undo lands on ABC)',
    async run() {
      await withUndoHarness(async d => {
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A'); await d.edit('B'); await d.edit('C');
        await d.step(() => d.api.undo()); d.expect('AB', 'first undo');
        await d.step(() => d.api.undo()); d.expect('A', 'second undo');
        await d.step(() => d.api.redo()); d.expect('AB', 'first redo');
        await d.step(() => d.api.redo()); d.expect('ABC', 'second redo', 'canUndo=true canRedo=false');
        await d.edit('D');
        await d.step(() => d.api.undo());
        d.expect('ABC', 'undo after two redos + a fresh edit must land on the redone state');
        await d.step(() => d.api.undo()); d.expect('AB', 'chain step 2');
        await d.step(() => d.api.undo()); d.expect('A', 'chain step 3');
        await d.step(() => d.api.undo()); d.expect('(empty)', 'chain step 4', 'canUndo=false canRedo=true');
      });
    },
  },
  {
    name: 'undo history: redo followed by an immediate undo, and undo x2 / redo x2 / undo with no edit, stay correct',
    async run() {
      await withUndoHarness(async d => {
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A'); await d.edit('B');
        await d.step(() => d.api.undo()); d.expect('A', 'undo');
        await d.step(() => d.api.redo()); d.expect('AB', 'redo');
        await d.step(() => d.api.undo()); d.expect('A', 'immediate undo after the redo', 'canUndo=true canRedo=true');
        await d.step(() => d.api.redo()); d.expect('AB', 'redo again');
        await d.step(() => d.api.undo()); d.expect('A', 'undo again');
        await d.step(() => d.api.undo()); d.expect('(empty)', 'chain end', 'canUndo=false canRedo=true');
        await d.step(() => d.api.undo()); d.expect('(empty)', 'a further undo at the oldest state is a no-op');

        await d.mount();
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A'); await d.edit('B'); await d.edit('C');
        await d.step(() => d.api.undo()); await d.step(() => d.api.undo());
        d.expect('A', 'two undos');
        await d.step(() => d.api.redo()); await d.step(() => d.api.redo());
        d.expect('ABC', 'two redos', 'canUndo=true canRedo=false');
        await d.step(() => d.api.undo());
        d.expect('AB', 'undo right after the redos, with no edit between');
        await d.step(() => d.api.undo()); d.expect('A', 'chain step 2');
        await d.step(() => d.api.undo()); d.expect('(empty)', 'chain step 3', 'canUndo=false canRedo=true');
      });
    },
  },
  {
    name: 'undo history: canUndo stays true while older history exists, after an undo, a redo and a fresh edit at the oldest state',
    async run() {
      await withUndoHarness(async d => {
        // A single undo that still has older history behind it.
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A'); await d.edit('B');
        await d.step(() => d.api.undo());
        d.expect('A', 'one undo with older history behind it', 'canUndo=true canRedo=true');

        // Redo to the top of a short history: the oldest state is still undoable.
        await d.mount();
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A');
        await d.step(() => d.api.undo());
        d.expect('(empty)', 'undo to the oldest state', 'canUndo=false canRedo=true');
        await d.step(() => d.api.redo());
        d.expect('A', 'redo to the top of a short history', 'canUndo=true canRedo=false');
        await d.step(() => d.api.undo());
        d.expect('(empty)', 'the redone state can be undone again', 'canUndo=false canRedo=true');

        // Create A, undo, create B: Undo must be live and the real Cmd+Z must work.
        await d.mount();
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A');
        await d.step(() => d.api.undo());
        d.expect('(empty)', 'undo of the only edit');
        await d.edit('B');
        d.expect('B', 'a new edit after undoing back to the oldest state', 'canUndo=true canRedo=false');
        await d.press('z');
        d.expect('(empty)', 'Cmd+Z after create A, undo, create B', 'canUndo=false canRedo=true');
      });
    },
  },
  {
    name: 'undo history: canUndo and canRedo are false while an active run blocks undo and redo, and recover afterwards',
    async run() {
      await withUndoHarness(async d => {
        const hub = hubState => ({ id: 'hub', type: 'jobhub', position: { x: 0, y: 0 }, data: { targetRole: 'Engineer', hubState } });
        const setHubState = hubState => d.step(() => d.api.setNodes(previous => previous.map(node => (node.id === 'hub' ? hub(hubState) : node))));
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A');
        await d.step(() => d.api.setNodes(previous => [...previous, hub('idle')]));
        await d.step(() => d.api.takeSnapshot());
        await d.edit('B');
        await d.step(() => d.api.undo());
        d.expect('Ahub', 'idle hub with history on both sides', 'canUndo=true canRedo=true');

        // An active Job Search owns the canvas: undo()/redo() are silent no-ops,
        // so the toolbar flags must say so instead of inviting a dead press.
        await setHubState('searching');
        d.expect('Ahub', 'run active', 'canUndo=false canRedo=false');
        await d.step(() => d.api.undo());
        d.expect('Ahub', 'undo during an active run is a no-op', 'canUndo=false canRedo=false');
        await d.step(() => d.api.redo());
        d.expect('Ahub', 'redo during an active run is a no-op', 'canUndo=false canRedo=false');
        assert(d.api.nodes.find(node => node.id === 'hub').data.hubState === 'searching', 'the run state must be untouched by blocked undo/redo');

        // The run ends: both directions are available again.
        await setHubState('idle');
        d.expect('Ahub', 'run finished', 'canUndo=true canRedo=true');
        await d.step(() => d.api.redo());
        d.expect('AhubB', 'redo after the run finished');
      });
    },
  },
  {
    name: 'undo history: the real Cmd+Z / Cmd+Shift+Z keys keep a redone state reachable (A, B, Cmd+Z, Cmd+Shift+Z, C, Cmd+Z lands on AB)',
    async run() {
      await withUndoHarness(async d => {
        // Canvas-style edits: snapshot before the mutation, the 500ms debounce records the result.
        await d.createLikeCanvas('A');
        await d.createLikeCanvas('B');
        await d.press('z');
        d.expect('A', 'Cmd+Z', 'canUndo=true canRedo=true');
        await d.press('z', true);
        d.expect('AB', 'Cmd+Shift+Z', 'canUndo=true canRedo=false');
        await d.createLikeCanvas('C');
        d.expect('ABC', 'create C');
        await d.press('z');
        d.expect('AB', 'Cmd+Z after redo + create C must land on the redone state');
        await d.press('z');
        d.expect('A', 'second Cmd+Z');
        await d.press('z');
        d.expect('(empty)', 'third Cmd+Z', 'canUndo=false canRedo=true');
        await d.press('z', true);
        d.expect('A', 'Cmd+Shift+Z from the oldest state', 'canUndo=true canRedo=true');
      });
    },
  },
  {
    name: 'undo history: undo and redo presses landing in the same tick chain through the committed state',
    async run() {
      await withUndoHarness(async d => {
        await d.step(() => d.api.takeSnapshot());
        for (const id of ['A', 'B', 'C', 'D']) await d.edit(id);
        // React has not re-rendered between these calls (a stateRef refreshed only
        // by an effect would still hold ABCD), as with key auto-repeat.
        await d.step(() => { d.api.undo(); d.api.undo(); d.api.undo(); });
        d.expect('A', 'three undo calls in one tick', 'canUndo=true canRedo=true');
        await d.step(() => { d.api.redo(); d.api.redo(); d.api.redo(); });
        d.expect('ABCD', 'three redo calls in one tick', 'canUndo=true canRedo=false');
        await d.step(() => d.api.undo());
        d.expect('ABC', 'a single undo after the chained redos');
      });
    },
  },
  {
    name: 'undo history: a live source-card topology is merged into the landed state so undo still reaches the oldest state',
    async run() {
      await withUndoHarness(async d => {
        // Source cards of a settled Job Search hub are live topology: undo keeps
        // the live cards and edges, so the committed landing state (not the stored
        // snapshot) has to be what history records, or undo gets stuck.
        const hub = { id: 'hub', type: 'jobhub', position: { x: 0, y: 0 }, data: { targetRole: 'Engineer', hubState: 'done' } };
        const card = { id: 'c1', type: 'jobsourcecard', position: { x: 5, y: 5 }, data: { hubId: 'hub' } };
        await d.mount([hub]);
        await d.step(() => d.api.takeSnapshot());
        await d.edit('A');
        await d.step(() => { d.api.setNodes(previous => [...previous, card]); d.api.setEdges([{ id: 'e1', source: 'hub', target: 'c1' }]); });
        await d.step(() => d.api.takeSnapshot());
        d.expect('hubAc1', 'start', 'canUndo=true canRedo=false');
        let presses = 0;
        while (d.api.canUndo && presses < 5) { await d.step(() => d.api.undo()); presses += 1; }
        d.expect('hubc1', 'undo reaches the oldest state with the live card kept', 'canUndo=false canRedo=true');
        assert(presses <= 3 && d.api.edges.map(edge => edge.id).join() === 'e1', `undo must terminate within the recorded steps and keep the live edge, took ${presses} presses`);
        await d.step(() => d.api.undo());
        d.expect('hubc1', 'a further undo at the oldest state changes nothing');
        await d.step(() => d.api.redo());
        assert(d.visible().includes('A'), `redo returns to the state with A, got ${d.visible()}`);
      });
    },
  },
];
