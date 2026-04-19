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

/**
 * Global registry of active file watchers.
 * key: filePath
 * value: { watcher: FSWatcher, clients: Map<WebContents, number> }
 *   where clients map tracks how many times a specific renderer window has requested this path.
 */
const activeWatchers = new Map();

/**
 * Module-level recursive directory scanner.
 * Uses lstat to detect symlinks and prevent recursion.
 * Hardened: Max 10 simultaneous directory reads to prevent EMFILE errors.
 */
let activeScans = 0;
const MAX_SCAN_CONCURRENCY = 10;

async function scanPath(currentPath, visited, sender = null, depth = 0) {
  // Prevent infinite recursion from symlink loops or massive trees
  if (depth > 15) return null;

  // Guard: Abort recursion if the window that requested it was closed
  if (sender && sender.isDestroyed()) return null;

  // Manage concurrency
  while (activeScans >= MAX_SCAN_CONCURRENCY) {
    await new Promise(r => setTimeout(r, 50));
    if (sender && sender.isDestroyed()) return null;
  }

  activeScans++;
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
  } finally {
    activeScans--;
  }
}

/**
 * Helper to perform an atomic write (write to tmp then rename).
 */
async function atomicWriteFile(targetPath, data) {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, data, 'utf-8');
    await fs.promises.rename(tmpPath, targetPath);
  } catch (err) {
    // Clean up tmp file if write succeeded but rename failed
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export function registerFilesystemHandlers() {
  handleSafe('scan-directory', async (event, dirPath) => {
    const visited = new Set();
    const result = await scanPath(dirPath, visited, event.sender);
    
    if (!result) throw new Error('Directory skip or unreadable');
    return result.type === 'document' ? { isFile: true, file: result } : result;
  });

  handleSafe('open-file', async (_event, filePath) => {
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

  handleSafe('save-workspace', async (_event, args) => {
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
    }
    // Production Hardening: Use atomic write to prevent data corruption
    await atomicWriteFile(targetPath, JSON.stringify(data));
    return { filePath: targetPath };
  });

  handleSafe('load-workspace', async (_event, opts) => {
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
    // Safety guard against massive files that would OOM the V8 string parser
    if (stats.size > 100 * 1024 * 1024) throw new Error(`Workspace file is excessively large (${(stats.size/1024/1024).toFixed(2)}MB). Limit is 100MB.`);

    const content = await fs.promises.readFile(targetPath, 'utf-8');
    try {
      const data = JSON.parse(content);
      logger.info(`[FileSystem] Loaded workspace: ${targetPath} (${stats.size} bytes)`);
      return { data, filePath: targetPath };
    } catch (jsonErr) {
      logger.error(`[FileSystem] Failed to parse workspace JSON at ${targetPath}:`, jsonErr);
      throw new Error('Invalid workspace file format. File may be corrupted or malformed.');
    }
  });

  handleSafe('start-file-watch', async (event, filePath) => {
    const sender = event.sender;
    
    if (activeWatchers.has(filePath)) {
      const entry = activeWatchers.get(filePath);
      const count = entry.clients.get(sender) || 0;
      entry.clients.set(sender, count + 1);
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
        entry.watcher.close();
        activeWatchers.delete(filePath);
      }
    });

    const clients = new Map();
    clients.set(sender, 1);
    activeWatchers.set(filePath, { watcher, clients });

    if (!sender.__fsWatchCleanupAttached) {
      sender.__fsWatchCleanupAttached = true;
      sender.once('destroyed', () => {
        for (const [fPath, entry] of activeWatchers.entries()) {
          if (entry.clients.has(sender)) {
            entry.clients.delete(sender);
            if (entry.clients.size === 0) {
              entry.watcher.close();
              activeWatchers.delete(fPath);
            }
          }
        }
      });
    }
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
}

/**
 * Startup Cleanup Logic: Finds and deletes orphaned .tmp files left over from
 * previous sessions (atomic write failures or app crashes).
 */
export async function cleanupTempFiles() {
  const cwd = process.cwd();
  try {
    const files = await fs.promises.readdir(cwd);
    const tmpFiles = files.filter(f => f.endsWith('.tmp') && f.includes('-'));
    for (const f of tmpFiles) {
      try {
        const stats = await fs.promises.stat(path.join(cwd, f));
        // Only delete if older than 1 hour (safety against concurrent writes from active run)
        if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
          await fs.promises.unlink(path.join(cwd, f));
        }
      } catch { /* ignore */ }
    }
  } catch (err) {
    logger.warn('[Filesystem] Startup cleanup failed:', err?.message || String(err));
  }
}
