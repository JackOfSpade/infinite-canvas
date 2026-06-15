/**
 * Filesystem IPC handlers — scan directories, open files/URLs, save/load workspaces.
 */
import electronPkg from 'electron';
const { shell, dialog } = electronPkg;
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import {
  rememberMissingPreviewSearchRoot,
  resolveMissingPreviewPath,
} from './missingPreviewRelink.js';
import { isProductImageExtension } from '../../src/utils/fileExtensions.js';

/**
 * Global registry of active file watchers.
 * key: filePath
 * value: { watcher: FSWatcher, clients: Map<WebContents, number> }
 *   where clients map tracks how many times a specific renderer window has requested this path.
 */
const activeWatchers = new Map();

/**
 * Module-level recursive directory scanner.
 * Uses lstat to detect symlinks and a `visited` realpath set to prevent loops.
 *
 * The walk is strictly sequential — children are awaited one at a time in the
 * for-loop below, so at most one readdir/lstat is ever in flight. A previous
 * activeScans/MAX_SCAN_CONCURRENCY busy-wait gate was removed: with sequential
 * recursion `activeScans` only ever equaled the current depth, so on any tree
 * deeper than the core count every live frame held a slot while awaiting its
 * single descendant and the gate could never drain — a hard deadlock (the only
 * escape was closing the window). Being serial, the scan needs no EMFILE bound.
 */
async function scanPath(currentPath, visited, sender = null, depth = 0) {
  // Prevent infinite recursion from symlink loops or massive trees
  if (depth > 15) return null;

  // Guard: Abort recursion if the window that requested it was closed
  if (sender && sender.isDestroyed()) return null;

  try {
    let realPath = currentPath;
    try { realPath = await fs.promises.realpath(currentPath); } catch { /* ignore */ }
    if (visited.has(realPath)) return null;
    visited.add(realPath);

    // Skip notoriously large or transient directories/files to prevent thread lock/pollution
    const base = path.basename(currentPath);
    if (base === 'node_modules' || base === '.git' || base === '.DS_Store' || base.endsWith('.tmp')) return null;

    // Use lstat to handle symlinks correctly (don't blindly follow if we've seen the path)
    const stats = await fs.promises.lstat(currentPath);
    
    if (stats.isDirectory()) {
      const dirItems = await fs.promises.readdir(currentPath);
      
      // Process sub-directories sequentially or in small batches to preserve concurrency limit
      const children = [];
      for (const item of dirItems) {
        const child = await scanPath(path.join(currentPath, item), visited, sender, depth + 1);
        if (child) children.push(child);
        if (sender && sender.isDestroyed()) return null;
      }
      
      return {
        id: 'group-' + randomUUID(),
        type: 'group',
        title: base || currentPath,
        filePath: currentPath,
        collapsed: true,
        items: children,
      };
    }
    
    return {
      id: 'doc-' + randomUUID(),
      type: 'document',
      filename: base,
      filePath: currentPath,
    };
  } catch (err) {
    // Possible edge case: file deleted between readdir and lstat
    logger.warn(`[Filesystem] Skipping inaccessible path: ${currentPath}`, err?.message || String(err));
    return null;
  }
}

/**
 * Helper to perform an atomic write (write to tmp then rename).
 */
async function atomicWriteFile(targetPath, data) {
  let finalPath = targetPath;
  try {
    // Resolve symlinks so we write to the actual destination, preserving the link structure
    finalPath = await fs.promises.realpath(targetPath);
  } catch {
    // If realpath fails (e.g. file doesn't exist yet), use targetPath as-is
  }

  const tmpPath = `${finalPath}.__ic_atomic_${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, data, 'utf-8');
    await fs.promises.rename(tmpPath, finalPath);
  } catch (err) {
    // Clean up tmp file if write succeeded but rename failed
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Helper to construct the sidecar path for a given canvas path.
 */
function getSidecarPath(filePath) {
  return filePath.endsWith('.json') ? filePath.slice(0, -5) + '.progress.json' : filePath + '.progress.json';
}

/**
 * Record the canvas file's identity (inode + device) on the renderer's
 * WebContents after a load or save. A rename preserves the inode, so this is the
 * fingerprint we use later to recognise the same file under a new name. Must be
 * called *after* any write — atomicWriteFile renames a temp over the target, so
 * the canvas inode changes on every save. Best-effort; ino==0 filesystems opt out.
 */
function rememberCanvasInode(sender, filePath) {
  try {
    const st = fs.statSync(filePath);
    if (sender && !sender.isDestroyed?.() && st.ino) {
      sender.__canvasInode = { ino: st.ino, dev: st.dev };
      sender.__canvasPath = filePath;
      ensureCanvasWatcher(sender, filePath);
    }
  } catch { /* best-effort; reconciliation simply won't trigger */ }
}

/**
 * The path the renderer hands us for a save is whatever it last knew. If the user
 * renamed the canvas in Finder while the app held it open, that path is stale: an
 * atomic write would resurrect the OLD name (recreating e.g. canvas.json next to
 * their renamed file) and silently split further edits — and every job sidecar —
 * across two files. A rename keeps the inode, so when the known path no longer
 * resolves to the inode we recorded, scan its directory for whoever now carries
 * it and follow the file to its new name. Returns the original path unchanged when
 * nothing was recorded, the file is untouched, or the inode can't be found (the
 * file was deleted or moved out of the directory — there's nowhere to follow it).
 *
 * ONLY the window's own canvas path is reconciled. A save aimed at any OTHER
 * path is an explicit retarget (a new file / programmatic write), and "requested
 * path missing + our inode lives elsewhere in that directory" describes that
 * case just as well as a Finder rename — following the inode there hijacks the
 * NEW file's contents into the PREVIOUSLY-saved canvas (the new path is never
 * created and the old file is silently overwritten; observed when two saves to
 * different names in one directory came from the same window).
 */
async function reconcileRenamedCanvas(sender, knownPath) {
  const tracked = sender?.__canvasInode;
  if (!tracked?.ino) return knownPath;
  if (!sender.__canvasPath || path.resolve(sender.__canvasPath) !== path.resolve(knownPath)) {
    return knownPath; // saving somewhere other than "the canvas" — honor it verbatim
  }
  try {
    const st = await fs.promises.stat(knownPath);
    if (st.ino === tracked.ino && st.dev === tracked.dev) return knownPath;
  } catch { /* knownPath is gone — fall through to the inode search */ }

  const dir = path.dirname(knownPath);
  let entries;
  try { entries = await fs.promises.readdir(dir); } catch { return knownPath; }
  for (const name of entries) {
    const candidate = path.join(dir, name);
    try {
      const st = await fs.promises.stat(candidate);
      if (st.ino === tracked.ino && st.dev === tracked.dev) {
        logger.info(`[FileSystem] Canvas renamed on disk: ${knownPath} → ${candidate} (followed by inode)`);
        return candidate;
      }
    } catch { /* unreadable entry — skip */ }
  }
  return knownPath;
}

/**
 * Per-renderer watcher that closes the rename "sliver" save-time reconciliation
 * leaves open: a save only fires on the next write, so a job action triggered
 * right after a Finder rename (no intervening edit/autosave) would still use the
 * old base name. Watching the canvas's *directory* — which survives the rename,
 * unlike a watch on the file itself — lets us follow the rename eagerly and push
 * the new path to the renderer, so currentFile (and every sidecar derived from
 * it) corrects at once instead of waiting for the next save.
 */
const canvasWatchers = new Map(); // WebContents -> { watcher, dir, timer }

function stopCanvasWatcher(sender) {
  const entry = canvasWatchers.get(sender);
  if (!entry) return;
  clearTimeout(entry.timer);
  try { entry.watcher.close(); } catch { /* ignore */ }
  canvasWatchers.delete(sender);
}

function ensureCanvasWatcher(sender, filePath) {
  const dir = path.dirname(filePath);
  const existing = canvasWatchers.get(sender);
  if (existing && existing.dir === dir) return; // already watching the right directory
  stopCanvasWatcher(sender);

  let watcher;
  try {
    watcher = fs.watch(dir, () => {
      const entry = canvasWatchers.get(sender);
      if (!entry) return;
      // A rename emits a burst of events; coalesce them and reconcile once.
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { handleCanvasDirChange(sender).catch(() => {}); }, 250);
    });
  } catch (err) {
    logger.warn(`[FileSystem] Could not watch canvas directory ${dir}:`, err);
    return;
  }
  watcher.on('error', (err) => {
    logger.warn(`[FileSystem] Canvas watcher error for ${dir}:`, err);
    stopCanvasWatcher(sender);
  });
  canvasWatchers.set(sender, { watcher, dir, timer: null });

  if (!sender.__canvasWatchCleanup) {
    sender.__canvasWatchCleanup = true;
    sender.once('destroyed', () => stopCanvasWatcher(sender));
  }
}

async function handleCanvasDirChange(sender) {
  if (!sender || sender.isDestroyed?.()) return;
  const knownPath = sender.__canvasPath;
  if (!knownPath) return;
  const resolved = await reconcileRenamedCanvas(sender, knownPath);
  if (resolved === knownPath) return; // unchanged, or the rename couldn't be located — nothing to do
  rememberCanvasInode(sender, resolved); // re-fingerprint at the new name (same dir → watcher unchanged)
  if (!sender.isDestroyed()) sender.send('canvas:file-renamed', resolved);
  logger.info(`[FileSystem] Canvas followed on-disk rename, notified renderer → ${resolved}`);
}

function relativePortablePath(canvasPath, filePath) {
  if (!canvasPath || !filePath || typeof filePath !== 'string') return null;
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(path.dirname(canvasPath), filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.includes(path.sep) ? rel : `.${path.sep}${rel}`;
}

function resolvePortablePath(canvasPath, filePath, relativePath) {
  const baseDir = path.dirname(canvasPath);
  if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) return filePath;
  if (filePath && typeof filePath === 'string') {
    const candidate = path.join(baseDir, path.basename(filePath));
    if (fs.existsSync(candidate)) return candidate;
  }
  if (relativePath && typeof relativePath === 'string') {
    const candidate = path.resolve(baseDir, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return filePath;
}

function isWithinDirectory(rootDir, candidatePath) {
  if (!rootDir || !candidatePath) return false;
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isImagePath(filePath) {
  return typeof filePath === 'string' && isProductImageExtension(path.extname(filePath));
}

export function resolvePortableImagePath(canvasPath, filePath, relativePath) {
  const baseDir = path.dirname(canvasPath);
  const absoluteCandidate = typeof filePath === 'string' && filePath.length > 0
    ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath))
    : null;
  const relativeCandidate = typeof relativePath === 'string' && relativePath.length > 0
    ? path.resolve(baseDir, relativePath)
    : null;
  const safeRelativeCandidate = isWithinDirectory(baseDir, relativeCandidate) ? relativeCandidate : null;

  // Prefer the exact stored path, then the exact portable relative path. While
  // each still exists, register the hierarchy the local-file protocol should
  // search if the image is moved later in this session.
  if (absoluteCandidate && isExistingFile(absoluteCandidate)) {
    const searchRoot = isWithinDirectory(baseDir, absoluteCandidate)
      ? baseDir
      : path.dirname(absoluteCandidate);
    rememberMissingPreviewSearchRoot(absoluteCandidate, searchRoot);
    return absoluteCandidate;
  }
  if (safeRelativeCandidate && isExistingFile(safeRelativeCandidate)) {
    rememberMissingPreviewSearchRoot(safeRelativeCandidate, baseDir);
    return safeRelativeCandidate;
  }

  const missingPath = safeRelativeCandidate || absoluteCandidate;
  if (!missingPath) return filePath;

  // Workspace-contained images search from the workspace folder down. External
  // images search from their own original folder down. Neither path may broaden
  // upward to a parent folder.
  const belongsToWorkspaceHierarchy = !!safeRelativeCandidate || isWithinDirectory(baseDir, missingPath);
  const searchRoot = belongsToWorkspaceHierarchy ? baseDir : path.dirname(missingPath);
  rememberMissingPreviewSearchRoot(missingPath, searchRoot);
  const relink = resolveMissingPreviewPath(missingPath, { searchRoot });

  if (relink.status === 'found') {
    rememberMissingPreviewSearchRoot(relink.path, searchRoot);
    if (!relink.cached) {
      logger.info(`[FileSystem] Relinked missing preview image within current hierarchy: ${missingPath} → ${relink.path} (root ${relink.root}, scanned ${relink.entriesScanned} entries)`);
    }
    return relink.path;
  }
  if (!relink.cached && (relink.status === 'ambiguous' || relink.status === 'limit')) {
    logger.warn(`[FileSystem] Could not relink missing preview image (${relink.status}) within ${relink.root}: ${missingPath} (scanned ${relink.entriesScanned} entries)`);
  }
  return missingPath;
}

function traverseCanvasNodes(nodes, fn) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    fn(node);
    if (node?.type === 'group' && node.data?.canvasData?.nodes) {
      traverseCanvasNodes(node.data.canvasData.nodes, fn);
    }
  }
}

function annotatePortableFilePaths(data, canvasPath) {
  traverseCanvasNodes(data?.nodes, (node) => {
    const d = node?.data;
    if (!d) return;

    const rel = relativePortablePath(canvasPath, d.filePath);
    if (rel) d.relativeFilePath = rel;
    else delete d.relativeFilePath;
    if (typeof d.filePath === 'string' && path.isAbsolute(d.filePath) && isImagePath(d.filePath)) {
      rememberMissingPreviewSearchRoot(
        d.filePath,
        rel ? path.dirname(canvasPath) : path.dirname(d.filePath),
      );
    }

    if (Array.isArray(d.imagePaths)) {
      d.relativeImagePaths = d.imagePaths.map((p) => {
        const rel = relativePortablePath(canvasPath, p);
        if (typeof p === 'string' && path.isAbsolute(p)) {
          rememberMissingPreviewSearchRoot(p, rel ? path.dirname(canvasPath) : path.dirname(p));
        }
        return rel;
      });
      if (!d.relativeImagePaths.some(Boolean)) delete d.relativeImagePaths;
    } else {
      delete d.relativeImagePaths;
    }
  });
}

export function resolvePortableFilePaths(data, canvasPath) {
  traverseCanvasNodes(data?.nodes, (node) => {
    const d = node?.data;
    if (!d) return;

    if (d.filePath) {
      d.filePath = isImagePath(d.filePath) || isImagePath(d.filename)
        ? resolvePortableImagePath(canvasPath, d.filePath, d.relativeFilePath)
        : resolvePortablePath(canvasPath, d.filePath, d.relativeFilePath);
      const rel = relativePortablePath(canvasPath, d.filePath);
      if (rel) d.relativeFilePath = rel;
      else delete d.relativeFilePath;
    }

    if (Array.isArray(d.imagePaths)) {
      d.imagePaths = d.imagePaths.map((p, i) => resolvePortableImagePath(canvasPath, p, d.relativeImagePaths?.[i]));
      const rels = d.imagePaths.map(p => relativePortablePath(canvasPath, p));
      if (rels.some(Boolean)) d.relativeImagePaths = rels;
      else delete d.relativeImagePaths;
    }
  });
}

/**
 * Extracts volatile transient/paused state from the nodes array and returns it,
 * while stripping the transient keys and resetting states in the original nodes
 * array (mutating it).
 */
function extractSidecarData(nodes) {
  const hubs = [];
  const cards = [];

  const traverseAndExtract = (nodeList) => {
    if (!Array.isArray(nodeList)) return;
    for (const n of nodeList) {
      if (n.type === 'jobhub' && n.data?.hubState === 'sources-ready') {
        const d = n.data;
        hubs.push({
          id: n.id,
          hubState: d.hubState,
          scrapeWarnings: d.scrapeWarnings,
          pendingJobs: d.pendingJobs,
          pendingTargetRole: d.pendingTargetRole,
          errorMessage: d.errorMessage,
          isRateLimit: d.isRateLimit,
        });
        
        // Strip transient/paused fields from main file data
        d.hubState = 'empty';
        delete d.scrapeWarnings;
        delete d.pendingJobs;
        delete d.pendingTargetRole;
        delete d.errorMessage;
        delete d.isRateLimit;
      } else if (n.type === 'jobsourcecard' && n.data?.persistedProgress) {
        cards.push({
          id: n.id,
          persistedProgress: n.data.persistedProgress,
        });
        
        // Strip transient/paused progress from main file data
        delete n.data.persistedProgress;
      }
      
      if (n.type === 'group' && n.data?.canvasData?.nodes) {
        traverseAndExtract(n.data.canvasData.nodes);
      }
    }
  };

  traverseAndExtract(nodes);
  return { hubs, cards };
}

/**
 * Merges saved transient/paused sidecar states back into the matching nodes.
 */
function mergeSidecarData(nodes, sidecarData) {
  if (!sidecarData) return;
  const hubsMap = new Map((sidecarData.hubs || []).map(h => [h.id, h]));
  const cardsMap = new Map((sidecarData.cards || []).map(c => [c.id, c]));

  const traverseAndMerge = (nodeList) => {
    if (!Array.isArray(nodeList)) return;
    for (const n of nodeList) {
      if (n.type === 'jobhub' && hubsMap.has(n.id)) {
        const sidecarHub = hubsMap.get(n.id);
        n.data = n.data || {};
        n.data.hubState = sidecarHub.hubState || 'sources-ready';
        if (sidecarHub.scrapeWarnings !== undefined) n.data.scrapeWarnings = sidecarHub.scrapeWarnings;
        if (sidecarHub.pendingJobs !== undefined) n.data.pendingJobs = sidecarHub.pendingJobs;
        if (sidecarHub.pendingTargetRole !== undefined) n.data.pendingTargetRole = sidecarHub.pendingTargetRole;
        if (sidecarHub.errorMessage !== undefined) n.data.errorMessage = sidecarHub.errorMessage;
        if (sidecarHub.isRateLimit !== undefined) n.data.isRateLimit = sidecarHub.isRateLimit;
      } else if (n.type === 'jobsourcecard' && cardsMap.has(n.id)) {
        const sidecarCard = cardsMap.get(n.id);
        n.data = n.data || {};
        if (sidecarCard.persistedProgress !== undefined) n.data.persistedProgress = sidecarCard.persistedProgress;
      }

      if (n.type === 'group' && n.data?.canvasData?.nodes) {
        traverseAndMerge(n.data.canvasData.nodes);
      }
    }
  };

  traverseAndMerge(nodes);
}

export function registerFilesystemHandlers() {
  handleSafe('scan-directory', async (event, dirPath) => {
    const visited = new Set();
    const result = await scanPath(dirPath, visited, event.sender);
    
    if (!result) throw new Error('Directory skip or unreadable');
    return result.type === 'document' ? { isFile: true, file: result } : result;
  });

  handleSafe('open-file', async (_event, filePath) => {
    // Security Guard: Prevent opening executable or sensitive system files via the OS shell
    const ext = path.extname(filePath).toLowerCase();
    const blockedExts = ['.exe', '.sh', '.bat', '.cmd', '.msi', '.app', '.com', '.vbs', '.js', '.jse', '.wsf', '.wsh', '.ps1'];
    if (blockedExts.includes(ext)) {
      throw new Error('Opening executable files is restricted for security reasons.');
    }
    
    // Additional Guard: Ensure the file actually exists before asking the shell to handle it
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
    
    const err = await shell.openPath(filePath);
    if (err) throw new Error(err);
  });

  handleSafe('open-external', async (_event, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Invalid protocol: ${parsed.protocol}. Only http and https are allowed for external links.`);
    }
    await shell.openExternal(url);
  });

  handleSafe('save-workspace', async (event, args) => {
    const { data, filePath } = args;
    let targetPath = filePath;
    if (!targetPath) {
      const { canceled, filePath: dialogPath } = await dialog.showSaveDialog({
        title: 'Save Canvas',
        defaultPath: 'canvas.json',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });
      if (canceled || !dialogPath) return { canceled: true };
      targetPath = dialogPath;
    } else {
      // Follow a Finder rename so autosave writes to the renamed file instead of
      // resurrecting the old name. The renderer adopts the returned filePath, so
      // currentFile — and every job sidecar derived from it — self-corrects.
      targetPath = await reconcileRenamedCanvas(event.sender, targetPath);
    }

    // The renderer-side sanitizer already preserves actionable paused state
    // directly on the nodes we keep. Re-embedding job progress into a top-level
    // transientProgress blob caused it to be written back on every save, which
    // then replayed on every reload. Keep load-time migration for legacy files,
    // but stop generating fresh embedded progress on save.
    delete data.transientProgress;
    annotatePortableFilePaths(data, targetPath);

    // Delete legacy separate sidecar progress file if present
    try {
      const sidecarPath = getSidecarPath(targetPath);
      if (fs.existsSync(sidecarPath)) {
        await fs.promises.unlink(sidecarPath);
        logger.info(`[FileSystem] Cleaned up legacy separate progress sidecar: ${sidecarPath}`);
      }
    } catch { /* ignore */ }

    // Production Hardening: Use atomic write to prevent data corruption
    await atomicWriteFile(targetPath, JSON.stringify(data));

    // Re-fingerprint: the atomic rename gave the canvas a fresh inode, so record
    // it now to recognise this exact file if it's renamed before the next save.
    rememberCanvasInode(event.sender, targetPath);

    // Background cleanup of any orphaned .tmp files in this specific directory
    cleanupTempFiles(path.dirname(targetPath)).catch(err => logger.warn('Save cleanup failed:', err));

    return { filePath: targetPath };
  });

  handleSafe('load-workspace', async (event, opts) => {
    let targetPath = opts?.filePath;
    
    if (!targetPath) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Open Canvas',
        properties: ['openFile'],
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });
      if (canceled || filePaths.length === 0) return { canceled: true };
      targetPath = filePaths[0];
    }

    if (!fs.existsSync(targetPath)) throw new Error('File does not exist');
    
    const stats = fs.statSync(targetPath);
    if (stats.size === 0) throw new Error('Workspace file is empty (0 bytes)');
    // Static safety bound (not adaptive): a workspace JSON larger than this would
    // OOM the V8 string parser on read. Fixed by design.
    const MAX_WORKSPACE_BYTES = 100 * 1024 * 1024; // 100MB
    if (stats.size > MAX_WORKSPACE_BYTES) throw new Error(`Workspace file is excessively large (${(stats.size/1024/1024).toFixed(2)}MB). Limit is 100MB.`);

    const content = await fs.promises.readFile(targetPath, 'utf-8');
    try {
      const data = JSON.parse(content);
      resolvePortableFilePaths(data, targetPath);
      logger.info(`[FileSystem] Loaded workspace: ${targetPath} (${stats.size} bytes)`);

      // Clean up legacy separate progress sidecar file if it exists
      try {
        const sidecarPath = getSidecarPath(targetPath);
        if (fs.existsSync(sidecarPath)) {
          try {
            const sidecarContent = await fs.promises.readFile(sidecarPath, 'utf-8');
            const sidecarData = JSON.parse(sidecarContent);
            mergeSidecarData(data.nodes || [], sidecarData);
            logger.info(`[FileSystem] Migrated and merged legacy progress sidecar data from ${sidecarPath}`);
          } catch (err) {
            logger.error(`[FileSystem] Failed to parse legacy sidecar data: ${sidecarPath}`, err);
          }
          await fs.promises.unlink(sidecarPath);
          logger.info(`[FileSystem] Deleted legacy progress sidecar file: ${sidecarPath}`);
        }
      } catch { /* ignore */ }

      // Check for embedded transientProgress
      if (data.transientProgress) {
        const sidecarData = data.transientProgress;
        // Merge progress back into the nodes for V8/React Flow memory
        mergeSidecarData(data.nodes || [], sidecarData);
        logger.info('[FileSystem] Restored embedded transient progress into React Flow memory nodes');
        
        // Immediately delete/strip the saved state from the file on disk
        delete data.transientProgress;
        
        try {
          const cleanData = JSON.parse(JSON.stringify(data));
          // Strip nodes in cleanData so the disk copy is fully clean
          extractSidecarData(cleanData.nodes || []);
          delete cleanData.transientProgress;
          
          await atomicWriteFile(targetPath, JSON.stringify(cleanData));
          logger.info(`[FileSystem] Immediately deleted saved transient progress from disk file: ${targetPath}`);
        } catch (err) {
          logger.error(`[FileSystem] Failed to write clean canvas to disk after loading: ${targetPath}`, err);
        }
      }
      
      // Cleanup any orphaned .tmp files left over from past crashes in this directory
      cleanupTempFiles(path.dirname(targetPath)).catch(err => logger.warn('Load cleanup failed:', err));

      // Fingerprint the file we just loaded so the next save can tell if it was
      // renamed underneath us. Done last: the transient-progress path above may
      // have atomically rewritten it, changing the inode.
      rememberCanvasInode(event.sender, targetPath);

      return { data, filePath: targetPath };
    } catch (jsonErr) {
      logger.error(`[FileSystem] Failed to parse workspace JSON at ${targetPath}:`, jsonErr);
      throw new Error('Invalid workspace file format. File may be corrupted or malformed.');
    }
  });

  handleSafe('start-file-watch', async (event, filePath) => {
    const sender = event.sender;

    // Helper: attach a one-time cleanup listener the first time this sender
    // appears in any entry of activeWatchers. This ensures the watcher is
    // properly torn down even if the sender subscribes to an already-active path.
    const ensureSenderCleanup = (s) => {
      if (s.__fsWatchCleanupAttached) return;
      s.__fsWatchCleanupAttached = true;
      s.once('destroyed', () => {
        for (const [fPath, entry] of activeWatchers.entries()) {
          if (entry.clients.has(s)) {
            entry.clients.delete(s);
            if (entry.clients.size === 0) {
              try { entry.watcher.close(); } catch { /* ignore */ }
              activeWatchers.delete(fPath);
            }
          }
        }
      });
    };

    if (activeWatchers.has(filePath)) {
      const entry = activeWatchers.get(filePath);
      const count = entry.clients.get(sender) || 0;
      entry.clients.set(sender, count + 1);
      ensureSenderCleanup(sender); // attach cleanup for this sender if not yet done
      return;
    }

    await fs.promises.access(filePath);

    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        const entry = activeWatchers.get(filePath);
        if (!entry) return;
        for (const [clientSender] of entry.clients) {
          if (!clientSender.isDestroyed()) {
            clientSender.send('file-changed', filePath);
          }
        }
      }
    });

    watcher.on('error', (err) => {
      logger.warn(`[FileSystem] Watcher error for ${filePath}:`, err);
      const entry = activeWatchers.get(filePath);
      if (entry) {
        try { entry.watcher.close(); } catch { /* ignore */ }
        activeWatchers.delete(filePath);
      }
    });

    const clients = new Map();
    clients.set(sender, 1);
    activeWatchers.set(filePath, { watcher, clients });
    ensureSenderCleanup(sender);
  });


  handleSafe('stop-file-watch', async (event, filePath) => {
    const sender = event.sender;
    const entry = activeWatchers.get(filePath);
    
    if (entry && entry.clients.has(sender)) {
      const current = entry.clients.get(sender);
      if (current <= 1) {
        entry.clients.delete(sender);
      } else {
        entry.clients.set(sender, current - 1);
      }

      if (entry.clients.size === 0) {
        activeWatchers.delete(filePath);
        try { if (entry.watcher) entry.watcher.close(); } catch { /* ignore */ }
      }
    }
  });

  handleSafe('delete-os-file', async (_event, filePath) => {
    await shell.trashItem(filePath);
  });

  handleSafe('write-text-file', async (_event, { filePath, content }) => {
    // Validate the file exists before writing — prevents accidentally creating new files
    await fs.promises.access(filePath, fs.constants.W_OK);
    await atomicWriteFile(filePath, content);
  });

  handleSafe('save-file-dialog', async (_event, { defaultFilename, content, filters }) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
      defaultPath: defaultFilename || 'export.txt',
      filters: filters || [{ name: 'Text Files', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { saved: false };
    await atomicWriteFile(filePath, content);
    return { saved: true, filePath };
  });
}

/**
 * Startup Cleanup Logic: Finds and deletes orphaned .tmp files left over from
 * previous sessions (atomic write failures or app crashes).
 *
 * @param {string} [targetDir] - Directory to scan. Defaults to process.cwd() in dev.
 */
const cleanedDirs = new Set();

// Module-private: invoked only from save-workspace / load-workspace below.
async function cleanupTempFiles(targetDir) {
  const dir = targetDir || process.cwd();
  
  // Logical proof: .tmp files are only orphaned if the ENTIRE process crashes. 
  // Any failed write during an active session cleans up its own .tmp file. 
  // Thus, sweeping a directory more than once per session is mathematically 
  // redundant and could cause severe I/O lag on network drives during auto-saves.
  if (cleanedDirs.has(dir)) return;
  cleanedDirs.add(dir);

  try {
    const files = await fs.promises.readdir(dir);
    // Explicitly target ONLY our own atomic files
    const tmpFiles = files.filter(f => f.includes('.__ic_atomic_') && f.endsWith('.tmp'));
    for (const f of tmpFiles) {
      try {
        const stats = await fs.promises.stat(path.join(dir, f));
        // Only delete if older than 1 hour (safety against concurrent writes from active run)
        if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
          await fs.promises.unlink(path.join(dir, f));
        }
      } catch { /* ignore */ }
    }
  } catch (err) {
    logger.warn('[Filesystem] Startup cleanup failed:', err?.message || String(err));
  }
}
