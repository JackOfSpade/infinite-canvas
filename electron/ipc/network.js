import { handleSafe, abortNodeTasks } from './ipcUtils.js';
import electronPkg from 'electron';
const { ipcMain } = electronPkg;

export function registerNetworkHandlers() {
  // Add direct listener for node task cancellation
  ipcMain.on('cancel-node-task', (_event, nodeId) => {
    if (nodeId) abortNodeTasks(nodeId);
  });

  handleSafe('fetch-url-title', async (event, url, signal) => {
    // ... rest of the handler
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
      let decoder = new TextDecoder();
      let text = '';
      let bytesRead = 0;

      const matchPattern = /<title[^>]*>([^<]+)<\/title>/i;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          bytesRead += value.length;
          
          const earlyMatch = text.match(matchPattern);
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

      const match = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (!match) return { title: null };
      let title = match[1].trim();
      // Simple HTML entity decode for common characters
      title = title.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'");
      return { title };
    } catch {
      return { title: null };
    }
  }, 3000); // 3000ms timeout passed to handleSafe
}
