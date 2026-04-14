/**
 * Filesystem IPC handlers — scan directories, open files/URLs, save/load workspaces.
 */
import { ipcMain, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';

const activeWatchers = new Map();

export function registerFilesystemHandlers() {
  ipcMain.handle('scan-directory', async (_event, dirPath) => {
    const scan = (currentPath) => {
      const stats = fs.statSync(currentPath);
      if (stats.isDirectory()) {
        const children = fs.readdirSync(currentPath)
          .map(item => {
            try { return scan(path.join(currentPath, item)); }
            catch { return null; }
          })
          .filter(Boolean);
        return {
          id: 'group-' + Math.random().toString(36).substr(2, 9),
          type: 'group',
          title: path.basename(currentPath) || currentPath,
          collapsed: true,
          items: children,
        };
      }
      return {
        id: 'doc-' + Math.random().toString(36).substr(2, 9),
        type: 'document',
        filename: path.basename(currentPath),
        filePath: currentPath,
      };
    };

    try {
      const stats = fs.statSync(dirPath);
      return stats.isDirectory() ? scan(dirPath) : { isFile: true, file: scan(dirPath) };
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
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('open-external', async (_event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fetch-url-title', async (_event, url) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      let fetchUrl = url;
      if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) {
          fetchUrl = 'https://' + fetchUrl;
      }
      const res = await fetch(fetchUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
      });
      clearTimeout(timeoutId);
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
      return { success: false, error: err.message };
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
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('start-file-watch', (event, filePath) => {
    if (activeWatchers.has(filePath)) return { success: true };
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: 'File missing' };
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          event.sender.send('file-changed', filePath);
        }
      });
      activeWatchers.set(filePath, watcher);
      return { success: true };
    } catch (err) {
      console.error('Watch error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-file-watch', (event, filePath) => {
    const watcher = activeWatchers.get(filePath);
    if (watcher) {
      watcher.close();
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
      return { success: false, error: err.message };
    }
  });
}
