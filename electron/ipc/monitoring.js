/**
 * DUMMY monitoring IPC handlers.
 * All handlers return mock/placeholder responses.
 * Replace with real Playwright-based monitoring in the next phase.
 */
import { ipcMain } from 'electron';

const activeMonitors = new Map(); // nodeId -> timerId

/**
 * Register all monitoring IPC handlers.
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
export function registerMonitoringHandlers(getMainWindow) {
  ipcMain.handle('register-listing', async (_event, { url, platform }) => {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      const fakeTitle = pathParts.length > 0
        ? pathParts[pathParts.length - 1].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : `${platform} Listing`;
      return { success: true, title: fakeTitle };
    } catch {
      return { success: true, title: `${platform} Listing` };
    }
  });

  ipcMain.handle('start-monitoring', async (_event, { id }) => {
    if (activeMonitors.has(id)) clearTimeout(activeMonitors.get(id));

    const delay = 10_000 + Math.random() * 5_000;
    const timerId = setTimeout(() => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('monitoring-activity', {
          nodeId: id,
          activity: {
            id: 'act-' + Date.now(),
            type: 'New Message',
            description: 'Someone sent you a message about this listing',
            timestamp: new Date().toLocaleTimeString(),
            read: false,
          },
        });
      }
      activeMonitors.delete(id);
    }, delay);

    activeMonitors.set(id, timerId);
    return { success: true };
  });

  ipcMain.handle('stop-monitoring', async (_event, { id }) => {
    if (activeMonitors.has(id)) {
      clearTimeout(activeMonitors.get(id));
      activeMonitors.delete(id);
    }
    return { success: true };
  });

  ipcMain.handle('get-activity-log', async () => ({
    activities: [
      { id: 'act-001', type: 'New Message', description: 'Buyer asked: "Is this item still available?"', timestamp: '2:34 PM', read: false },
      { id: 'act-002', type: 'Price Change', description: 'Price dropped from $299 to $249', timestamp: '1:15 PM', read: false },
      { id: 'act-003', type: 'New Offer', description: 'Received offer of $200 from buyer', timestamp: '11:42 AM', read: true },
      { id: 'act-004', type: 'Bid Placed', description: 'New bid of $275 placed', timestamp: '10:05 AM', read: true },
    ],
  }));

  ipcMain.handle('update-monitor-settings', async (_event, { id, frequency }) => {
    console.log(`[DUMMY] Monitor settings updated for ${id}: frequency=${frequency}s`);
    return { success: true };
  });
}
