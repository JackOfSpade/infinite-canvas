import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  abortNodeTasks,
  assert,
  electronPkg,
  fs,
  handleSafe,
  isTrustedCanvasNavigation,
  os,
  path,
  readEditorialRubric,
  resolvePortableFilePaths,
} from '../test-dependencies.js';

function senderEvent() {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  return { sender };
}

export default [
  {
    name: 'IPC safe handler: timeout keeps its abort reason and cannot report a late success',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      handleSafe('test:timeout-abort', async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return { data: 'late result' };
      }, 1);
      const result = await electronPkg.ipcMain.__getInvokeHandler('test:timeout-abort')(senderEvent(), {});
      assert(result.success === false && result.error === 'Timeout',
        `timed-out work must return its own reason, got ${JSON.stringify(result)}`);
      return { error: result.error };
    },
  },
  {
    name: 'IPC safe handler: node deletion keeps its abort reason and cannot report a late success',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      let release;
      const finished = new Promise(resolve => { release = resolve; });
      handleSafe('test:node-deleted-abort', async () => {
        await finished;
        return { data: 'late result' };
      });
      const pending = electronPkg.ipcMain.__getInvokeHandler('test:node-deleted-abort')(senderEvent(), { nodeId: 'deleted-node' });
      abortNodeTasks('deleted-node');
      release();
      const result = await pending;
      assert(result.success === false && result.error === 'Node deleted',
        `node deletion must return its own reason, got ${JSON.stringify(result)}`);
      return { error: result.error };
    },
  },
  {
    name: 'portable relative file paths cannot escape their canvas directory',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-portable-path-'));
      const canvasDir = path.join(root, 'canvas');
      const canvasPath = path.join(canvasDir, 'workspace.json');
      const outsideFile = path.join(root, 'outside.txt');
      const insideFile = path.join(canvasDir, 'attachments', 'inside.txt');
      try {
        await fs.promises.mkdir(path.dirname(insideFile), { recursive: true });
        await Promise.all([
          fs.promises.writeFile(outsideFile, 'private'),
          fs.promises.writeFile(insideFile, 'portable'),
        ]);
        const data = { nodes: [
          { data: { filePath: '/missing/stale.txt', relativeFilePath: '../outside.txt' } },
          { data: { filePath: '/missing/inside.txt', relativeFilePath: 'attachments/inside.txt' } },
        ] };
        resolvePortableFilePaths(data, canvasPath);
        assert(data.nodes[0].data.filePath === '/missing/stale.txt',
          `relative traversal must not substitute an outside file, got ${data.nodes[0].data.filePath}`);
        assert(data.nodes[1].data.filePath === insideFile,
          'a legitimate relative descendant should still resolve');
        return { outsideBlocked: true, insideResolved: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job application editorial rubric reads Git-tracked README.md casing',
    run: () => {
      const reads = [];
      const rubric = readEditorialRubric('/design-system', (filePath) => {
        reads.push(filePath);
        if (path.basename(filePath) === 'SKILL.md') return 'skill';
        if (path.basename(filePath) === 'README.md') return 'readme';
        throw new Error(`unexpected editorial source ${filePath}`);
      });
      assert(rubric === 'skill\n\n---\n\nreadme', `unexpected rubric contents: ${rubric}`);
      assert(reads[1] === path.join('/design-system', 'README.md'),
        `must read Git-tracked README.md exactly, got ${reads.join(', ')}`);
      return { readme: reads[1] };
    },
  },
  {
    name: 'canvas navigation trusts only dist in production and the configured Vite origin in development',
    run: () => {
      const distDir = path.join(path.sep, 'app', 'dist');
      const bundled = pathToFileURL(path.join(distDir, 'index.html')).href;
      const escaped = pathToFileURL(path.join(path.sep, 'app', 'private.html')).href;
      assert(isTrustedCanvasNavigation(bundled, { distDir }), 'production accepts bundled dist content');
      assert(!isTrustedCanvasNavigation(escaped, { distDir }), 'production rejects file content outside dist');
      assert(!isTrustedCanvasNavigation('https://app.example.test', { distDir }), 'production rejects remote origins');

      const devServerUrl = 'http://localhost:5173';
      assert(isTrustedCanvasNavigation('http://localhost:5173/?init=blank', { devServerUrl, distDir }),
        'development accepts the configured Vite origin');
      assert(!isTrustedCanvasNavigation('http://127.0.0.1:5173/', { devServerUrl, distDir }),
        'development rejects a different loopback origin');
      assert(!isTrustedCanvasNavigation('http://localhost:4173/', { devServerUrl, distDir }),
        'development rejects a different Vite port');
      return { production: 'dist-only', development: 'exact-origin' };
    },
  },
];
