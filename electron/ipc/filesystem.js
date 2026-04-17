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
async function scanPath(currentPath, visited, depth = 0) {
  // Prevent infinite recursion from symlink loops or massive trees
  if (depth > 5) return null;

  let realPath = currentPath;
  try { realPath = await fs.promises.realpath(currentPath); } catch {}
  if (visited.has(realPath)) return null;
  visited.add(realPath);

  // Skip notoriously large known directories to prevent thread lock
  const base = path.basename(currentPath);
  if (base === 'node_modules' || base === '.git' || base === '.DS_Store') return null;

  try {
    // Use lstat to handle symlinks correctly (don't blindly follow if we've seen the path)
    const stats = await fs.promises.lstat(currentPath);
    
    if (stats.isSymbolicLink()) {
      // For symlinks, we already have realPath via realpath() above.
      // If we got here, it's a link we haven't visited yet.
      // We'll follow it once unless it exceeds depth.
    }

    if (stats.isDirectory()) {
      const dirItems = await fs.promises.readdir(currentPath);
      const childrenPromises = dirItems.map(async item => {
        try { return await scanPath(path.join(currentPath, item), visited, depth + 1); }
        catch { return null; }
      });
      const childrenRaw = await Promise.all(childrenPromises);
      const children = childrenRaw.filter(Boolean);
      
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
    console.warn(`[Filesystem] Skipping inaccessible path: ${currentPath}`, err.message);
    return null;
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
  ipcMain.handle('scan-directory', async (_event, dirPath) => {
    const visited = new Set();
    try {
      const result = await scanPath(dirPath, visited);
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
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('fetch-url-title', async (_event, url) => {
    try {
      let fetchUrl = url;
      if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) {
        fetchUrl = 'https://' + fetchUrl;
      }
      const res = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(3000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      const text = await res.text();
      const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      return match ? match[1].trim() : null;
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

  ipcMain.handle('load-workspace', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Open Canvas',
        properties: ['openFile'],
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });
      if (canceled || filePaths.length === 0) return { success: false, canceled: true };
      const targetPath = filePaths[0];
      const data = await fs.promises.readFile(targetPath, 'utf-8');
      
      // Safety: Parse JSON in a try block even inside the outer catch
      try {
        return { success: true, data: JSON.parse(data), filePath: targetPath };
      } catch (jsonErr) {
        return { success: false, error: 'Invalid workspace file format. File may be corrupted.' };
      }
    } catch (err) {
      console.error('Failed to load workspace:', err);
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
