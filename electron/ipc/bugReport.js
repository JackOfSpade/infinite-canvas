import electronPkg from 'electron';
const { dialog, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleSafe } from './ipcUtils.js';

// ── Shared markdown generation ────────────────────────────────────────────────
// Used by both the "save to file" and "copy to clipboard" handlers so the
// report content is identical regardless of how the user chooses to export it.
function generateMarkdown(payload) {
  const { description, nodes, edges, drawings, frontEndState, nodeInternals, nodeComponentStates } = payload;

  const systemInfo = {
    platform:        process.platform,
    arch:            process.arch,
    osRelease:       os.release(),
    appVersion:      app.getVersion(),
    nodeVersion:     process.versions.node,
    electronVersion: process.versions.electron,
    totalMemMB:      Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB:       Math.round(os.freemem()  / 1024 / 1024),
  };

  const appState = {
    systemInfo,
    frontEndState,
    nodes,
    edges,
    drawings,
    timestamp: new Date().toISOString(),
  };

  // ── Diagnostic section: group node size fields ─────────────────────────────
  // Shows style.width / measured.width / width prop separately.
  // A mismatch here (e.g. measured growing while style stays constant) is
  // the signature of the ReactFlow ResizeObserver race condition.
  const compStateById = {};
  (nodeComponentStates || []).forEach(s => { compStateById[s.id] = s; });

  let nodeDiagMarkdown = '';
  if (nodeInternals && nodeInternals.length > 0) {
    const rows = nodeInternals.map(n => {
      const cs = compStateById[n.id] || {};
      const flags = [
        cs.isEditing     ? 'editing'    : null,
        cs.isResizing    ? 'resizing'   : null,
        cs.hasEdgeCursor ? 'edgeCursor' : null,
      ].filter(Boolean).join(', ') || '—';
      return (
        `| \`${n.id.slice(0, 8)}\` ` +
        `| ${n.type} ` +
        `| (${n.position?.x?.toFixed(0)}, ${n.position?.y?.toFixed(0)}) ` +
        `| ${n.width_prop    ?? '—'} ` +
        `| ${n.style_width   ?? '—'} ` +
        `| ${n.measured_width ?? '—'} ` +
        `| ${cs.size         ?? '—'} ` +
        `| ${flags} |`
      );
    }).join('\n');
    nodeDiagMarkdown = `
## Node Diagnostics
> **Size columns**: mismatches reveal ResizeObserver/setNodes race conditions.
> **Component state**: React state at the moment the report was generated.

| ID (first 8) | Type | Position | width (prop) | style.width | measured.width | currentSize | state flags |
|---|---|---|---|---|---|---|---|
${rows}
`;
  }

  // ── Viewport section ───────────────────────────────────────────────────────
  const vp = frontEndState?.viewport;
  const viewportLine = vp ? `- Viewport: zoom=${vp.zoom} x=${vp.x} y=${vp.y}` : '';

  const STATE_BUDGET_BYTES = 1024 * 1024; // 1MB budget for the JSON state block
  let appStateJson = JSON.stringify(appState, null, 2);
  let stateWasTrimmed = false;

  if (Buffer.byteLength(appStateJson, 'utf8') > STATE_BUDGET_BYTES) {
    // If the full state is too large, it's almost always due to thousands of drawing points.
    // Omit the drawings but keep the rest of the metadata.
    const { drawings: _drawings, ...trimmedAppState } = appState;
    appStateJson = JSON.stringify(trimmedAppState, null, 2);
    stateWasTrimmed = true;
  }

  let baseMarkdown = `First assess if this bug report has all the data you need to debug this. If not, improve the bug reporting feature. Then, fix the following bug:

# Bug Report

## Issue Description
${description}

## Application State Summary
- Nodes: ${nodes ? nodes.length : 0}
- Edges: ${edges ? edges.length : 0}
- Drawings: ${drawings ? drawings.length : 0} ${stateWasTrimmed ? '*(Omitted from JSON below due to size)*' : ''}
- Active Tool: ${frontEndState?.activeTool || 'None'}
- OS: ${systemInfo.platform} ${systemInfo.arch}
${viewportLine}
${nodeDiagMarkdown}
<details>
<summary><b>Click here to expand the full JSON Application State</b></summary>

\`\`\`json
${appStateJson}
\`\`\`

</details>

## Event History
`;

  const MAX_BUDGET_BYTES = 10 * 1024 * 1024; // 10MB
  const bufferBytes    = Buffer.byteLength(baseMarkdown, 'utf8');
  const events         = payload.eventLogs || [];
  const remainingBytes = MAX_BUDGET_BYTES - bufferBytes;

  let trimmedEventsMarkdown = '';
  if (remainingBytes > 0 && events.length > 0) {
    const eventsBlockOpen  = `\`\`\`text\n`;
    const eventsBlockClose = `\n\`\`\`\n`;
    let eventsBytes = Buffer.byteLength(eventsBlockOpen) + Buffer.byteLength(eventsBlockClose);

    const includedEvents = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const eventStr   = events[i] + '\n';
      const eventBytes = Buffer.byteLength(eventStr, 'utf8');
      if (eventsBytes + eventBytes < remainingBytes) {
        eventsBytes += eventBytes;
        includedEvents.push(eventStr);
      } else {
        break;
      }
    }
    includedEvents.reverse(); // restore chronological order

    trimmedEventsMarkdown = eventsBlockOpen + includedEvents.join('') + eventsBlockClose;
  } else if (remainingBytes <= 0) {
    trimmedEventsMarkdown = `*(Event history omitted due to size limit)*\n`;
  } else {
    trimmedEventsMarkdown = `*(No events recorded)*\n`;
  }

  return baseMarkdown + trimmedEventsMarkdown;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
export function registerBugReportHandlers() {

  // Save report to a file chosen by the user via a native save dialog.
  handleSafe('export-bug-report', async (event, payload) => {
    const markdownContent = generateMarkdown(payload);

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save Bug Report',
      defaultPath: path.join(app.getPath('desktop'), `bug_report_${Date.now()}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (canceled || !filePath) return { success: false, canceled: true };

    await fs.promises.writeFile(filePath, markdownContent, 'utf8');
    return { filePath };
  });

  // Return the report as a string so the renderer can copy it to the clipboard.
  // No file dialog, no disk I/O — just generate and return the markdown.
  handleSafe('generate-bug-report-markdown', async (event, payload) => {
    const markdownContent = generateMarkdown(payload);
    return { markdown: markdownContent };
  });
}
