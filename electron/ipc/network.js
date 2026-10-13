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

export function registerNetworkHandlers({ onNodeDeleted = null, ipcMainInstance = ipcMain, registerHandler = handleSafe } = {}) {
  // Add direct listener for node task cancellation
  ipcMainInstance.on('cancel-node-task', (event, nodeId, cause = null) => {
    // `cause` is the renderer's own account of WHY (Reset / cleared files /
    // board clear / node deleted). Without it the main process could only see
    // the generic sentinel and reported every user Reset as "Node deleted".
    if (nodeId) {
      abortNodeTasks(nodeId, event.sender, nodeCancellationError(cause));
      // This direct route is dispatched only after the canvas has committed a
      // deletion. Keep companion-window retirement on that committed boundary:
      // transactional cancellation probes may still be rolled back.
      if (cause === 'node-deleted' && typeof onNodeDeleted === 'function') onNodeDeleted(event.sender, nodeId);
    }
  });

  // Transactional cancellation (Job Board) needs acknowledgement that the
  // aborted handler has reached its own finally/sidecar-cleanup boundary before
  // the shared queue lane is released. This handler is deliberately not wrapped
  // in handleSafe, otherwise it would register—and abort—itself under `nodeId`.
  ipcMainInstance.handle('cancel-node-task-and-wait', async (event, { nodeId, cause = null } = {}) => {
    if (!nodeId) return { abortedCount: 0, settled: true };
    return abortNodeTasksAndWait(nodeId, event.sender, nodeCancellationError(cause));
  });

  registerHandler('fetch-url-title', async (event, url, signal) => {
    try {
      const suppliedUrl = typeof url === 'string' ? url.trim() : '';
      const fetchUrl = new URL(/^https?:\/\//i.test(suppliedUrl) ? suppliedUrl : `https://${suppliedUrl}`);
      if (!['http:', 'https:'].includes(fetchUrl.protocol)) return { title: null };
      const res = await fetch(fetchUrl.href, {
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
          // A stream may return a chunk larger than our entire scan budget.
          // Clip before decoding and matching so a late title cannot escape
          // the first-MiB limit merely because it arrived in one chunk.
          const remaining = MAX_SIZE - bytesRead;
          const inspected = value.subarray(0, remaining);
          text += decoder.decode(inspected, { stream: true });
          bytesRead += inspected.byteLength;
          
          const earlyMatch = text.match(TITLE_REGEX);
          if (earlyMatch) {
            break; // Stop streaming early if title is found!
          }

          if (bytesRead >= MAX_SIZE) {
            break;
          }
        }
        text += decoder.decode();
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
