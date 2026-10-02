/**
 * Network IPC handlers — URL title fetching and task cancellation.
 */
import { handleSafe, abortNodeTasks, abortNodeTasksAndWait, nodeCancellationError } from './ipcUtils.js';
import electronPkg from 'electron';
import { decodeHtmlEntities } from '../../src/utils/textEncoding.js';
const { ipcMain } = electronPkg;

/** Pre-compiled once at module level to avoid recompilation on every fetch. */
const TITLE_REGEX = /<title[^>]*>([^<]+)<\/title>/i;

// Static safety bound (not adaptive): a <title> lives in the document head, so a
// fetched page that hasn't yielded one within 3s is almost certainly not going to.
const TITLE_FETCH_TIMEOUT_MS = 3000;

export function registerNetworkHandlers() {
  // Add direct listener for node task cancellation
  ipcMain.on('cancel-node-task', (event, nodeId, cause = null) => {
    // `cause` is the renderer's own account of WHY (Reset / cleared files /
    // board clear / node deleted). Without it the main process could only see
    // the generic sentinel and reported every user Reset as "Node deleted".
    if (nodeId) abortNodeTasks(nodeId, event.sender, nodeCancellationError(cause));
  });

  // Transactional cancellation (Job Board) needs acknowledgement that the
  // aborted handler has reached its own finally/sidecar-cleanup boundary before
  // the shared queue lane is released. This handler is deliberately not wrapped
  // in handleSafe, otherwise it would register—and abort—itself under `nodeId`.
  ipcMain.handle('cancel-node-task-and-wait', async (event, { nodeId, cause = null } = {}) => {
    if (!nodeId) return { abortedCount: 0, settled: true };
    return abortNodeTasksAndWait(nodeId, event.sender, nodeCancellationError(cause));
  });

  handleSafe('fetch-url-title', async (event, url, signal) => {
    try {
      let fetchUrl = url;
      if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) {
        fetchUrl = 'https://' + fetchUrl;
      }
      const res = await fetch(fetchUrl, {
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      
      if (!res.body) return { title: null };

      // Hardening: Read only the first 1MB of the response to avoid memory bloat
      const MAX_SIZE = 1024 * 1024; // 1MB
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytesRead = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          bytesRead += value.length;
          
          const earlyMatch = text.match(TITLE_REGEX);
          if (earlyMatch) {
            break; // Stop streaming early if title is found!
          }

          if (bytesRead >= MAX_SIZE) {
            break;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      
      // Guard: network fetch could be slow; window might be gone.
      if (event.sender.isDestroyed()) return { title: null };

      const match = text.match(TITLE_REGEX);
      if (!match) return { title: null };
      let title = match[1].trim();
      title = decodeHtmlEntities(title);
      return { title };
    } catch {
      return { title: null };
    }
  }, TITLE_FETCH_TIMEOUT_MS); // timeout passed to handleSafe
}
