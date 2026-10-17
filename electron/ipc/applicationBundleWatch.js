import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import logger from '../logger.js';

// A saved job card's bundle folder can be deleted in Finder while the app is
// running. The card probes its folder once per mount, so without a signal the
// red cross outlived the folder until the next restart.
//
// One recursive fs.watch per canvas folder (FSEvents on macOS: event-driven,
// no polling) reports which paths changed. Main only debounces and forwards
// those paths; each saved card decides whether its own folder (or an
// ancestor) is among them and re-runs its existing status probe, which owns
// the actual existence check.
const DEBOUNCE_MS = 300;
const watchers = new Map(); // realpath of canvas dir → { watcher, senders, pending, timer }

function flush(entry) {
  entry.timer = null;
  const paths = [...entry.pending];
  entry.pending.clear();
  for (const sender of entry.senders) {
    if (sender.isDestroyed()) entry.senders.delete(sender);
    else sender.send('application-bundles-changed', { paths });
  }
}

async function ensureWatch(sender, canvasFilePath) {
  if (typeof canvasFilePath !== 'string' || !path.isAbsolute(canvasFilePath)) return { watching: false };
  const root = await fs.promises.realpath(path.dirname(canvasFilePath));
  let entry = watchers.get(root);
  if (!entry) {
    const watcher = fs.watch(root, { recursive: true, persistent: false });
    entry = { watcher, senders: new Set(), pending: new Set(), timer: null };
    watcher.on('change', (_type, filename) => {
      if (!filename) return;
      entry.pending.add(path.join(root, String(filename)));
      if (!entry.timer) entry.timer = setTimeout(() => flush(entry), DEBOUNCE_MS);
    });
    watcher.on('error', (error) => {
      logger.warn(`[applicationBundleWatch] watcher for ${root} stopped: ${error?.message || error}`);
      watcher.close();
      watchers.delete(root);
    });
    watchers.set(root, entry);
  }
  if (!entry.senders.has(sender)) {
    entry.senders.add(sender);
    sender.once('destroyed', () => {
      entry.senders.delete(sender);
      if (entry.senders.size === 0 && watchers.get(root) === entry) {
        clearTimeout(entry.timer);
        entry.watcher.close();
        watchers.delete(root);
      }
    });
  }
  return { watching: true };
}

export function registerApplicationBundleWatchHandlers() {
  ipcMain.handle('watch-application-bundles', async (event, { canvasFilePath } = {}) => {
    try {
      return await ensureWatch(event.sender, canvasFilePath);
    } catch (error) {
      logger.warn(`[applicationBundleWatch] could not watch ${canvasFilePath}: ${error?.message || error}`);
      return { watching: false };
    }
  });
}
