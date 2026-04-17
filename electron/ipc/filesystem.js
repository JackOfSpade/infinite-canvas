/**
 * Filesystem IPC handlers — scan directories, open files/URLs, save/load workspaces.
 */
import electronPkg from 'electron';
const { ipcMain, shell, dialog } = electronPkg;
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

const activeWatchers = new Map();

export function registerFilesystemHandlers() {
  ipcMain.handle('scan-directory', async (_event, dirPath) => {
    const visited = new Set();
    const scan = (currentPath, depth = 0) => {
      // Prevent infinite recursion from symlink loops or massive trees
      if (depth > 5) return null;
      
      let realPath = currentPath;
      try { realPath = fs.realpathSync(currentPath); } catch {}
      if (visited.has(realPath)) return null;
      visited.add(realPath);

      // Skip notoriously large known directories to prevent thread lock
      const base = path.basename(currentPath);
      if (base === 'node_modules' || base === '.git') return null;

      const stats = fs.statSync(currentPath);
      if (stats.isDirectory()) {
        const children = fs.readdirSync(currentPath)
          .map(item => {
            try { return scan(path.join(currentPath, item), depth + 1); }
            catch { return null; }
          })
          .filter(Boolean);
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
    };

    try {
      const result = scan(dirPath);
      // Result could be null if the root was ignored (e.g. depth limit or node_modules)
      if (!result) return { success: false, error: 'Directory skip or unreadable' };
      // scan() returns { type: 'group', ... } for directories and { type: 'document', ... } for files.
      // Wrap file results in the { isFile, file } envelope the caller expects.
      return result.type === 'document' ? { isFile: true, file: result } : result;
    } catch (error) {
      console.error('Error scanning directory:', error);
      throw error;
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
      fs.writeFileSync(targetPath, JSON.stringify(data), 'utf-8');
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
      const data = fs.readFileSync(targetPath, 'utf-8');
      return { success: true, data: JSON.parse(data), filePath: targetPath };
    } catch (err) {
      console.error('Failed to load workspace:', err);
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('start-file-watch', (event, filePath) => {
    if (activeWatchers.has(filePath)) {
      const existing = activeWatchers.get(filePath);
      if (!existing.sender.isDestroyed() && existing.sender === event.sender) {
        return { success: true };
      }
      // If same file but different/destroyed sender, clean up old watcher
      existing.watcher.close();
      activeWatchers.delete(filePath);
    }
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: 'File missing' };
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          if (!event.sender.isDestroyed()) {
            event.sender.send('file-changed', filePath);
          }
        }
      });
      activeWatchers.set(filePath, { watcher, sender: event.sender });

      if (!event.sender.__fsWatchCleanupAttached) {
        event.sender.__fsWatchCleanupAttached = true;
        event.sender.once('destroyed', () => {
          for (const [key, obj] of activeWatchers.entries()) {
            if (obj.sender === event.sender) {
              obj.watcher.close();
              activeWatchers.delete(key);
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
    const obj = activeWatchers.get(filePath);
    // Only allow the sender that registered the watcher to close it — avoids
    // a second node watching the same path from killing the first's watcher.
    if (obj && obj.sender === event.sender) {
      obj.watcher.close();
      activeWatchers.delete(filePath);
    }
    return { success: true };
  });

  ipcMain.handle('delete-os-file', async (event, filePath) => {
    try {
      await shell.trashItem(filePath);
      return { success: true };
    } catch (err) {
      console.error('Failed to trash OS file:', err);
      return { success: false, error: err?.message || String(err) };
    }
  });
}
