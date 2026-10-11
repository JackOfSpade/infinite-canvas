import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(import.meta.url);
const preloadPath = fileURLToPath(new URL('../../electron/preload.js', import.meta.url));

/**
 * Evaluate the CommonJS preload with the smallest possible Electron seam.
 * This intentionally does not import Electron or launch a renderer process:
 * the bridge and every invoked IPC request remain observable in this VM.
 */
function loadPreloadBridge() {
  const invocations = [];
  const exposures = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposures.push({ name, value });
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        const invocation = { channel, args };
        invocations.push(invocation);
        return Promise.resolve(invocation);
      },
      on() {},
      removeListener() {},
      send() {},
    },
    webUtils: {
      getPathForFile: file => `/stubbed/${file?.name || 'file'}`,
    },
  };
  const sandbox = {
    require(specifier) {
      assert.equal(specifier, 'electron', 'preload must require only Electron at this seam');
      return electron;
    },
    console: { error() {} },
    Set,
  };

  vm.runInNewContext(fs.readFileSync(preloadPath, 'utf8'), sandbox, { filename: preloadPath });

  assert.equal(exposures.length, 1, 'preload must expose one renderer bridge');
  assert.equal(exposures[0].name, 'electronAPI', 'preload must retain the broad renderer bridge name');
  return { api: exposures[0].value, invocations };
}

const DIRECT_FORWARDING = [
  ['loadInterviewHelperCareerSnapshot', 'load-interview-helper-career-snapshot', { nodeId: 'interview-node', snapshotId: 'a'.repeat(64) }],
  ['selectInterviewApplicationBundle', 'select-interview-preparation-bundle', { nodeId: 'interview-node' }],
  ['loadInterviewApplicationBundle', 'load-interview-preparation-bundle', { nodeId: 'interview-node', artifactId: 'b'.repeat(64) }],
  ['launchInterviewWindow', 'interview-window:launch', { nodeId: 'interview-node', snapshotId: 'a'.repeat(64), brief: { briefId: 'brief-1' } }],
];

const tests = [
  {
    name: 'interview preload: exposes the reviewed renderer methods without a raw brief builder',
    run() {
      const { api } = loadPreloadBridge();
      for (const [method] of DIRECT_FORWARDING) {
        assert.equal(typeof api[method], 'function', `electronAPI must expose ${method}`);
      }
      assert.equal(typeof api.prepareInterviewBrief, 'function', 'electronAPI must expose the renderer-safe brief preparation method');
      assert.equal(api.buildInterviewBrief, undefined, 'renderer must not receive a direct backend-named brief builder');
      return { methods: DIRECT_FORWARDING.length + 1 };
    },
  },
  {
    name: 'interview preload: forwards reviewed helper calls on their exact IPC channels',
    run: async () => {
      const { api, invocations } = loadPreloadBridge();
      for (const [method, channel, args] of DIRECT_FORWARDING) {
        const result = await api[method](args);
        assert.equal(result.channel, channel, `${method} must resolve its IPC invocation`);
        assert.deepEqual(result.args, [args], `${method} must forward its renderer args as one payload`);
      }
      assert.deepEqual(invocations.map(({ channel }) => channel), DIRECT_FORWARDING.map(([, channel]) => channel),
        'the reviewed renderer methods must use only their mapped IPC channels');
      return { channels: invocations.length };
    },
  },
  {
    name: 'interview preload: adapts renderer jobUrl to the backend canonicalJobUrl brief contract',
    run: async () => {
      const { api, invocations } = loadPreloadBridge();
      const rendererArgs = {
        nodeId: 'interview-node',
        snapshotId: 'a'.repeat(64),
        jobUrl: 'https://jobs.example.test/roles/123?source=canvas',
        bundleArtifactId: 'b'.repeat(64),
        manualAiRunId: 'manual-run-1',
        canonicalJobUrl: 'https://renderer-must-not-control.example.test/',
        untrustedExtra: 'must not cross the bridge',
      };

      const result = await api.prepareInterviewBrief(rendererArgs);
      assert.equal(result.channel, 'build-interview-brief', 'brief preparation must use the reviewed backend channel');
      assert.deepEqual({ ...result.args[0] }, {
        nodeId: rendererArgs.nodeId,
        snapshotId: rendererArgs.snapshotId,
        canonicalJobUrl: rendererArgs.jobUrl,
        bundleArtifactId: rendererArgs.bundleArtifactId,
        manualAiRunId: rendererArgs.manualAiRunId,
      }, 'brief preparation must allowlist its payload and rename jobUrl for the backend contract');
      assert.equal(invocations.length, 1, 'brief preparation must make exactly one IPC request');
      return { canonicalJobUrl: result.args[0].canonicalJobUrl };
    },
  },
  {
    name: 'interview preload: scopes prepared-brief verification to exact public bindings',
    run: async () => {
      const { api, invocations } = loadPreloadBridge();
      const args = {
        nodeId: 'interview-node', briefRecordId: 'c'.repeat(64), snapshotId: 'a'.repeat(64),
        jobUrl: 'https://jobs.example.test/roles/123', bundleArtifactId: 'b'.repeat(64), bundleArtifactDigest: 'd'.repeat(64),
        brief: { shouldNotCross: true }, untrustedExtra: 'must not cross the bridge',
      };
      const result = await api.loadInterviewPreparedBrief(args);
      assert.equal(result.channel, 'load-interview-prepared-brief', 'prepared-brief verification must use its narrow reviewed IPC route');
      assert.deepEqual({ ...result.args[0] }, {
        nodeId: args.nodeId, briefRecordId: args.briefRecordId, snapshotId: args.snapshotId,
        canonicalJobUrl: args.jobUrl, bundleArtifactId: args.bundleArtifactId, bundleArtifactDigest: args.bundleArtifactDigest,
      }, 'prepared-brief verification must not pass a renderer cache or arbitrary fields to main');
      assert.equal(invocations.length, 1, 'verification must issue exactly one narrow IPC request');
    },
  },
];

export default tests;

async function runDirectly() {
  for (const test of tests) {
    await test.run();
    console.log(`PASS ${test.name}`);
  }
  console.log(`[INTERVIEW PRELOAD TEST] ${tests.length} passed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === testPath) {
  runDirectly().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
