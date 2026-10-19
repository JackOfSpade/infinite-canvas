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

function removeSender(entry, sender) {
  const onDestroyed = entry.destroyedListeners.get(sender);
  if (onDestroyed) sender.removeListener('destroyed', onDestroyed);
  entry.destroyedListeners.delete(sender);
  entry.senders.delete(sender);
}

function closeWatch(root, entry) {
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.pending.clear();
  for (const sender of entry.senders) removeSender(entry, sender);
  entry.watcher.close();
  if (watchers.get(root) === entry) watchers.delete(root);
}

function flush(root, entry) {
  entry.timer = null;
  const paths = [...entry.pending];
  entry.pending.clear();
  for (const sender of entry.senders) {
    if (sender.isDestroyed()) removeSender(entry, sender);
    else {
      // A renderer's frame can become unavailable even while its WebContents
      // still exists. A best-effort filesystem notification must never turn
      // that send failure into an uncaught main-process timer exception.
      try { sender.send('application-bundles-changed', { paths }); }
      catch (error) { logger.warn(`[applicationBundleWatch] could not notify renderer: ${error?.message || error}`); }
    }
  }
  if (entry.senders.size === 0) closeWatch(root, entry);
}

async function ensureWatch(sender, canvasFilePath) {
  if (typeof canvasFilePath !== 'string' || !path.isAbsolute(canvasFilePath)) return { watching: false };
  const root = await fs.promises.realpath(path.dirname(canvasFilePath));
  // realpath yields to renderer teardown. The destroyed event may already
  // have fired, so registering its once-listener below would never clean up.
  if (sender.isDestroyed()) return { watching: false };
  let entry = watchers.get(root);
  if (!entry) {
    const watcher = fs.watch(root, { recursive: true, persistent: false });
    entry = { watcher, senders: new Set(), destroyedListeners: new Map(), pending: new Set(), timer: null };
    watcher.on('change', (_type, filename) => {
      // fs.watch may omit filename. Recheck the root in that case instead of
      // silently missing a folder deletion the saved cards need to reconcile.
      entry.pending.add(filename ? path.join(root, String(filename)) : root);
      if (!entry.timer) entry.timer = setTimeout(() => flush(root, entry), DEBOUNCE_MS);
    });
    watcher.on('error', (error) => {
      logger.warn(`[applicationBundleWatch] watcher for ${root} stopped: ${error?.message || error}`);
      closeWatch(root, entry);
    });
    watchers.set(root, entry);
  }
  if (!entry.senders.has(sender)) {
    entry.senders.add(sender);
    const onDestroyed = () => {
      removeSender(entry, sender);
      if (entry.senders.size === 0 && watchers.get(root) === entry) {
        closeWatch(root, entry);
      }
    };
    entry.destroyedListeners.set(sender, onDestroyed);
    sender.once('destroyed', onDestroyed);
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
