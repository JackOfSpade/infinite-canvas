import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import { assert } from './testHelpers.js';
import { isRendererSensitivePath, isSensitivePath } from '../../electron/utils/pathSafety.js';
import { callLLMVision } from '../../electron/ipc/llm.js';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import {
  atomicWriteRendererWorkspaceFile,
  assertDeleteTargetNotRepresented,
  assertRendererFilesystemPathAllowed,
  __recoveryRebindJournalForTests,
  createFileWatchRegistry,
  inspectRendererWorkspacePath,
  inspectAllowedOpenFilePath,
  readRendererWorkspaceFile,
  registerFilesystemHandlers,
  scanPath,
  syncTextParentDirectory,
} from '../../electron/ipc/filesystem.js';
import {
  assertPrivateLocalFileReservation,
  assertLocalFileLookupPathAllowed,
  assertPinnedLocalFileBinding,
  createPrivateLocalFileOutputDirectory,
  createPrivateLocalFileWorkDirectory,
  createPinnedLocalReadStream,
  isLocalFileSafetyError,
  openPinnedLocalFile,
  readPrivateLocalFile,
  removePrivateLocalFileWorkDirectory,
  reservePrivateLocalFile,
} from '../../electron/localFileProtocol.js';
import {
  __assertCareerInputDescriptorsStillMatchForTests,
  __assertOwnedStagedCareerAttachmentForTests,
  __readOwnedStagedCareerAttachmentForTests,
  __stageCareerInputFilesForTests,
} from '../../electron/ipc/jobs.js';

function eventForTest() {
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  return { sender };
}

async function rejects(action) {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

export default [
  {
    name: 'interview private stores: post-guard directory swaps cannot redirect workspace reads or handle-bound saves',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-race-'));
      const publicDir = path.join(root, 'ordinary-canvas-directory');
      const parkedPublicDir = path.join(root, 'ordinary-canvas-directory-parked');
      const privateDir = path.join(root, 'interview-helper-artifacts');
      const canvasName = 'canvas.json';
      const publicCanvas = path.join(publicDir, canvasName);
      const privateCanvas = path.join(privateDir, canvasName);
      try {
        await fs.promises.mkdir(publicDir);
        await fs.promises.mkdir(privateDir);
        await fs.promises.writeFile(publicCanvas, '{"nodes":["public"]}');
        await fs.promises.writeFile(privateCanvas, '{"private":"interview material"}');
        const privateBefore = await fs.promises.readFile(privateCanvas, 'utf8');

        const readTarget = await inspectRendererWorkspacePath(publicCanvas);
        // Simulate the adversary winning exactly after the original broad
        // renderer guard but before the helper opens or reads by name.
        await fs.promises.rename(publicDir, parkedPublicDir);
        await fs.promises.symlink(privateDir, publicDir);
        assert(await rejects(() => readRendererWorkspaceFile(readTarget)),
          'a checked public file cannot be reopened through a swapped private parent');
        assert((await fs.promises.readFile(privateCanvas, 'utf8')) === privateBefore,
          'the rejected read never exposes or alters the private record');

        await fs.promises.unlink(publicDir);
        await fs.promises.rename(parkedPublicDir, publicDir);
        const writeTarget = await inspectRendererWorkspacePath(publicCanvas, { allowMissing: true });
        await fs.promises.rename(publicDir, parkedPublicDir);
        await fs.promises.symlink(privateDir, publicDir);
        assert(await rejects(() => atomicWriteRendererWorkspaceFile(writeTarget, '{"nodes":["attempted"]}')),
          'a checked public save cannot write a record through a swapped private parent');
        assert((await fs.promises.readFile(privateCanvas, 'utf8')) === privateBefore,
          'the rejected handle-bound save leaves the Interview Helper record byte-for-byte intact');

        // Recreate the public spelling, then swap it in the narrow interval
        // after the writer's initial inspection but before its pathname open.
        // The post-open binding/guard must reject before the private record's
        // handle can receive any payload bytes.
        await fs.promises.unlink(publicDir);
        await fs.promises.rename(parkedPublicDir, publicDir);
        const preOpenRejected = await rejects(() => atomicWriteRendererWorkspaceFile(publicCanvas, '{"nodes":["attempted-before-open"]}', {
          beforeOpen: async () => {
            await fs.promises.rename(publicDir, parkedPublicDir);
            await fs.promises.symlink(privateDir, publicDir);
          },
        }));
        assert(preOpenRejected && (await fs.promises.readFile(privateCanvas, 'utf8')) === privateBefore,
          'a parent replacement in the validation-to-open gap must fail before sensitive workspace bytes are touched');
        return { readSwapRejected: true, writeSwapRejected: true, preOpenRejected };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: anchored-handle fallback keeps existing/new saves and derived deletes functional without a descriptor child namespace',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-handle-fallback-'));
      const publicDir = path.join(root, 'ordinary-canvas-directory');
      const parkedPublicDir = path.join(root, 'ordinary-canvas-directory-parked');
      const privateDir = path.join(root, 'interview-helper-artifacts');
      const publicCanvas = path.join(publicDir, 'canvas.json');
      const freshCanvas = path.join(publicDir, 'fresh-canvas.json');
      const fallbackCanvas = path.join(publicDir, 'fallback-canvas.json');
      const ipcCanvas = path.join(publicDir, 'ipc-round-trip.json');
      const privateCanvas = path.join(privateDir, 'canvas.json');
      const publicJournal = path.join(publicDir, '.ic-recovery-rebind-safe.json');
      const privateJournal = path.join(privateDir, '.ic-recovery-rebind-safe.json');
      const restorePublicDirectory = async () => {
        await fs.promises.unlink(publicDir);
        await fs.promises.rename(parkedPublicDir, publicDir);
      };
      try {
        await Promise.all([fs.promises.mkdir(publicDir), fs.promises.mkdir(privateDir)]);
        await Promise.all([
          fs.promises.writeFile(publicCanvas, '{"public":true}'),
          fs.promises.writeFile(privateCanvas, '{"private":"interview material"}'),
          fs.promises.writeFile(publicJournal, 'public journal'),
          fs.promises.writeFile(privateJournal, 'private journal'),
        ]);
        const privateCanvasBefore = await fs.promises.readFile(privateCanvas, 'utf8');
        const privateJournalBefore = await fs.promises.readFile(privateJournal, 'utf8');

        // This is the real macOS/Windows-shaped path: no /dev/fd child path is
        // injected or required. Both an existing canvas and a new one round
        // trip through the handle-pinned writer/reader.
        await atomicWriteRendererWorkspaceFile(publicCanvas, '{"existing":true}');
        await atomicWriteRendererWorkspaceFile(freshCanvas, '{"fresh":true}');
        assert((await readRendererWorkspaceFile(publicCanvas)).content === '{"existing":true}'
          && (await readRendererWorkspaceFile(freshCanvas)).content === '{"fresh":true}',
        'normal existing and newly-created canvases must save/load without descriptor-relative child traversal');

        // Windows and several network providers reject O_NOFOLLOW. Simulate
        // that documented EINVAL shape for every no-follow open: the writer
        // must retry without the flag, then bind the resulting handle before
        // bytes are touched. This is the portable fallback, not /dev/fd.
        const originalOpen = fs.promises.open;
        let noFollowFallbacks = 0;
        let fallbackReadContent = null;
        try {
          fs.promises.open = async (filePath, flags, mode) => {
            if (typeof flags === 'number' && fs.constants.O_NOFOLLOW && (flags & fs.constants.O_NOFOLLOW)) {
              noFollowFallbacks += 1;
              throw Object.assign(new Error('simulated unsupported O_NOFOLLOW'), { code: 'EINVAL' });
            }
            return originalOpen(filePath, flags, mode);
          };
          await atomicWriteRendererWorkspaceFile(fallbackCanvas, '{"fallback":true}');
          fallbackReadContent = (await readRendererWorkspaceFile(fallbackCanvas)).content;
        } finally {
          fs.promises.open = originalOpen;
        }
        assert(noFollowFallbacks > 0 && fallbackReadContent === '{"fallback":true}',
          'an O_NOFOLLOW-unavailable platform must still save and load through a post-open identity-bound handle');
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const ipcEvent = eventForTest();
        const saveViaIpc = await electronPkg.ipcMain.__getInvokeHandler('save-workspace')(ipcEvent, {
          data: { nodes: [], edges: [], drawings: [] },
          filePath: ipcCanvas,
        });
        const loadViaIpc = await electronPkg.ipcMain.__getInvokeHandler('load-workspace')(ipcEvent, { filePath: ipcCanvas });
        ipcEvent.sender.emit('destroyed');
        assert(saveViaIpc.success && saveViaIpc.filePath === ipcCanvas
          && typeof saveViaIpc.workspaceRecoveryStatus === 'string'
          && loadViaIpc.success && Array.isArray(loadViaIpc.data?.nodes),
        'the actual renderer save/load IPC must round-trip a new canvas on the portable handle path and surface its narrow WAL durability status');

        // Exercise the no-follow fallback on a read race too. The returned
        // handle is the old public inode, but once the pathname is swapped to
        // a private directory the final binding check must reject instead of
        // returning content read from a now-unrepresented handle.
        let fallbackReadRaceNoFollowFallbacks = 0;
        try {
          fs.promises.open = async (filePath, flags, mode) => {
            if (typeof flags === 'number' && fs.constants.O_NOFOLLOW && (flags & fs.constants.O_NOFOLLOW)) {
              fallbackReadRaceNoFollowFallbacks += 1;
              throw Object.assign(new Error('simulated unsupported O_NOFOLLOW'), { code: 'EINVAL' });
            }
            return originalOpen(filePath, flags, mode);
          };
          const fallbackReadRaceRejected = await rejects(() => readRendererWorkspaceFile(publicCanvas, {
            beforeRead: async () => {
              await fs.promises.rename(publicDir, parkedPublicDir);
              await fs.promises.symlink(privateDir, publicDir);
            },
          }));
          assert(fallbackReadRaceRejected && fallbackReadRaceNoFollowFallbacks > 0
            && (await fs.promises.readFile(privateCanvas, 'utf8')) === privateCanvasBefore,
          'the no-follow fallback must reject a parent swap after open before private bytes can be exposed');
        } finally {
          fs.promises.open = originalOpen;
        }
        await restorePublicDirectory();

        // And cover the later half of a read: even bytes already obtained
        // from the old public handle are not returned once its pathname stops
        // representing that handle before the final verification.
        const lateReadRejected = await rejects(() => readRendererWorkspaceFile(publicCanvas, {
          beforeFinalVerification: async () => {
            await fs.promises.rename(publicDir, parkedPublicDir);
            await fs.promises.symlink(privateDir, publicDir);
          },
        }));
        assert(lateReadRejected
          && (await fs.promises.readFile(privateCanvas, 'utf8')) === privateCanvasBefore,
        'a read race after bytes are obtained must fail closed rather than return content for a replaced pathname');
        await restorePublicDirectory();

        // Swap after the writer has opened and verified the public inode. The
        // payload may only reach the parked public handle; the final identity
        // proof rejects the operation and the private record remains intact.
        const lateWriteRejected = await rejects(() => atomicWriteRendererWorkspaceFile(publicCanvas, '{"attempted":true}', {
          beforeWrite: async () => {
            await fs.promises.rename(publicDir, parkedPublicDir);
            await fs.promises.symlink(privateDir, publicDir);
          },
        }));
        assert(lateWriteRejected
          && (await fs.promises.readFile(privateCanvas, 'utf8')) === privateCanvasBefore
          && (await fs.promises.readFile(path.join(parkedPublicDir, 'canvas.json'), 'utf8')) === '{"existing":true}',
        'an observed post-handle parent swap must reject before any new canvas bytes are written or reported successful');
        await restorePublicDirectory();

        // The physical unlink is the deliberately narrow host-derived
        // operation. A swap observed while its handle capability is live must
        // fail before unlink; an ordinary derived-journal delete still works.
        const lateDeleteRejected = await rejects(() => __recoveryRebindJournalForTests.removeRendererWorkspaceFileIfPresent(publicJournal, {
          beforeDelete: async () => {
            await fs.promises.rename(publicDir, parkedPublicDir);
            await fs.promises.symlink(privateDir, publicDir);
          },
        }));
        assert(lateDeleteRejected && (await fs.promises.readFile(privateJournal, 'utf8')) === privateJournalBefore,
          'a sidecar/journal delete must reject an observed parent swap before touching the private entry');
        await restorePublicDirectory();
        const normalDelete = await __recoveryRebindJournalForTests.removeRendererWorkspaceFileIfPresent(publicJournal);
        assert(normalDelete && !fs.existsSync(publicJournal),
          'the serialized host-derived delete must remain functional after the failed race');
        return {
          platform: process.platform,
          existingAndNewRoundTrip: true,
          noFollowFallbacks,
          fallbackReadRaceNoFollowFallbacks,
          lateReadRejected,
          ipcRoundTrip: saveViaIpc.success && loadViaIpc.success,
          lateWriteRejected,
          lateDeleteRejected,
          normalDelete,
        };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: a public hard-link alias cannot expose or mutate a private-store inode',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-hardlink-'));
      const privateDir = path.join(root, 'interview-helper-artifacts');
      const publicDir = path.join(root, 'ordinary-canvas-directory');
      const privateRecord = path.join(privateDir, 'record.json');
      const publicAlias = path.join(publicDir, 'looks-public.json');
      const privateText = path.join(privateDir, 'private-notes.txt');
      const publicTextAlias = path.join(publicDir, 'looks-public.txt');
      try {
        await Promise.all([fs.promises.mkdir(privateDir), fs.promises.mkdir(publicDir)]);
        await fs.promises.writeFile(privateRecord, '{"private":"interview material"}');
        await fs.promises.link(privateRecord, publicAlias);
        await fs.promises.writeFile(privateText, 'private interview material');
        await fs.promises.link(privateText, publicTextAlias);
        const privateBefore = await fs.promises.readFile(privateRecord, 'utf8');
        assert(!isSensitivePath(publicAlias)
          && await rejects(() => readRendererWorkspaceFile(publicAlias))
          && await rejects(() => atomicWriteRendererWorkspaceFile(publicAlias, '{"attempted":true}'))
          && (await fs.promises.readFile(privateRecord, 'utf8')) === privateBefore,
        'a benign-looking hard-link spelling must not become a read/write alias for private application bytes');

        // These are the actual generic IPC handlers, rather than a helper
        // shortcut: their lexical path is public and their extension allowed,
        // so the nlink boundary is the only thing preventing a private inode
        // from being opened by the OS or returned as editor baseline text.
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const originalOpenPath = electronPkg.shell.openPath;
        let openCalls = 0;
        try {
          electronPkg.shell.openPath = async () => { openCalls += 1; return ''; };
          const invoke = channel => electronPkg.ipcMain.__getInvokeHandler(channel);
          const open = await invoke('open-file')(eventForTest(), publicTextAlias);
          const read = await invoke('read-text-file')(eventForTest(), publicTextAlias);
          const watch = await invoke('start-file-watch')(eventForTest(), publicTextAlias);
          assert(!open.success && !read.success && !watch.success && openCalls === 0
            && open.errorCode === 'OPEN_FILE_HARDLINK_UNSUPPORTED'
            && read.errorCode === 'TEXT_FILE_HARDLINK_UNSUPPORTED'
            && watch.errorCode === 'RENDERER_WORKSPACE_PATH_CHANGED'
            && (await fs.promises.readFile(privateText, 'utf8')) === 'private interview material',
          'open-file, read-text-file, and start-file-watch must reject a public hard-link alias before opening or exposing a private inode');
        } finally {
          electronPkg.shell.openPath = originalOpenPath;
        }
        return { hardLinkRejected: true, genericIpcHardLinkRejected: true, watchHardLinkRejected: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: a post-write competing replacement cannot be reported as the published workspace',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-publish-'));
      const publicDir = path.join(root, 'ordinary-canvas-directory');
      const publicCanvas = path.join(publicDir, 'canvas.json');
      const displacedCanvas = path.join(publicDir, 'canvas-displaced.json');
      const firstCanvas = path.join(publicDir, 'first-canvas.json');
      const displacedFirstCanvas = path.join(publicDir, 'first-canvas-displaced.json');
      try {
        await fs.promises.mkdir(publicDir);
        await fs.promises.writeFile(publicCanvas, '{"baseline":true}');
        const rejected = await rejects(() => atomicWriteRendererWorkspaceFile(publicCanvas, '{"published":true}', {
          beforeFinalVerification: async () => {
            await fs.promises.rename(publicCanvas, displacedCanvas);
            await fs.promises.writeFile(publicCanvas, '{"attacker replacement":true}');
          },
        }));
        assert(rejected && (await fs.promises.readFile(publicCanvas, 'utf8')) === '{"attacker replacement":true}'
          && (await fs.promises.readFile(displacedCanvas, 'utf8')) === '{"published":true}',
        'post-rename inode/content verification must reject a concurrent same-name replacement even when the replacement is regular JSON');
        assert(await rejects(() => readRendererWorkspaceFile(publicCanvas)),
          'a retained write-ahead record must not repair a replacement inode or expose it as the prior workspace');

        // First saves use an O_EXCL-created inode followed by a nonce marker
        // and exact journal binding. Replacement in that narrow upgrade window
        // is detected before payload write; only the harmless owned marker can
        // remain on the displaced public inode.
        const firstRejected = await rejects(() => atomicWriteRendererWorkspaceFile(firstCanvas, '{"first-published":true}', {
          beforeBindJournal: async () => {
            await fs.promises.rename(firstCanvas, displacedFirstCanvas);
            await fs.promises.writeFile(firstCanvas, '{"attacker first replacement":true}');
          },
        }));
        assert(firstRejected
          && (await fs.promises.readFile(firstCanvas, 'utf8')) === '{"attacker first replacement":true}'
          && (await fs.promises.readFile(displacedFirstCanvas, 'utf8')).startsWith('ICWS-FIRST-SAVE-v1:')
          && await rejects(() => readRendererWorkspaceFile(firstCanvas)),
        'a first-save path replacement before the exact journal bind must fail closed before payload bytes reach a displaced inode');
        return { concurrentReplacementRejected: rejected, firstReplacementRejected: firstRejected };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: host write-ahead recovery completes an interrupted public handle write without pretending it was atomic',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-recovery-'));
      const canvas = path.join(root, 'canvas.json');
      const firstCanvas = path.join(root, 'first-save.json');
      const unprovenCanvas = path.join(root, 'first-save-before-marker.json');
      const markerCanvas = path.join(root, 'first-save-marker-phase.json');
      const attackerCanvas = path.join(root, 'first-save-attacker-replacement.json');
      const displacedMarkerCanvas = path.join(root, 'first-save-owned-marker-displaced');
      try {
        await fs.promises.writeFile(canvas, '{"before":true}');
        const interrupted = await rejects(() => atomicWriteRendererWorkspaceFile(canvas, '{"after":true}', {
          // This occurs after the payload has reached the synced handle but
          // before the caller receives success. The host record must make the
          // next open finish/verify the exact same public inode.
          beforeFinalVerification: async () => { throw new Error('simulated interruption'); },
        }));
        const recovered = await readRendererWorkspaceFile(canvas);
        assert(interrupted && recovered.content === '{"after":true}',
          'an interrupted in-place save must recover its complete public payload on the next load rather than claim an atomic rename occurred');

        // First-save staging happens before O_EXCL creates the final path. A
        // crash/error after creation but before payload publication must not
        // strand a zero-byte canvas with no recovery record.
        const firstInterrupted = await rejects(() => atomicWriteRendererWorkspaceFile(firstCanvas, '{"first-save":true}', {
          beforeWrite: async () => { throw new Error('simulated first-save interruption'); },
        }));
        const firstRecovered = await readRendererWorkspaceFile(firstCanvas);
        assert(firstInterrupted && firstRecovered.content === '{"first-save":true}',
          'an interrupted first save must recover from its pre-create host journal rather than leave a private or public partial');

        // There remains one Node-level crash sliver between O_EXCL and the
        // marker write: no portable descriptor-relative create+tag syscall
        // exists. It is deliberately typed fail-closed, not guessed at or
        // overwritten. This models a process stop at precisely that point.
        const unprovenInterrupted = await rejects(() => atomicWriteRendererWorkspaceFile(unprovenCanvas, '{"unproven":true}', {
          beforeFirstSaveMarker: async () => { throw new Error('simulated crash before first-save marker'); },
        }));
        let unprovenRecoveryCode = null;
        try {
          await readRendererWorkspaceFile(unprovenCanvas);
        } catch (error) {
          unprovenRecoveryCode = error?.code;
        }
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const unprovenLoad = await electronPkg.ipcMain.__getInvokeHandler('load-workspace')(
          eventForTest(),
          { filePath: unprovenCanvas },
        );
        assert(unprovenInterrupted
          && unprovenRecoveryCode === 'RENDERER_WORKSPACE_RECOVERY_AMBIGUOUS'
          && !unprovenLoad.success
          && unprovenLoad.errorCode === 'RENDERER_WORKSPACE_RECOVERY_AMBIGUOUS'
          && (await fs.promises.stat(unprovenCanvas)).size === 0,
        'the O_EXCL-to-marker sliver must leave an unproven placeholder untouched with an explicit IPC recovery status');

        // This hook is exactly the first-save crash phase after O_EXCL and the
        // fsynced nonce marker, but before the journal is upgraded with an
        // inode identity. A simulated restart must recognize and self-heal
        // only that owned placeholder into the journal's byte-exact payload.
        const markerInterrupted = await rejects(() => atomicWriteRendererWorkspaceFile(markerCanvas, '{"marker-phase":true}', {
          beforeBindJournal: async () => { throw new Error('simulated crash after owned first-save marker'); },
        }));
        const markerRecovered = await readRendererWorkspaceFile(markerCanvas);
        assert(markerInterrupted && markerRecovered.content === '{"marker-phase":true}',
          'a restart must resume a first-save placeholder only when its private journal nonce marker proves ownership');

        // A same-name replacement after the marker cannot be trusted merely
        // because a provisional WAL exists. It must remain byte-for-byte
        // untouched and surface the typed recovery state rather than being
        // deleted, overwritten, or returned as canvas content.
        const attackerInterrupted = await rejects(() => atomicWriteRendererWorkspaceFile(attackerCanvas, '{"owned":true}', {
          beforeBindJournal: async () => {
            await fs.promises.rename(attackerCanvas, displacedMarkerCanvas);
            await fs.promises.writeFile(attackerCanvas, '{"attacker":"replacement"}');
            throw new Error('simulated crash after attacker replacement');
          },
        }));
        let attackerRecoveryCode = null;
        try {
          await readRendererWorkspaceFile(attackerCanvas);
        } catch (error) {
          attackerRecoveryCode = error?.code;
        }
        assert(attackerInterrupted
          && attackerRecoveryCode === 'RENDERER_WORKSPACE_RECOVERY_AMBIGUOUS'
          && (await fs.promises.readFile(attackerCanvas, 'utf8')) === '{"attacker":"replacement"}'
          && (await fs.promises.readFile(displacedMarkerCanvas, 'utf8')).startsWith('ICWS-FIRST-SAVE-v1:'),
        'an attacker-created first-save replacement must fail closed with typed recovery status and never be mistaken for our placeholder');
        return {
          interrupted,
          recovered: recovered.content === '{"after":true}',
          firstInterrupted,
          firstRecovered: firstRecovered.content === '{"first-save":true}',
          unprovenRecoveryCode,
          unprovenIpcRecoveryCode: unprovenLoad.errorCode,
          markerInterrupted,
          markerRecovered: markerRecovered.content === '{"marker-phase":true}',
          attackerRecoveryCode,
        };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: only known unsupported directory fsync errors are tolerated after a rename',
    run: async () => {
      const unsupported = Object.assign(new Error('directory sync unavailable'), { code: 'EINVAL' });
      const tolerated = await syncTextParentDirectory('/virtual/unsupported-directory', {
        open: async () => ({ sync: async () => { throw unsupported; }, close: async () => {} }),
      });
      const windowsUnsupported = await syncTextParentDirectory('/virtual/windows-directory', {
        platform: 'win32',
        open: async () => ({
          sync: async () => { throw Object.assign(new Error('directory sync unavailable on Windows'), { code: 'EPERM' }); },
          close: async () => {},
        }),
      });
      let ioFailureSurfaced = false;
      try {
        await syncTextParentDirectory('/virtual/io-failure-directory', {
          open: async () => ({
            sync: async () => { throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' }); },
            close: async () => {},
          }),
        });
      } catch (error) {
        ioFailureSurfaced = error?.code === 'EIO';
      }
      assert(tolerated === false && windowsUnsupported === false && ioFailureSurfaced,
        'only documented directory-sync unsupported errors may complete a post-rename path without an ambiguous false failure');
      return {
        unsupportedTolerated: tolerated === false,
        windowsUnsupportedTolerated: windowsUnsupported === false,
        ioFailureSurfaced,
      };
    },
  },
  {
    name: 'interview private stores: Windows case variants share one recovery-rebind journal and owner key',
    run: async () => {
      const helpers = __recoveryRebindJournalForTests;
      const windows = { platform: 'win32' };
      const oldCanvas = path.join(process.cwd(), 'CaseSensitiveFixture', 'OldCanvas.JSON');
      const newCanvas = path.join(process.cwd(), 'CaseSensitiveFixture', 'NewCanvas.JSON');
      const oldVariant = oldCanvas.toUpperCase();
      const newVariant = newCanvas.toUpperCase();
      const originalPaths = helpers.recoveryRebindJournalPaths(oldCanvas, newCanvas, windows);
      const variantPaths = helpers.recoveryRebindJournalPaths(oldVariant, newVariant, windows);
      assert(helpers.sameRecoveryRebindPath(oldCanvas, oldVariant, windows)
        && helpers.sameRecoveryRebindPath(newCanvas, newVariant, windows)
        && helpers.normalizeRecoveryRebindPath(oldCanvas, windows) === helpers.normalizeRecoveryRebindPath(oldVariant, windows)
        && originalPaths.length === variantPaths.length
        && originalPaths.every((journalPath, index) => (
          path.basename(journalPath) === path.basename(variantPaths[index])
          && helpers.sameRecoveryRebindPath(journalPath, variantPaths[index], windows)
        )),
      'Windows case variants must derive the same recovery journal slot and compare as the same ownership path');
      return { caseFoldedRecoveryKey: true, journalSlots: originalPaths.length };
    },
  },
  {
    name: 'interview private stores: generic delete IPC rejects userData, private roots, and every ancestor before OS trash',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-delete-root-'));
      const userData = path.join(root, 'host-user-data');
      const ordinaryFile = path.join(root, 'ordinary-file.txt');
      const userDataAlias = path.join(root, 'ordinary-looking-user-data-alias');
      const originalGetPath = electronPkg.app.getPath;
      const originalTrash = electronPkg.shell.trashItem;
      let trashCalls = 0;
      try {
        await Promise.all([
          fs.promises.mkdir(path.join(userData, 'interview-helper-artifacts'), { recursive: true }),
          fs.promises.mkdir(path.join(userData, 'interview-helper-prepared-briefs'), { recursive: true }),
          fs.promises.mkdir(path.join(userData, 'career-input-staging'), { recursive: true }),
          fs.promises.mkdir(path.join(userData, 'career-snapshot-store'), { recursive: true }),
          fs.promises.mkdir(path.join(userData, 'renderer-workspace-write-journal'), { recursive: true }),
          fs.promises.mkdir(path.join(userData, 'local-file-protocol-transcodes'), { recursive: true }),
          fs.promises.writeFile(ordinaryFile, 'ordinary'),
        ]);
        await fs.promises.symlink(userData, userDataAlias);
        electronPkg.app.getPath = (name) => name === 'userData' ? userData : originalGetPath(name);
        electronPkg.shell.trashItem = async () => { trashCalls += 1; };
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const remove = electronPkg.ipcMain.__getInvokeHandler('delete-os-file');
        const directAndAncestorTargets = [
          userData,
          path.dirname(userData),
          path.dirname(path.dirname(userData)),
          path.join(userData, 'interview-helper-artifacts'),
          path.join(userData, 'interview-helper-prepared-briefs'),
          path.join(userData, 'career-input-staging'),
          path.join(userData, 'career-snapshot-store'),
          path.join(userData, 'renderer-workspace-write-journal'),
          path.join(userData, 'local-file-protocol-transcodes'),
          userDataAlias,
        ];
        const denied = await Promise.all(directAndAncestorTargets.map(filePath => remove(eventForTest(), {
          filePath,
          protectedPaths: [],
        })));
        const ordinary = await remove(eventForTest(), { filePath: ordinaryFile, protectedPaths: [] });
        assert(denied.every(result => !result.success)
          && denied.slice(0, 3).every(result => result.errorCode === 'PRIVATE_RENDERER_PATH')
          && !denied.at(-1).success
          && ordinary.success && trashCalls === 1,
        'delete-os-file must reject the app root, each private root, symlink aliases, and broader ancestors without broadening ordinary deletion');
        return { deniedTargets: directAndAncestorTargets.length, ordinaryDeleteAllowed: ordinary.success };
      } finally {
        electronPkg.app.getPath = originalGetPath;
        electronPkg.shell.trashItem = originalTrash;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: the complete registered userData namespace blocks unknown host components from generic IPC',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-userdata-root-'));
      const userData = path.join(root, 'host-user-data');
      const unknownPrivateDir = path.join(userData, 'browser-data');
      const privateText = path.join(unknownPrivateDir, 'Cookies.md');
      const privateRecord = path.join(unknownPrivateDir, 'Preferences.json');
      const originalGetPath = electronPkg.app.getPath;
      try {
        await fs.promises.mkdir(unknownPrivateDir, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(privateText, 'browser profile secret'),
          fs.promises.writeFile(privateRecord, '{"browserProfile":"secret"}'),
        ]);
        electronPkg.app.getPath = name => name === 'userData' ? userData : originalGetPath(name);
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const invoke = channel => electronPkg.ipcMain.__getInvokeHandler(channel);
        const [scan, read, load, open, save, remove] = await Promise.all([
          invoke('scan-directory')(eventForTest(), unknownPrivateDir),
          invoke('read-text-file')(eventForTest(), privateText),
          invoke('load-workspace')(eventForTest(), { filePath: privateRecord }),
          invoke('open-file')(eventForTest(), privateText),
          invoke('save-workspace')(eventForTest(), { data: { nodes: [] }, filePath: path.join(unknownPrivateDir, 'new-canvas.json') }),
          invoke('delete-os-file')(eventForTest(), { filePath: privateRecord, protectedPaths: [] }),
        ]);
        assert(isRendererSensitivePath(privateText)
          && !scan.success && !read.success && !load.success && !open.success && !save.success && !remove.success
          && (await fs.promises.readFile(privateText, 'utf8')) === 'browser profile secret',
        'a newly-added or unlisted app userData component must remain outside every generic renderer filesystem route');
        return { registeredUserDataDenied: true };
      } finally {
        electronPkg.app.getPath = originalGetPath;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: Unicode case-fold spellings cannot probe private-store existence',
    run: async () => {
      // U+017F is already lowercase, so toLowerCase() keeps it, while a
      // case-insensitive volume resolves it as 's'.
      const longS = String.fromCodePoint(0x17F);
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-casefold-'));
      const foldedRoot = path.join(path.dirname(root), path.basename(root).replace('casefold', `ca${longS}efold`));
      const userData = path.join(root, 'host-user-data');
      const foldedUserData = path.join(foldedRoot, 'host-user-data');
      const originalGetPath = electronPkg.app.getPath;
      try {
        const stores = ['interview-helper-artifacts', 'interview-helper-prepared-briefs'];
        for (const store of stores) {
          const storeDir = path.join(userData, store);
          await fs.promises.mkdir(storeDir, { recursive: true });
          await fs.promises.writeFile(path.join(storeDir, 'a'.repeat(64) + '.json'), '{"private":1}');
          await fs.promises.writeFile(path.join(storeDir, 'present.md'), 'private application prose');
        }
        electronPkg.app.getPath = name => name === 'userData' ? userData : originalGetPath(name);
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const invoke = channel => electronPkg.ipcMain.__getInvokeHandler(channel);
        if (process.platform === 'darwin' || process.platform === 'win32') {
          assert(isRendererSensitivePath(path.join(foldedUserData, 'browser-data', 'Cookies.md')),
            'a case-fold spelling of the registered userData root must stay renderer-private');
        }
        for (const store of stores) {
          const foldedStore = path.join(foldedUserData, `${store.slice(0, -1)}${longS}`);
          assert(isSensitivePath(path.join(foldedStore, 'a'.repeat(64) + '.json')), `${store} must be sensitive under a U+017F spelling`);
          const results = await Promise.all([
            invoke('open-file')(eventForTest(), path.join(foldedStore, 'a'.repeat(64) + '.json')),
            invoke('open-file')(eventForTest(), path.join(foldedStore, 'b'.repeat(64) + '.json')),
            invoke('read-text-file')(eventForTest(), path.join(foldedStore, 'present.md')),
            invoke('read-text-file')(eventForTest(), path.join(foldedStore, 'missing.md')),
          ]);
          assert(results.every(result => !result.success && /private application data/i.test(result.error || '') && !/ENOENT/u.test(result.error || '')),
            `${store}: existing and missing records must fail identically so a renderer cannot probe existence (${results.map(result => result.error).join(' | ')})`);
          assert(await fs.promises.readFile(path.join(userData, store, 'present.md'), 'utf8') === 'private application prose', `${store}: private contents must be unchanged`);
        }
      } finally {
        electronPkg.app.getPath = originalGetPath;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: a pre-open workspace failure retains its typed cause',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-preopen-'));
      const canvas = path.join(root, 'new-canvas.json');
      let failureCode = null;
      try {
        try {
          await atomicWriteRendererWorkspaceFile(canvas, '{"never":"opened"}', {
            beforeOpen: async () => {
              const error = new Error('intentional pre-open refusal');
              error.code = 'TEST_PREOPEN_TYPED_REFUSAL';
              throw error;
            },
          });
        } catch (error) {
          failureCode = error?.code;
        }
        assert(failureCode === 'TEST_PREOPEN_TYPED_REFUSAL' && !fs.existsSync(canvas),
          'finally must not dereference an absent handle and obscure a typed failure before open');
        return { failureCode };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: watcher quotas dedupe subscriptions, release on cleanup, and terminate a newly hard-linked target',
    run: async () => {
      const sender = () => {
        const value = new EventEmitter();
        value.isDestroyed = () => false;
        value.send = () => {};
        return value;
      };
      const senderA = sender();
      const senderB = sender();
      const root = path.join(process.cwd(), '.watch-cap-fixture');
      const first = path.join(root, 'one.md');
      const second = path.join(root, 'two.md');
      const third = path.join(root, 'three.md');
      const fourth = path.join(root, 'four.md');
      const watchers = [];
      const registry = createFileWatchRegistry({
        maxTargetsPerSender: 2,
        maxTargets: 3,
        access: async () => {},
        realpath: async candidate => candidate,
        watch: (_watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.callback = callback;
          watcher.close = () => { watcher.closed = true; };
          watchers.push(watcher);
          return watcher;
        },
        onError: () => {},
      });
      let senderLimitCode = null;
      let globalLimitCode = null;
      try {
        await registry.start(senderA, first);
        await registry.start(senderA, first); // refcounted, but one quota slot
        await registry.start(senderA, second);
        try { await registry.start(senderA, third); } catch (error) { senderLimitCode = error?.code; }
        await registry.start(senderB, third);
        try { await registry.start(senderB, fourth); } catch (error) { globalLimitCode = error?.code; }
        assert(registry.getCounts(senderA).targets === 3
          && registry.getCounts(senderA).subscriptions === 4
          && registry.getCounts(senderA).senderTargets === 2
          && senderLimitCode === 'FILE_WATCH_LIMIT_EXCEEDED'
          && globalLimitCode === 'FILE_WATCH_LIMIT_EXCEEDED',
        'watch quotas must count unique targets deterministically while duplicate starts remain deduplicated');

        registry.stop(senderA, first);
        registry.stop(senderA, first);
        senderA.emit('destroyed');
        registry.stop(senderB, third);
        assert(registry.getCounts(senderA).targets === 0
          && registry.getCounts(senderA).subscriptions === 0
          && registry.getCounts(senderA).senderTargets === 0,
        'stop and destroyed cleanup must release both watcher handles and quota accounting');
        await registry.start(senderB, fourth);
        assert(registry.getCounts(senderB).targets === 1,
          'a released global slot must be reusable rather than permanently exhausting the registry');
      } finally {
        registry.stop(senderB, fourth);
      }

      const hardlinkRoot = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-watch-revalidate-'));
      const publicDir = path.join(hardlinkRoot, 'public');
      const privateDir = path.join(hardlinkRoot, 'interview-helper-artifacts');
      const watchedFile = path.join(publicDir, 'notes.md');
      const privateAlias = path.join(privateDir, 'notes-link.md');
      const safeAlias = path.join(publicDir, 'safe-notes-alias.md');
      const guardedSender = sender();
      const notifications = [];
      guardedSender.send = (_channel, changedPath) => notifications.push(changedPath);
      const guardedWatchers = [];
      const guardedRegistry = createFileWatchRegistry({
        validateTarget: filePath => inspectRendererWorkspacePath(filePath, { allowMissing: true }),
        watch: (_watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.callback = callback;
          watcher.close = () => { watcher.closed = true; };
          guardedWatchers.push(watcher);
          return watcher;
        },
        onError: () => {},
      });
      try {
        await Promise.all([fs.promises.mkdir(publicDir), fs.promises.mkdir(privateDir)]);
        await fs.promises.writeFile(watchedFile, 'public watcher content');
        // A safe final symlink remains a normal document-watching workflow.
        // The production registry follows/revalidates its public target rather
        // than rejecting every alias merely to catch hard links.
        await fs.promises.symlink(watchedFile, safeAlias);
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        const safeAliasEvent = eventForTest();
        const safeAliasWatch = await electronPkg.ipcMain.__getInvokeHandler('start-file-watch')(
          safeAliasEvent,
          safeAlias,
        );
        safeAliasEvent.sender.emit('destroyed');
        assert(safeAliasWatch.success,
          'a public final-symlink document must remain watchable while its resolved target is single-link and safe');
        await fs.promises.unlink(safeAlias);
        await guardedRegistry.start(guardedSender, watchedFile);
        await new Promise(resolve => setTimeout(resolve, 0));
        await fs.promises.link(watchedFile, privateAlias);
        guardedWatchers[0].callback('change', path.basename(watchedFile));
        for (let attempt = 0; attempt < 20 && guardedRegistry.getCounts().targets !== 0; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(guardedRegistry.getCounts().targets === 0 && notifications.length === 0,
          'a post-start hard-link/identity change must close the subscription before a renderer notification is sent');
        return {
          dedupedQuota: true,
          cleanupReleased: true,
          safeAliasWatch: safeAliasWatch.success,
          hardlinkRevalidationClosed: true,
        };
      } finally {
        guardedRegistry.stop(guardedSender, watchedFile);
        await fs.promises.rm(hardlinkRoot, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: Windows watcher case-folds alias and native callback names before a safe retarget',
    run: async () => {
      const root = path.join(process.cwd(), '.watch-win32-case-fixture');
      const alias = path.join(root, 'Aliases', 'Shortcut.JSON');
      const firstTarget = path.join(root, 'PublicOne', 'TargetOne.JSON');
      const secondTarget = path.join(root, 'PublicTwo', 'TargetTwo.JSON');
      const windowsKey = value => path.resolve(value).normalize('NFC').toLowerCase();
      let canonicalTarget = firstTarget;
      const sender = new EventEmitter();
      const notifications = [];
      sender.isDestroyed = () => false;
      sender.send = (_channel, filePath) => notifications.push(filePath);
      const watchers = [];
      const registry = createFileWatchRegistry({
        platform: 'win32',
        access: async () => {},
        realpath: async candidate => (
          windowsKey(candidate) === windowsKey(alias) ? canonicalTarget : candidate
        ),
        validateTarget: async () => ({ safe: true }),
        watch: (watchedPath, callback) => {
          const watcher = new EventEmitter();
          watcher.watchedPath = watchedPath;
          watcher.callback = callback;
          watcher.close = () => { watcher.closed = true; };
          watchers.push(watcher);
          return watcher;
        },
        onError: () => {},
      });
      try {
        await registry.start(sender, alias);
        await new Promise(resolve => setTimeout(resolve, 0));
        const aliasWatcher = watchers.find(watcher => (
          windowsKey(watcher.watchedPath) === windowsKey(path.dirname(alias))
        ));
        assert(aliasWatcher,
          'the lexical alias directory must remain watched when it resolves outside its own parent');

        canonicalTarget = secondTarget;
        // Windows may report the original directory spelling in a different
        // case from the requested alias. A literal comparison would drop this
        // event and leave a watcher attached to the old public target.
        aliasWatcher.callback('rename', 'SHORTCUT.JSON');
        for (let attempt = 0; attempt < 20 && !watchers.some(watcher => (
          windowsKey(watcher.watchedPath) === windowsKey(path.dirname(secondTarget))
        )); attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const secondNativeWatcher = [...watchers].reverse().find(watcher => (
          windowsKey(watcher.watchedPath) === windowsKey(path.dirname(secondTarget))
        ));
        assert(secondNativeWatcher && notifications.includes(alias),
          'a case-variant alias callback must safely rebind to the retarget and preserve the renderer display spelling');

        // The new native target event is subject to the same Windows folding,
        // rather than only fixing the lexical alias branch.
        secondNativeWatcher.callback('change', 'TARGETTWO.JSON');
        for (let attempt = 0; attempt < 20 && notifications.length < 2; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(notifications.length >= 2,
          'a case-variant native callback basename must notify after the safe rebind');
        return { aliasCaseFolded: true, nativeCaseFolded: true, notifications: notifications.length };
      } finally {
        registry.stop(sender, alias);
      }
    },
  },
  {
    name: 'interview private stores: local-file descriptor binding rejects private aliases and replacement races before streaming bytes',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-local-protocol-'));
      const publicDir = path.join(root, 'public');
      const privateDir = path.join(root, 'interview-helper-artifacts');
      const publicFile = path.join(publicDir, 'attachment.txt');
      const parkedPublicFile = path.join(publicDir, 'attachment-parked.txt');
      const privateFile = path.join(privateDir, 'brief.txt');
      const publicAlias = path.join(publicDir, 'looks-public.txt');
      const privateParentAlias = path.join(root, 'ordinary-looking-preview-parent');
      const privateBytes = 'private interview-only payload';
      try {
        await Promise.all([fs.promises.mkdir(publicDir), fs.promises.mkdir(privateDir)]);
        await Promise.all([
          fs.promises.writeFile(publicFile, 'ordinary public attachment'),
          fs.promises.writeFile(privateFile, privateBytes),
        ]);
        await fs.promises.link(privateFile, publicAlias);
        let hardlinkError = null;
        try { await openPinnedLocalFile(publicAlias); } catch (error) { hardlinkError = error; }
        assert(hardlinkError?.code === 'LOCAL_FILE_HARDLINK_UNSUPPORTED'
          && isLocalFileSafetyError(hardlinkError),
        'a public local-file hard-link alias must be rejected before any private bytes are opened for streaming');

        const additionalPrivateProtocolStores = [
          path.join(root, 'career-input-staging'),
          path.join(root, 'career-snapshot-store'),
        ];
        for (const privateStore of additionalPrivateProtocolStores) {
          const privateProtocolRecord = path.join(privateStore, 'private-preview.jpg');
          await fs.promises.mkdir(privateStore);
          await fs.promises.writeFile(privateProtocolRecord, privateBytes);
          let privateStoreError = null;
          try { await openPinnedLocalFile(privateProtocolRecord); } catch (error) { privateStoreError = error; }
          assert(privateStoreError?.code === 'LOCAL_FILE_UNSAFE_PATH',
            'local-file protocol must reject private career staging/snapshot records before descriptor streaming');
        }

        await fs.promises.symlink(privateDir, privateParentAlias);
        let missingPreviewError = null;
        try {
          await assertLocalFileLookupPathAllowed(path.join(privateParentAlias, 'missing-preview.png'));
        } catch (error) {
          missingPreviewError = error;
        }
        assert(missingPreviewError?.code === 'LOCAL_FILE_UNSAFE_PATH',
          'a missing image path below a private symlink parent must be rejected before preview relinking can enumerate it');
        await fs.promises.unlink(privateParentAlias);

        let replacementError = null;
        try {
          await openPinnedLocalFile(publicFile, {
            beforeOpen: async () => {
              await fs.promises.rename(publicFile, parkedPublicFile);
              await fs.promises.writeFile(publicFile, 'competing public replacement');
            },
          });
        } catch (error) {
          replacementError = error;
        }
        assert(replacementError?.code === 'LOCAL_FILE_PATH_CHANGED'
          && (await fs.promises.readFile(publicFile, 'utf8')) === 'competing public replacement',
        'a post-validation regular replacement must not be silently streamed from a pathname reopened after validation');
        await fs.promises.unlink(publicFile);
        await fs.promises.rename(parkedPublicFile, publicFile);

        const heldPublicFile = await openPinnedLocalFile(publicFile);
        await fs.promises.rename(publicFile, parkedPublicFile);
        await fs.promises.writeFile(publicFile, 'replacement after descriptor binding');
        let afterBindingError = null;
        try { await assertPinnedLocalFileBinding(heldPublicFile); } catch (error) { afterBindingError = error; }
        await heldPublicFile.close();
        assert(afterBindingError?.code === 'LOCAL_FILE_PATH_CHANGED',
          'a replacement after descriptor validation must be caught again before the protocol starts streaming');
        await fs.promises.unlink(publicFile);
        await fs.promises.rename(parkedPublicFile, publicFile);

        // Force the documented O_NOFOLLOW fallback, then replace the public
        // spelling with a private symlink immediately before its plain open.
        // The fallback may acquire a descriptor, but its post-open binding
        // must reject it before a reader can receive even one private byte.
        let fallbackError = null;
        let noFollowFallbacks = 0;
        const originalOpen = fs.promises.open;
        try {
          await openPinnedLocalFile(publicFile, {
            open: async (candidate, flags, mode) => {
              if (fs.constants.O_NOFOLLOW && (flags & fs.constants.O_NOFOLLOW)) {
                noFollowFallbacks += 1;
                throw Object.assign(new Error('simulated no-follow unsupported'), { code: 'EINVAL' });
              }
              return originalOpen(candidate, flags, mode);
            },
            beforeFallbackOpen: async () => {
              await fs.promises.rename(publicFile, parkedPublicFile);
              await fs.promises.symlink(privateFile, publicFile);
            },
          });
        } catch (error) {
          fallbackError = error;
        }
        assert(isLocalFileSafetyError(fallbackError)
          && (fs.constants.O_NOFOLLOW ? noFollowFallbacks > 0 : true)
          && (await fs.promises.readFile(privateFile, 'utf8')) === privateBytes,
        'the no-follow fallback must fail closed after a private replacement without disclosing or altering private bytes');
        await fs.promises.unlink(publicFile);
        await fs.promises.rename(parkedPublicFile, publicFile);

        const pinned = await openPinnedLocalFile(publicFile);
        let streamed = '';
        for await (const chunk of createPinnedLocalReadStream(pinned)) streamed += chunk;
        const mainSource = await fs.promises.readFile(path.resolve('electron/main.js'), 'utf8');
        assert(streamed === 'ordinary public attachment',
          'normal local-file attachments must still stream through the pinned descriptor');
        assert(mainSource.includes('openPinnedLocalFile(targetPath')
          && mainSource.includes('createPinnedLocalReadStream(pinnedFile')
          && !mainSource.includes('fs.createReadStream(targetPath'),
        'the live protocol handler must use the tested pinned descriptor path rather than reopening a renderer pathname');
        return {
          hardlinkCode: hardlinkError.code,
          missingPreviewCode: missingPreviewError.code,
          replacementCode: replacementError.code,
          afterBindingCode: afterBindingError.code,
          fallbackCode: fallbackError.code,
          normalPinnedStream: true,
          handlerWiredToPinnedStream: true,
        };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: local-file conversion workspaces reject temp/cache symlink swaps before any result bytes are returned',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-transcode-workspace-'));
      const userData = path.join(root, 'host-user-data');
      const privateStore = path.join(root, 'career-snapshot-store');
      const privateRecord = path.join(privateStore, 'candidate-source.jpg');
      let workspace = null;
      try {
        await Promise.all([
          fs.promises.mkdir(userData),
          fs.promises.mkdir(privateStore),
        ]);
        await fs.promises.writeFile(privateRecord, 'private snapshot bytes');
        workspace = await createPrivateLocalFileWorkDirectory(userData);
        const workspaceRootStat = await fs.promises.stat(workspace.storageRoot);
        assert((workspaceRootStat.mode & 0o777) === 0o700,
          'the local-file conversion root must be app-owned 0700 rather than a shared temp directory');

        const source = await reservePrivateLocalFile(workspace.directory, 'source.heic');
        await source.handle.writeFile('pinned public source bytes');
        await source.close();
        const sourceStat = await fs.promises.stat(source.filePath);
        assert((sourceStat.mode & 0o777) === 0o600,
          'the copied decoder source must retain its exclusive 0600 reservation');

        const output = await createPrivateLocalFileOutputDirectory(workspace.directory);
        const markerReservation = { filePath: output.markerPath, identity: output.markerIdentity };
        await assertPrivateLocalFileReservation(output.directory, markerReservation);
        const outputPath = path.join(output.directory, 'source.jpg');
        await fs.promises.symlink(privateRecord, outputPath);
        let outputSwapError = null;
        try { await readPrivateLocalFile(output.directory, outputPath); } catch (error) { outputSwapError = error; }
        assert(outputSwapError?.code === 'LOCAL_FILE_PRIVATE_OUTPUT_UNSAFE'
          && (await fs.promises.readFile(privateRecord, 'utf8')) === 'private snapshot bytes',
        'a planted converter-output symlink must fail before a private target can be read');

        const plantedReservationPath = path.join(workspace.directory, 'attacker-cache.jpg');
        await fs.promises.symlink(privateRecord, plantedReservationPath);
        let reservationError = null;
        try { await reservePrivateLocalFile(workspace.directory, 'attacker-cache.jpg'); } catch (error) { reservationError = error; }
        assert(reservationError?.code === 'LOCAL_FILE_PRIVATE_OUTPUT_UNSAFE',
          'an existing temp/cache symlink must not be adopted as a local-file conversion reservation');

        await fs.promises.unlink(output.markerPath);
        await fs.promises.symlink(privateRecord, output.markerPath);
        let markerSwapError = null;
        try { await assertPrivateLocalFileReservation(output.directory, markerReservation); } catch (error) { markerSwapError = error; }
        assert(markerSwapError?.code === 'LOCAL_FILE_PRIVATE_OUTPUT_UNSAFE',
          'the converter namespace marker must detect a post-creation symlink replacement');

        // Cleanup must not turn a swapped workdir spelling into a recursive
        // deletion of a private store. Restore the owned directory afterward
        // so the ordinary cleanup path remains exercised too.
        const parkedWorkspace = `${workspace.directory}-parked`;
        await fs.promises.rename(workspace.directory, parkedWorkspace);
        await fs.promises.symlink(privateStore, workspace.directory);
        const swappedCleanup = await removePrivateLocalFileWorkDirectory(workspace.directory, {
          storageRoot: workspace.storageRoot,
        });
        assert(!swappedCleanup && (await fs.promises.readFile(privateRecord, 'utf8')) === 'private snapshot bytes',
          'a substituted conversion workdir must be left untouched rather than recursively removed');
        await fs.promises.unlink(workspace.directory);
        await fs.promises.rename(parkedWorkspace, workspace.directory);
        assert(await removePrivateLocalFileWorkDirectory(workspace.directory, { storageRoot: workspace.storageRoot }),
          'an intact private conversion workdir must still clean up normally');
        workspace = null;

        const mainSource = await fs.promises.readFile(path.resolve('electron/main.js'), 'utf8');
        assert(!mainSource.includes('ic_imgcache_')
          && !mainSource.includes('path.join(os.tmpdir()')
          && mainSource.includes('createPrivateLocalFileOutputDirectory')
          && mainSource.includes('readPrivateLocalFile(output.directory, outputPath)'),
        'the live sips path must use the tested private output namespace rather than a shared predictable disk cache');
        return {
          privateWorkspace: true,
          outputSwapCode: outputSwapError.code,
          markerSwapCode: markerSwapError.code,
          cacheReservationCode: reservationError.code,
        };
      } finally {
        if (workspace) {
          await removePrivateLocalFileWorkDirectory(workspace.directory, { storageRoot: workspace.storageRoot }).catch(() => {});
        }
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: renderer-denied career staging remains usable by its host-owned importer',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-host-stage-'));
      const source = path.join(root, 'ordinary-resume.txt');
      const stagingRoot = path.join(root, 'career-input-staging');
      let staged = null;
      try {
        await fs.promises.writeFile(source, 'ordinary source material for the host importer');
        assert(isSensitivePath(stagingRoot),
          'renderer path policy must classify the career staging root as private');
        staged = await __stageCareerInputFilesForTests([source], { stagingRoot });
        assert(staged?.stagedPaths?.length === 1
          && (await fs.promises.readFile(staged.stagedPaths[0], 'utf8')) === 'ordinary source material for the host importer',
        'the host-owned staging API must use the system-only safety policy for its own private output root');
        return { stagedByHost: true };
      } finally {
        await staged?.cleanup?.();
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: renderer filesystem IPC cannot read, scan, open, save, or delete authority records',
    run: async () => {
      // Keep the fixture below the workspace: macOS canonicalizes /tmp below
      // /private/var, which is intentionally a pre-existing sensitive root.
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.interview-private-store-'));
      const regularDir = path.join(root, 'regular-canvas-files');
      const regularCanvas = path.join(regularDir, 'canvas.json');
      let trashCalls = 0;
      const originalTrash = electronPkg.shell.trashItem;
      try {
        await fs.promises.mkdir(regularDir);
        await fs.promises.writeFile(regularCanvas, '{"nodes":[]}');

        const stores = [
          'interview-helper-artifacts',
          'interview-helper-prepared-briefs',
          'career-input-staging',
          'career-snapshot-store',
          'local-file-protocol-transcodes',
        ];
        const hostRecoveryRecord = path.join(root, 'renderer-workspace-write-journal', 'opaque.journal');
        assert(isSensitivePath(hostRecoveryRecord)
          && await rejects(() => assertRendererFilesystemPathAllowed(hostRecoveryRecord, { allowMissing: true })),
        'the host-only workspace recovery payload store must not become a renderer-readable fallback');
        for (const store of stores) {
          const storeDir = path.join(root, store);
          const privateRecord = path.join(storeDir, 'a'.repeat(64) + '.json');
          const privateText = path.join(storeDir, 'private-notes.md');
          await fs.promises.mkdir(storeDir);
          await fs.promises.writeFile(privateRecord, '{"private":"application prose"}');
          await fs.promises.writeFile(privateText, 'private application prose');

          assert(isSensitivePath(storeDir) && isSensitivePath(privateRecord),
            `${store} must be sensitive as an exact component and descendant`);
          assert(await rejects(() => assertRendererFilesystemPathAllowed(privateRecord)),
            `${store} must reject generic renderer reads`);
          assert(await rejects(() => assertRendererFilesystemPathAllowed(path.join(storeDir, 'new-record.json'), { allowMissing: true })),
            `${store} must reject non-existing renderer save targets before creation`);
          assert(await rejects(() => inspectAllowedOpenFilePath(privateRecord)),
            `${store} must reject OS-open before inspecting the private record`);
          assert(await scanPath(storeDir, new Set()) === null,
            `${store} must not be recursively scanned`);
        }

        // A symlink parent is the relevant non-existing save-path case: the
        // lexical spelling is benign but its nearest existing parent resolves
        // into the app-private artifact directory.
        const aliasParent = path.join(root, 'ordinary-looking-alias');
        await fs.promises.symlink(path.join(root, stores[0]), aliasParent);
        assert(await rejects(() => assertRendererFilesystemPathAllowed(
          path.join(aliasParent, 'new-record.json'), { allowMissing: true },
        )), 'a symlinked parent into an Interview store must reject before a new file is written');

        assert(!isSensitivePath(regularCanvas), 'ordinary canvas paths must remain usable');
        const normalGuard = await assertRendererFilesystemPathAllowed(regularCanvas);
        assert(normalGuard.normalizedPath === regularCanvas && normalGuard.resolvedPath === regularCanvas,
          'ordinary canvas paths must survive lexical and canonical guard checks');
        const normalScan = await scanPath(regularCanvas, new Set());
        assert(normalScan?.type === 'document' && normalScan.filePath === regularCanvas,
          'ordinary canvas files must remain scannable');
        assert((await inspectAllowedOpenFilePath(regularCanvas)).resolvedPath === regularCanvas,
          'ordinary canvas files must remain eligible for the normal OS-open validation path');

        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        electronPkg.shell.trashItem = async () => { trashCalls += 1; };
        const invoke = channel => electronPkg.ipcMain.__getInvokeHandler(channel);

        // A recovery journal is parsed from a normal canvas directory, so its
        // old/new entries need the same real-path protection. A benign-looking
        // alias to a private store must fail before the journal can read its
        // target bytes or trigger recovery-owner migration.
        const privateViaAlias = path.join(aliasParent, 'a'.repeat(64) + '.json');
        const crossJournal = __recoveryRebindJournalForTests.recoveryRebindJournalPaths(
          regularCanvas,
          privateViaAlias,
        )[1];
        const privateBytes = await fs.promises.readFile(privateViaAlias);
        await __recoveryRebindJournalForTests.writeRecoveryRebindJournal(crossJournal, {
          version: 1,
          oldCanvasPath: regularCanvas,
          newCanvasPath: privateViaAlias,
          phase: 'canvas-written',
          canvasDigest: createHash('sha256').update(privateBytes).digest('hex'),
          previousTargetDigest: null,
        });
        const crossoverLoad = await invoke('load-workspace')(eventForTest(), { filePath: regularCanvas });
        assert(!crossoverLoad.success && /private application data/i.test(crossoverLoad.error || ''),
          'a recovery journal cannot cross into a private store through a symlink alias');
        const aliasWatch = await invoke('start-file-watch')(eventForTest(), path.join(aliasParent, 'not-yet-created.json'));
        const aliasLoad = await invoke('load-workspace')(eventForTest(), { filePath: path.join(aliasParent, 'not-yet-created.json') });
        assert(!aliasWatch.success && !aliasLoad.success
          && /private application data/i.test(aliasWatch.error || '')
          && /private application data/i.test(aliasLoad.error || ''),
        'missing paths below an aliased private store must not attach watchers or inspect recovery journals');

        for (const store of stores) {
          const privateRecord = path.join(root, store, 'a'.repeat(64) + '.json');
          const privateText = path.join(root, store, 'private-notes.md');
          const privateSave = path.join(root, store, 'new-record.json');
          const scan = await invoke('scan-directory')(eventForTest(), path.join(root, store));
          const load = await invoke('load-workspace')(eventForTest(), { filePath: privateRecord });
          const open = await invoke('open-file')(eventForTest(), privateRecord);
          const read = await invoke('read-text-file')(eventForTest(), privateText);
          const write = await invoke('write-text-file')(eventForTest(), {
            filePath: privateText,
            content: 'attempted overwrite',
          });
          const saveData = { nodes: [], transientProgress: { mustRemainUntouched: true } };
          const save = await invoke('save-workspace')(eventForTest(), { data: saveData, filePath: privateSave });
          const remove = await invoke('delete-os-file')(eventForTest(), { filePath: privateRecord, protectedPaths: [] });
          assert(!scan.success && !load.success && !open.success && !read.success && !write.success && !save.success && !remove.success,
            `${store} must be rejected by every broad filesystem IPC route`);
          assert(Object.hasOwn(saveData, 'transientProgress') && !fs.existsSync(privateSave)
            && (await fs.promises.readFile(privateText, 'utf8')) === 'private application prose'
            && !(await fs.promises.readdir(path.dirname(privateSave))).some(name => name.startsWith('.ic-recovery-rebind-')),
          `${store} save/delete/edit must fail before mutating data, journals, or disk`);
        }
        assert(trashCalls === 0, 'private records must never reach the OS trash operation');
        return { storesBlocked: stores.length, normalScan: normalScan.type };
      } finally {
        electronPkg.shell.trashItem = originalTrash;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career staging: only an identity-bound host capability can read private staged md and txt inputs',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.career-host-stage-capability-'));
      const sourceDirectory = path.join(root, 'public-inputs');
      const stagingRoot = path.join(root, 'career-input-staging');
      let staged = null;
      try {
        await fs.promises.mkdir(sourceDirectory, { recursive: true });
        const sources = [
          path.join(sourceDirectory, 'profile.md'),
          path.join(sourceDirectory, 'notes.txt'),
        ];
        await Promise.all([
          fs.promises.writeFile(sources[0], '# Candidate\n- Markdown input\n'),
          fs.promises.writeFile(sources[1], 'Plain text input\n'),
        ]);
        staged = await __stageCareerInputFilesForTests(sources, { stagingRoot });
        const forged = {
          directory: staged.directory,
          stagedPaths: [...staged.stagedPaths],
          sourceNames: [...staged.sourceNames],
          descriptors: [...staged.descriptors],
          cleanup: staged.cleanup,
        };
        assert(await rejects(() => __assertOwnedStagedCareerAttachmentForTests(forged, staged.stagedPaths[0])),
          'a renderer-shaped clone cannot forge the module-private staged-run capability');
        assert(await rejects(() => __assertOwnedStagedCareerAttachmentForTests(staged, sources[0])),
          'the capability admits only exact host-created staged paths, never original renderer paths');
        assert(await rejects(() => __readOwnedStagedCareerAttachmentForTests(forged, staged.stagedPaths[1], 'utf8')),
          'a forged clone cannot read the staged bytes either');
        const readBack = await __readOwnedStagedCareerAttachmentForTests(staged, staged.stagedPaths[1], 'utf8');
        assert(readBack === 'Plain text input\n', 'direct host reads of staged text remain identity-bound');
        return { rendererForgeryRejected: true };
      } finally {
        await staged?.cleanup?.();
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career staging: renderer input admission rejects registered userData, hard-link aliases, and lstat-to-open replacements before bytes are copied',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.career-source-admission-'));
      const userData = path.join(root, 'host-user-data');
      const privateDirectory = path.join(userData, 'browser-data');
      const stagingRoot = path.join(root, 'career-input-staging');
      const publicSource = path.join(root, 'public-resume.md');
      const hardlinkAlias = path.join(root, 'ordinary-looking-hardlink.md');
      const symlinkAlias = path.join(root, 'ordinary-looking-symlink.md');
      const replacementPrivate = path.join(privateDirectory, 'replacement.md');
      const parkedPublic = path.join(root, 'public-resume-parked.md');
      const postOpenPublic = path.join(root, 'post-open-public.md');
      const postOpenPrivate = path.join(privateDirectory, 'post-open-private.md');
      const parkedPostOpenPublic = path.join(root, 'post-open-public-parked.md');
      const originalGetPath = electronPkg.app.getPath;
      try {
        await fs.promises.mkdir(privateDirectory, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(path.join(privateDirectory, 'private.md'), 'private career source'),
          fs.promises.writeFile(replacementPrivate, 'private replacement source'),
          fs.promises.writeFile(publicSource, 'public career source'),
          fs.promises.writeFile(postOpenPrivate, 'private post-open replacement'),
          fs.promises.writeFile(postOpenPublic, 'public source held open'),
        ]);
        electronPkg.app.getPath = name => name === 'userData' ? userData : originalGetPath(name);
        const privateSource = path.join(privateDirectory, 'private.md');
        const genericUnknownUserDataDenied = await rejects(() => callLLMVision([privateSource], 'generic deny', {
          task: 'vision-product-analysis', responseSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        }));
        let privateAdmissionError = null;
        try { await __stageCareerInputFilesForTests([privateSource], { stagingRoot }); } catch (error) { privateAdmissionError = error; }
        let finalFencePrivateError = null;
        try {
          await __assertCareerInputDescriptorsStillMatchForTests([privateSource], [{
            name: 'private.md', contentHash: createHash('sha256').update('private career source').digest('hex'),
          }]);
        } catch (error) { finalFencePrivateError = error; }
        await fs.promises.link(privateSource, hardlinkAlias);
        let hardlinkError = null;
        try { await __stageCareerInputFilesForTests([hardlinkAlias], { stagingRoot }); } catch (error) { hardlinkError = error; }
        const genericHardlinkDenied = await rejects(() => callLLMVision([hardlinkAlias], 'generic hardlink deny', {
          task: 'vision-product-analysis', responseSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        }));
        let genericSymlinkDenied = true;
        try {
          await fs.promises.symlink(privateSource, symlinkAlias);
          genericSymlinkDenied = await rejects(() => callLLMVision([symlinkAlias], 'generic symlink deny', {
            task: 'vision-product-analysis', responseSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
          }));
        } catch (error) {
          if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
        }
        let replacementError = null;
        try {
          await __stageCareerInputFilesForTests([publicSource], {
            stagingRoot,
            afterSourceInspection: async () => {
              await fs.promises.rename(publicSource, parkedPublic);
              await fs.promises.rename(replacementPrivate, publicSource);
            },
          });
        } catch (error) { replacementError = error; }
        // Restore the test names after proving the source descriptor was never
        // read through the substituted private inode.
        if (fs.existsSync(publicSource)) await fs.promises.rename(publicSource, replacementPrivate);
        if (fs.existsSync(parkedPublic)) await fs.promises.rename(parkedPublic, publicSource);
        let postOpenReplacementError = null;
        try {
          await __stageCareerInputFilesForTests([postOpenPublic], {
            stagingRoot,
            afterSourceOpen: async () => {
              await fs.promises.rename(postOpenPublic, parkedPostOpenPublic);
              await fs.promises.rename(postOpenPrivate, postOpenPublic);
            },
          });
        } catch (error) { postOpenReplacementError = error; }
        if (fs.existsSync(postOpenPublic)) await fs.promises.rename(postOpenPublic, postOpenPrivate);
        if (fs.existsSync(parkedPostOpenPublic)) await fs.promises.rename(parkedPostOpenPublic, postOpenPublic);
        const stagedEntries = (await fs.promises.readdir(stagingRoot).catch(() => []))
          .filter(name => name.startsWith('run-'));
        assert(isRendererSensitivePath(privateSource)
          && privateAdmissionError?.code === 'CAREER_INPUT_PRIVATE_PATH'
          && genericUnknownUserDataDenied
          && finalFencePrivateError?.code === 'CAREER_INPUT_PRIVATE_PATH'
          && hardlinkError?.code === 'CAREER_INPUT_HARDLINK_UNSUPPORTED'
          && genericHardlinkDenied && genericSymlinkDenied
          && replacementError?.code === 'CAREER_INPUT_CHANGED'
          && ['CAREER_INPUT_PRIVATE_PATH', 'CAREER_INPUT_CHANGED'].includes(postOpenReplacementError?.code)
          && stagedEntries.length === 0
          && (await fs.promises.readFile(replacementPrivate, 'utf8')) === 'private replacement source'
          && (await fs.promises.readFile(postOpenPrivate, 'utf8')) === 'private post-open replacement',
        'registered app-private originals are rejected before metadata probes, hard links are rejected before reads, and replacements before or after descriptor open lose before any private byte reaches a staged run');
        return { privateAdmission: true, genericUnknownUserDataDenied, genericHardlinkDenied, genericSymlinkDenied, hardlinkRejected: true, replacementRejected: true, postOpenReplacementRejected: true };
      } finally {
        electronPkg.app.getPath = originalGetPath;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'delete survivor protection rejects private hints before identity inspection and leaves ordinary targets untouched',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(process.cwd(), '.private-delete-survivor-'));
      const userData = path.join(root, 'host-user-data');
      const privateSurvivor = path.join(userData, 'browser-data', 'secret.json');
      const ordinary = path.join(root, 'ordinary.txt');
      const originalGetPath = electronPkg.app.getPath;
      const originalTrash = electronPkg.shell.trashItem;
      try {
        await fs.promises.mkdir(path.dirname(privateSurvivor), { recursive: true });
        await Promise.all([
          fs.promises.writeFile(privateSurvivor, 'private survivor'),
          fs.promises.writeFile(ordinary, 'ordinary target'),
        ]);
        electronPkg.app.getPath = name => name === 'userData' ? userData : originalGetPath(name);
        electronPkg.ipcMain.__clearInvokeHandlers();
        registerFilesystemHandlers();
        let trashCalls = 0;
        electronPkg.shell.trashItem = async () => { trashCalls += 1; };
        const remove = electronPkg.ipcMain.__getInvokeHandler('delete-os-file');
        const privateHint = await remove(eventForTest(), { filePath: ordinary, protectedPaths: [privateSurvivor] });
        const ancestorHint = await remove(eventForTest(), { filePath: ordinary, protectedPaths: [userData] });
        let privateInspectorTouches = 0;
        let directError = null;
        try {
          await assertDeleteTargetNotRepresented(ordinary, [privateSurvivor], {
            validate: async candidate => candidate,
            assertRendererPathAllowed: async () => {},
            assertDeletePathDoesNotContainPrivateRoots: async () => {},
            lstat: async candidate => {
              if (candidate === privateSurvivor) privateInspectorTouches += 1;
              return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, dev: 1, ino: 1 };
            },
            realpath: async candidate => candidate,
          });
        } catch (error) { directError = error; }
        assert(!privateHint.success && privateHint.errorCode === 'OS_DELETE_PROTECTED'
          && !ancestorHint.success && ancestorHint.errorCode === 'OS_DELETE_PROTECTED'
          && privateInspectorTouches === 0 && directError?.code === 'OS_DELETE_PROTECTED'
          && trashCalls === 0 && (await fs.promises.readFile(privateSurvivor, 'utf8')) === 'private survivor',
        'renderer-provided private or ancestor survivor hints are rejected before lstat/realpath and cannot expose metadata or trigger OS trash');
        return { privateHintBlocked: true, ancestorHintBlocked: true, inspectorOracleClosed: true };
      } finally {
        electronPkg.app.getPath = originalGetPath;
        electronPkg.shell.trashItem = originalTrash;
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'interview private stores: a renderer-named canvas file inside app-private data cannot anchor an application export',
    run: async () => {
      const { assertRendererCanvasFilePathAllowed, registerJobApplicationHandlers, registerPendingApplicationWorkspace } = await import('../../electron/ipc/jobApplication.js');
      const userData = electronPkg.app.getPath('userData');
      for (const candidate of [
        path.join(userData, 'interview-helper-artifacts', 'canvas.json'),
        path.join(userData, 'canvas.json'),
        path.join(userData, 'career-snapshot-store', 'nested', 'canvas.json'),
      ]) {
        assert(await rejects(async () => assertRendererCanvasFilePathAllowed(candidate)), `${candidate} must be refused as an export anchor`);
      }
      // os.tmpdir() sits under /var on macOS, which the system policy treats as
      // sensitive; a saved canvas lives in user space, modelled here by /tmp.
      const root = await fs.promises.realpath(await fs.promises.mkdtemp('/tmp/ic-interview-export-anchor-'));
      try {
        assertRendererCanvasFilePathAllowed(path.join(root, 'canvas.json'));
        // macOS temp folders live under /var, which the system-path policy
        // refuses; only app-private data may be refused here.
        assertRendererCanvasFilePathAllowed('/private/var/folders/aa/bbbbbb/T/canvas.json');
        assertRendererCanvasFilePathAllowed('/var/folders/aa/bbbbbb/T/Applied Jobs/canvas.json');
        const sourceDir = path.join(root, 'source');
        const outputRoot = path.join(root, 'applications');
        await fs.promises.mkdir(sourceDir, { recursive: true });
        await fs.promises.mkdir(outputRoot, { recursive: true });
        const resumeHtml = '<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">Resume</main></section><section data-ic-document-panel="cover"><main class="page">Cover</main></section><script id="ic-application-bundle-data" type="application/json">{}</script></body></html>';
        const jobListing = '# Role\n\nListing.\n';
        const resumeHtmlPath = path.join(sourceDir, 'Application.html');
        const jobListingPath = path.join(sourceDir, 'Original Job Listing.md');
        await fs.promises.writeFile(resumeHtmlPath, resumeHtml);
        await fs.promises.writeFile(jobListingPath, jobListing);
        registerJobApplicationHandlers();
        const saveApplication = electronPkg.ipcMain.__getInvokeHandler('save-application');
        assert(typeof saveApplication === 'function', 'the save-application handler must be registered');
        const sender = { id: 4242, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {} };
        registerPendingApplicationWorkspace({
          workDir: sourceDir, senderId: sender.id, company: 'Anchor Co', applicationRoot: outputRoot,
          resumeHtmlPath, jobListingPath, cleanupOnDiscard: false, cleanupOnSaveFailure: false,
          artifactData: { resumeHtml, jobListing },
        });
        const result = await saveApplication({ sender }, {
          resumeHtmlPath, resumePdfPath: null, coverLetterPdfPath: null, jobListingPath,
          generationAuditPath: null, generationLogPath: null, workDir: sourceDir,
          jobTitle: 'Role', location: 'Toronto, ON',
          canvasFilePath: path.join(userData, 'interview-helper-artifacts', 'canvas.json'), suppressReveal: true,
        });
        assert(result && result.success === false && /private application data/u.test(result.error || ''),
          `save-application must refuse a private canvas anchor before any destination work, got ${JSON.stringify(result)}`);
        assert((await fs.promises.readdir(outputRoot)).length === 0, 'no export directory may be created for a refused anchor');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
];
