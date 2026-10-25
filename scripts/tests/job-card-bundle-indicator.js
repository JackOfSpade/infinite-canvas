import fs from 'node:fs';
import assert from 'node:assert';
import { runInNewContext } from 'node:vm';
import { canRegenerateLocalApplication, canSaveImportedLocalApplication } from '../../src/utils/localAiApplicationLifecycle.js';
import * as localAiFallback from '../../src/utils/localAiFallback.js';

import {
  APPLICATION_BUNDLE_TONES,
  applicationBundleIndicator,
} from '../../src/utils/jobCardBundleIndicator.js';

function readNodeSource() {
  return fs.readFileSync(
    new URL('../../src/nodes/JobCardNode.jsx', import.meta.url),
    'utf8',
  );
}

function fallbackManagerFixture(api) {
  const source = fs.readFileSync(new URL('../../src/hooks/useLocalAiFallbackManager.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function useLocalAiFallbackManager(');
  assert.ok(start >= 0);
  let nodes = [];
  const refs = [];
  const effects = [];
  let tick;
  const navigation = {
    enumerateAllNodes: () => nodes,
    updateNodeDataGlobally() {},
  };
  const hook = runInNewContext(`(${source.slice(start).replace('export function', 'function')})`, {
    ...localAiFallback,
    LOCAL_AI_RETRY_NOTICE_INTERVAL_MS: 30_000,
    isJobCardMounted: nodeId => nodes.some(node => node.id === nodeId),
    selectFallbackLocalAiJobs: all => localAiFallback.selectFallbackLocalAiJobs(all, () => true),
    useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
    useEffect: effect => effects.push(effect),
    window: { electronAPI: api, setInterval: callback => { tick = callback; return 1; }, clearInterval() {} },
    EventLogger: { log() {} },
    requestApplicationHandoffRefresh() {},
    Date: { now: () => 10_000 },
  });
  hook({ navigation, getCurrentFile: () => '/project/canvas.json', addToast() {} });
  // Settle the exact result before the automatic first tick, so an orphan
  // would be eligible for import without relying on wall-clock timers.
  refs[1].current.set('job', { resultSha256: 'a'.repeat(64), observedAt: 1 });
  const cleanups = effects.map(effect => effect());
  return {
    attachCard: () => { nodes = [{ id: 'card', type: 'jobcard', data: { localApplication: { id: 'job', status: 'completed' } } }]; },
    async finish() {
      for (let attempt = 0; refs[7].current && attempt < 30; attempt++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(refs[7].current, false, 'the actual fallback tick must settle');
      assert.equal(typeof tick, 'function');
    },
    stop: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}

export default [
  {
    name: 'deleting a saved bundle clears canvas ownership before saved-state adoption and preserves a newer handoff',
    run: async () => {
      const source = readNodeSource();
      const start = source.indexOf("{localApplication.status === 'saved' && localApplication.savedDir && window.electronAPI?.deleteLocalApplicationOutput");
      const handlerStart = source.indexOf('onClick={(e) => {', start) + 'onClick={'.length;
      const handlerEnd = source.indexOf('\n              }}', handlerStart) + '\n              }'.length;
      const syncStart = source.indexOf('  useEffect(() => {\n    if (JSON.stringify(data.localApplication || null) !== localApplicationKey)');
      const syncEnd = source.indexOf('\n  }, [', syncStart);
      const syncBody = source.slice(syncStart + '  useEffect(() => {'.length, syncEnd);
      assert.ok(start >= 0 && syncStart >= 0);
      for (const newer of [false, true]) {
        const saved = { id: 'saved-job', status: 'saved', savedDir: '/canvas/bundle' };
        let state = saved;
        const node = { data: { localApplication: saved } };
        const updates = [];
        let finishDelete;
        const pending = new Promise(resolve => { finishDelete = resolve; });
        const updateGlobal = (_id, patch) => {
          const next = typeof patch === 'function' ? patch(node) : patch;
          if (next) Object.assign(node.data, next);
          updates.push('canvas');
        };
        const setLocalApplication = update => {
          state = typeof update === 'function' ? update(state) : update;
          updates.push('local');
        };
        const handler = runInNewContext(`(${source.slice(handlerStart, handlerEnd)})`, {
          localApplication: saved, nav: null, id: 'card',
          window: { electronAPI: { deleteLocalApplicationOutput: () => pending } },
          localSavedProbeRef: { current: new Set() }, updateGlobal, setLocalApplication,
          setSavedFolderRecheck() {}, addToast() {},
        });
        handler({ stopPropagation() {} });
        if (newer) {
          state = { id: 'new-job', status: 'queued' };
          node.data.localApplication = state;
        }
        finishDelete({ success: true });
        await pending;
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(updates.slice(0, 2), ['canvas', 'local']);
        // Run the real synchronization effect after the deletion response.
        runInNewContext(`(() => {${syncBody}})()`, {
          data: node.data, localApplication: state, localApplicationKey: JSON.stringify(state),
          id: 'card', updateGlobal, setLocalApplication,
        });
        assert.strictEqual(state?.id ?? null, newer ? 'new-job' : null);
        assert.strictEqual(node.data.localApplication?.id ?? null, newer ? 'new-job' : null);
      }
      // A previously stranded card heals on its durable no-receipt probe,
      // even while the old saved snapshot is still present in canvas data.
      let state = { id: 'saved-job', status: 'failed', savedReceiptMissing: true,
        savedDir: null, receipt: null };
      const node = { data: { localApplication: { id: 'saved-job', status: 'saved', savedDir: '/canvas/bundle' } } };
      runInNewContext(`(() => {${syncBody}})()`, {
        data: node.data, localApplication: state, localApplicationKey: JSON.stringify(state), id: 'card',
        setLocalApplication: next => { state = next; },
        updateGlobal: (_id, patch) => Object.assign(node.data, patch(node)),
      });
      assert.strictEqual(node.data.localApplication, state);
      assert.ok(canRegenerateLocalApplication(state), 'a stranded deleted generation releases Generate');
    },
  },

  {
    name: 'fallback orphan recovery rechecks live card ownership after discovery and status waits',
    async run() {
      for (const boundary of ['discovery', 'status', 'unowned-control']) {
        let release;
        let entered;
        const waiting = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        let reads = 0;
        let imports = 0;
        const job = { id: 'job', status: 'completed', canvasFilePath: '/project/canvas.json', resultSha256: 'a'.repeat(64) };
        const fixture = fallbackManagerFixture({
          discoverLocalApplications: async () => {
            if (boundary === 'discovery') { entered(); await gate; }
            return { success: true, localJobs: [job] };
          },
          getLocalApplicationStatus: async () => {
            reads++;
            if (boundary !== 'discovery') { entered(); await gate; }
            return { success: true, localJob: job };
          },
          importLocalApplication: async () => {
            imports++;
            return { success: true, localApplication: { status: 'render-retry-required', resultSha256: job.resultSha256 } };
          },
        });
        try {
          await waiting;
          if (boundary !== 'unowned-control') fixture.attachCard();
          release();
          await fixture.finish();
          assert.equal(reads, boundary === 'discovery' ? 0 : 1, 'discovery cannot read a newly card-owned job as an orphan');
          assert.equal(imports, boundary === 'unowned-control' ? 1 : 0, 'only a still-unowned job may start orphan import');
        } finally { release(); fixture.stop(); }
      }
    },
  },
  {
    name: 'a Save As during application generation keeps receipt lookup, reveal, and save-failure recovery on the handoff owner',
    async run() {
      const source = readNodeSource();
      const start = source.indexOf('const importCompletedLocalApplication = useCallback(');
      const end = source.indexOf('\n  // Legacy coding-agent jobs', start);
      assert.ok(start >= 0 && end > start, 'the mounted-card import callback is available');
      // Execute the actual async callback with IPC/state boundaries supplied;
      // PDF authoring and document content are outside this operational test.
      const callbackSource = source.slice(start, end);
      const originalCanvas = '/project/original.canvas';
      const activeCanvas = '/project/saved-as.canvas';
      for (const saveSucceeds of [true, false]) {
        let localApplication = { id: 'job', status: 'completed', canvasFilePath: originalCanvas };
        const calls = [];
        const receipt = { outputDir: '/project/Applied Jobs/Acme/Role' };
        const api = {
          importLocalApplication: async request => {
            calls.push(['import', request.canvasFilePath]);
            return { success: true, localApplication: { workDir: '/project/.local-ai/work', missingArtifacts: [] } };
          },
          saveApplication: async request => {
            calls.push(['save', request.canvasFilePath]);
            return saveSucceeds ? { success: true, saved: true, dir: receipt.outputDir } : { success: false, error: 'Save unavailable' };
          },
          getLocalApplicationStatus: async request => {
            calls.push(['status', request.canvasFilePath]);
            return request.canvasFilePath === originalCanvas ? {
              success: true,
              localJob: saveSucceeds ? { id: 'job', status: 'saved', receipt }
                : { id: 'job', status: 'render-retry-required', message: 'Retry the saved result' },
            } : { success: false, error: 'No handoff belongs to this canvas' };
          },
        };
        const callback = runInNewContext(`${callbackSource}\nimportCompletedLocalApplication;`, {
          useCallback: fn => fn,
          window: { electronAPI: api },
          localApplication,
          nav: { getCurrentFile: () => activeCanvas },
          setLocalApplication: update => { localApplication = update(localApplication); },
          isMountedRef: { current: true },
          getLiveNode: () => ({ type: 'jobcard', data: { localApplication } }),
          idRef: { current: 'card' },
          data: { title: 'Role', location: 'Toronto' },
          EventLogger: { log() {}, error() {} },
          revealSavedLocalApplicationOutputOnce: request => calls.push(['reveal', request.canvasFilePath]),
          localAiOutputRevealedRef: { current: new Set() },
          brokenLocalAiJobDriveState: () => null,
          localSaveFailedHashesRef: { current: new Map() },
          addToast() {},
          canSaveImportedLocalApplication,
        });
        await callback('job', 'a'.repeat(64));
        assert.deepStrictEqual(calls.filter(([operation]) => operation !== 'save').map(([, canvas]) => canvas),
          saveSucceeds ? [originalCanvas, originalCanvas, originalCanvas] : [originalCanvas, originalCanvas],
          'every job/receipt operation retains the queued canvas after Save As');
        assert.strictEqual(calls.find(([operation]) => operation === 'save')?.[1], activeCanvas,
          'the existing save destination behavior remains unchanged');
        assert.strictEqual(localApplication.status, saveSucceeds ? 'saved' : 'render-retry-required',
          'the durable verdict is adopted immediately after a successful or failed save');
        if (saveSucceeds) assert.strictEqual(localApplication.receipt, receipt, 'the saved card receives its terminal receipt');
      }
      const fallback = fs.readFileSync(new URL('../../src/hooks/useLocalAiFallbackManager.js', import.meta.url), 'utf8');
      assert.ok(fallback.includes('const jobCanvasFilePath = local.canvasFilePath || saveCanvasFilePath;')
        && fallback.includes('jobId, canvasFilePath: jobCanvasFilePath, revealedRef: revealedOutputRef.current'),
      'the unmounted-card driver reveals through the same handoff owner');
    },
  },
  {
    name: 'applicationBundleIndicator returns null for non-saved and malformed inputs',
    run: async () => {
      const cases = [
        null,
        undefined,
        0,
        42,
        '',
        'saved',
        true,
        false,
        ['saved'],
        { status: 'saved' },
        { id: 'job-1' },
        { status: 'queued', id: 'job-1' },
        { status: 'importing', id: 'job-1' },
        { status: 'completed', id: 'job-1' },
        { status: 'failed', id: 'job-1' },
        { status: 'status-error', id: 'job-1' },
        { status: 'render-retry-required', id: 'job-1' },
        { status: 'invalid', id: 'job-1' },
        { status: 'saved', id: '' },
        { status: 'saved', id: 7 },
        { status: 'saved', id: null },
      ];

      for (const input of cases) {
        assert.strictEqual(
          applicationBundleIndicator(input),
          null,
          `expected null for ${JSON.stringify(input)}`,
        );
      }
    },
  },
  {
    name: 'a plain saved bundle maps to the saved tone and only appends savedDir when non-empty',
    run: async () => {
      const withoutDir = applicationBundleIndicator({ status: 'saved', id: 'job-1' });
      assert.strictEqual(withoutDir.tone, 'saved');
      assert.strictEqual(withoutDir.label, 'Application ready');
      assert.strictEqual(
        withoutDir.title,
        'An application bundle (résumé, cover letter, editable HTML) is already saved for this job.',
      );
      assert.ok(!withoutDir.title.includes('Folder:'), 'no savedDir should not append a Folder suffix');

      const withDir = applicationBundleIndicator({
        status: 'saved',
        id: 'job-2',
        savedDir: '/tmp/job-2',
      });
      assert.strictEqual(withDir.tone, 'saved');
      assert.ok(withDir.title.includes('Folder: /tmp/job-2'), 'savedDir is surfaced in the title');

      const emptyDir = applicationBundleIndicator({
        status: 'saved',
        id: 'job-3',
        savedDir: '',
      });
      assert.ok(!emptyDir.title.includes('Folder:'), 'empty savedDir should not append a Folder suffix');
    },
  },
  {
    name: 'missing artifacts produce an attention indicator naming each artifact with and',
    run: async () => {
      const indicator = applicationBundleIndicator({
        status: 'saved',
        id: 'job-1',
        missingArtifacts: ['Résumé PDF', 'Cover Letter PDF'],
      });
      assert.strictEqual(indicator.tone, 'attention');
      assert.strictEqual(indicator.label, 'Bundle saved · PDFs missing');
      assert.strictEqual(
        indicator.title,
        'Application bundle saved, but Résumé PDF and Cover Letter PDF could not be rendered. Use Repair bundle on this card to retry.',
      );
    },
  },
  {
    name: 'a résumé-length warning message produces an attention indicator with the message as title',
    run: async () => {
      const message = 'Your résumé runs long: it spans pages against its target.';
      const indicator = applicationBundleIndicator({
        status: 'saved',
        id: 'job-1',
        message,
      });
      assert.strictEqual(indicator.tone, 'attention');
      assert.strictEqual(indicator.label, 'Bundle saved · length warning');
      assert.strictEqual(indicator.title, message);
    },
  },
  {
    name: 'an empty missingArtifacts array with a normal message still maps to saved',
    run: async () => {
      const indicator = applicationBundleIndicator({
        status: 'saved',
        id: 'job-1',
        missingArtifacts: [],
        message: 'All good.',
      });
      assert.strictEqual(indicator.tone, 'saved');
      assert.strictEqual(indicator.label, 'Application ready');
    },
  },
  {
    name: 'the tone map carries a red cross class for both tones and is frozen',
    run: async () => {
      assert.strictEqual(Object.isFrozen(APPLICATION_BUNDLE_TONES), true, 'tone map must be frozen');
      for (const tone of ['saved', 'attention']) {
        const entry = APPLICATION_BUNDLE_TONES[tone];
        assert.ok(entry, `missing ${tone} tone`);
        assert.strictEqual(typeof entry.cross, 'string', `${tone} cross must be a string`);
        assert.ok(/text-red-/.test(entry.cross), `${tone} cross must be red`);
      }
    },
  },
  {
    name: 'JobCardNode lays a red X over saved cards that fades on hover/focus and never intercepts the pointer',
    run: async () => {
      const source = readNodeSource();

      assert.ok(source.includes("from '../utils/jobCardBundleIndicator'"), 'JobCardNode imports the bundle indicator helper');
      assert.ok(source.includes('applicationBundleIndicator(localApplication)'), 'JobCardNode calls the helper with the card state');
      assert.ok(!source.includes('job-card-bundle-badge') && !source.includes('job-card-bundle-stripe'), 'old badge/stripe are gone');

      const crossAt = source.indexOf('data-testid="job-card-bundle-cross"');
      assert.ok(crossAt !== -1, 'cross overlay present');
      const svgStart = source.lastIndexOf('<svg', crossAt);
      const svgEnd = source.indexOf('</svg>', crossAt);
      const svg = source.slice(svgStart, svgEnd);
      assert.ok(svg.includes('pointer-events-none'), 'overlay must not intercept the pointer');
      assert.ok(svg.includes('group-hover:opacity-0'), 'overlay disappears while the card is hovered');
      assert.ok(svg.includes('group-has-[:focus-visible]:opacity-0'), 'overlay disappears while the card has KEYBOARD focus');
      // A mouse-clicked button (e.g. the salary toggle) keeps plain focus after the pointer leaves; focus-within
      // would keep the X hidden forever (reported 2026-10-07).
      assert.ok(!svg.includes('group-focus-within'), 'overlay must not key off plain focus-within');
      assert.ok(svg.includes('absolute inset-2'), 'overlay covers the card but stays inset from the salary border');
      assert.ok(!svg.includes('border'), 'overlay draws no border of its own');
      assert.strictEqual((svg.match(/<line /g) || []).length, 2, 'two diagonals form the X');

      // The salary border and its title share one colour source.
      assert.ok(/style=\{\{\s*borderColor: compensationBorderColor,/.test(source), 'card border still comes from the compensation verdict');
      // The user's right-click border color is an outline ring, never the border itself.
      assert.ok(source.includes('outline: `3px solid ${data.markColor}`'), 'user mark color draws as an outline outside the salary border');
      assert.ok(source.includes('{ color: compensationBorderColor }'), 'salary title uses the exact border colour');

      // The overlay depends on the card root being the positioned `group`.
      const rootAt = source.indexOf('relative rounded-2xl');
      assert.ok(rootAt !== -1 && source.slice(rootAt, rootAt + 160).includes('group'), 'card root is relative and a group');
      assert.ok(rootAt < crossAt, 'overlay renders inside the card root');
    },
  },
];
