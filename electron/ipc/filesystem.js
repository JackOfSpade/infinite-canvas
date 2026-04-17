/**
 * Filesystem IPC handlers — scan directories, open files/URLs, save/load workspaces.
 */
import electronPkg from 'electron';
const { ipcMain, shell, dialog } = electronPkg;
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
 */
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
    try { realPath = await fs.promises.realpath(currentPath); } catch {}
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
    console.warn(`[Filesystem] Skipping inaccessible path: ${currentPath}`, err?.message || String(err));
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
    try { await fs.promises.unlink(tmpPath); } catch {}
    throw err;
  }
}

export function registerFilesystemHandlers() {
  ipcMain.handle('scan-directory', async (event, dirPath) => {
    const visited = new Set();
    try {
      const result = await scanPath(dirPath, visited, event.sender);
      
      // Guard: If window reload/close happened during deep file scan, abort early.
      if (event.sender.isDestroyed()) return { success: false, error: 'Window closed' };

      if (!result) return { success: false, error: 'Directory skip or unreadable' };
      return result.type === 'document' ? { isFile: true, file: result } : result;
    } catch (error) {
      console.error('Error scanning directory:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('open-file', async (_event, filePath) => {
    try {
      const err = await shell.openPath(filePath);
      if (err) return { success: false, error: err };
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('open-external', async (_event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: `Invalid protocol: ${parsed.protocol}. Only http and https are allowed for external links.` };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('fetch-url-title', async (event, url) => {
    try {
      let fetchUrl = url;
      if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) {
        fetchUrl = 'https://' + fetchUrl;
      }
      const res = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(3000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      
      if (!res.body) return null;

      // Hardening: Read only the first 1MB of the response to avoid memory bloat
      const MAX_SIZE = 1024 * 1024; // 1MB
      const reader = res.body.getReader();
      let decoder = new TextDecoder();
      let text = '';
      let bytesRead = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        bytesRead += value.length;
        if (bytesRead >= MAX_SIZE) {
          await reader.cancel();
          break;
        }
      }
      
      // Guard: network fetch could be slow; window might be gone.
      if (event.sender.isDestroyed()) return null;

      const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (!match) return null;
      let title = match[1].trim();
      // Simple HTML entity decode for common characters
      title = title.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'");
      return title;
    } catch {
      return null;
    }
  });

  ipcMain.handle('save-workspace', async (_event, args) => {
    try {
      const { data, filePath } = args;
      let targetPath = filePath;
      if (!targetPath) {
        const { canceled, filePath: dialogPath } = await dialog.showSaveDialog({
          title: 'Save Canvas',
          defaultPath: 'canvas.json',
          filters: [{ name: 'JSON Files', extensions: ['json'] }],
        });
        if (canceled || !dialogPath) return { success: false, canceled: true };
        targetPath = dialogPath;
      }
      // Production Hardening: Use atomic write to prevent data corruption
      await atomicWriteFile(targetPath, JSON.stringify(data));
      return { success: true, filePath: targetPath };
    } catch (err) {
      console.error('Failed to save workspace:', err);
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('load-workspace', async (_event, opts) => {
    try {
      let targetPath = opts?.filePath;
      
      if (!targetPath) {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Open Canvas',
          properties: ['openFile'],
          filters: [{ name: 'JSON Files', extensions: ['json'] }],
        });
        if (canceled || filePaths.length === 0) return { success: false, canceled: true };
        targetPath = filePaths[0];
      }

      if (!fs.existsSync(targetPath)) {
        return { success: false, error: 'File does not exist' };
      }

      const stats = fs.statSync(targetPath);
      if (stats.size === 0) {
        return { success: false, error: 'Workspace file is empty (0 bytes)' };
      }

      const content = await fs.promises.readFile(targetPath, 'utf-8');
      
      try {
        const data = JSON.parse(content);
        console.log(`[FileSystem] Loaded workspace: ${targetPath} (${stats.size} bytes)`);
        return { success: true, data, filePath: targetPath };
      } catch (jsonErr) {
        console.error(`[FileSystem] Failed to parse workspace JSON at ${targetPath}:`, jsonErr);
        return { success: false, error: 'Invalid workspace file format. File may be corrupted or malformed.' };
      }
    } catch (err) {
      console.error('[FileSystem] Unexpected error loading workspace:', err);
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('start-file-watch', async (event, filePath) => {
    const sender = event.sender;
    
    // 1. If we already have a watcher for this file...
    if (activeWatchers.has(filePath)) {
      const entry = activeWatchers.get(filePath);
      const count = entry.clients.get(sender) || 0;
      entry.clients.set(sender, count + 1);
      return { success: true };
    }

    // 2. New watcher needed
    try {
      await fs.promises.access(filePath);
      
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          const entry = activeWatchers.get(filePath);
          if (!entry) return;
          // Notify ALL window instances watching this file
          for (const [clientSender] of entry.clients) {
            if (!clientSender.isDestroyed()) {
              clientSender.send('file-changed', filePath);
            }
          }
        }
      });

      watcher.on('error', (err) => {
        console.warn(`[FileSystem] Watcher error for ${filePath}:`, err);
        const entry = activeWatchers.get(filePath);
        if (entry) {
          entry.watcher.close();
          activeWatchers.delete(filePath);
        }
      });

      const clients = new Map();
      clients.set(sender, 1);
      activeWatchers.set(filePath, { watcher, clients });

      // Ensure cleanup if window crashes/closes
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

      return { success: true };
    } catch (err) {
      console.error('Watch error:', err);
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('stop-file-watch', (event, filePath) => {
    const sender = event.sender;
    const entry = activeWatchers.get(filePath);
    
    if (entry && entry.clients.has(sender)) {
      const current = entry.clients.get(sender);
      if (current <= 1) {
        entry.clients.delete(sender);
      } else {
        entry.clients.set(sender, current - 1);
      }

      // If no clients remain across any windows, shut down the real watcher
      if (entry.clients.size === 0) {
        entry.watcher.close();
        activeWatchers.delete(filePath);
      }
    }
    return { success: true };
  });

  ipcMain.handle('delete-os-file', async (_event, filePath) => {
    try {
      await shell.trashItem(filePath);
      return { success: true };
    } catch (err) {
      console.error('Failed to trash OS file:', err);
      return { success: false, error: err?.message || String(err) };
    }
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
      } catch {}
    }
  } catch (err) {
    console.warn('[Filesystem] Startup cleanup failed:', err?.message || String(err));
  }
}
