import { ipcMain, dialog, app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';

export function registerBugReportHandlers() {
  ipcMain.handle('export-bug-report', async (event, payload) => {
    try {
      const { description, nodes, edges, drawings, frontEndState } = payload;
      
      const systemInfo = {
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        appVersion: app.getVersion(),
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMemMB: Math.round(os.freemem() / 1024 / 1024)
      };

      const appState = {
        systemInfo,
        frontEndState,
        nodes,
        edges,
        drawings,
        timestamp: new Date().toISOString()
      };

      const MAX_BUDGET_BYTES = 10 * 1024 * 1024; // 10MB
      let appStateJson = JSON.stringify(appState, null, 2);
      
      let baseMarkdown = `# Bug Report

## Issue Description
${description}

## Application State Summary
- Nodes: ${nodes ? nodes.length : 0}
- Edges: ${edges ? edges.length : 0}
- Drawings: ${drawings ? drawings.length : 0}
- Active Tool: ${frontEndState?.activeTool || 'None'}
- OS: ${systemInfo.platform} ${systemInfo.arch}

<details>
<summary><b>Click here to expand the full JSON Application State</b></summary>

\`\`\`json
${appStateJson}
\`\`\`

</details>

## Event History
`;

      const bufferBytes = Buffer.byteLength(baseMarkdown, 'utf8');
      const events = payload.eventLogs || [];
      const remainingBytes = MAX_BUDGET_BYTES - bufferBytes;

      let trimmedEventsMarkdown = '';
      if (remainingBytes > 0 && events.length > 0) {
        const eventsBlockOpen = `\`\`\`text\n`;
        const eventsBlockClose = `\n\`\`\`\n`;
        let eventsBytes = Buffer.byteLength(eventsBlockOpen) + Buffer.byteLength(eventsBlockClose);
        
        const includedEvents = [];
        // Walk backwards to prioritize the most recent events
        for (let i = events.length - 1; i >= 0; i--) {
          const eventStr = events[i] + '\n';
          const eventBytes = Buffer.byteLength(eventStr, 'utf8');
          if (eventsBytes + eventBytes < remainingBytes) {
            eventsBytes += eventBytes;
            includedEvents.push(eventStr);
          } else {
            break;
          }
        }
        // Reverse to restore chronological order (push was newest-first)
        includedEvents.reverse();
        
        trimmedEventsMarkdown = eventsBlockOpen + includedEvents.join('') + eventsBlockClose;
      } else if (remainingBytes <= 0) {
        trimmedEventsMarkdown = `*(Event history omitted due to 10MB payload size limit)*\n`;
      } else {
        trimmedEventsMarkdown = `*(No events recorded)*\n`;
      }

      const markdownContent = baseMarkdown + trimmedEventsMarkdown;

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Bug Report',
        defaultPath: path.join(process.cwd(), `bug_report_${Date.now()}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      });

      if (canceled || !filePath) return { success: false, canceled: true };

      fs.writeFileSync(filePath, markdownContent, 'utf8');
      return { success: true, filePath };
    } catch (err) {
      console.error('[BugReport] Failed to export bug report:', err);
      return { success: false, error: err.message };
    }
  });
}
