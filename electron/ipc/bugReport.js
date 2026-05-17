import electronPkg from 'electron';
const { dialog, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { handleSafe, snapshotActiveNodeTasks } from './ipcUtils.js';
import { getAISettings, resolveServiceAccountPath } from './settings.js';

// Captured at module load: the moment this code first ran in the main process.
// Used to detect when a user edits a source file but forgets to restart
// Electron — the renderer hot-reloads via Vite but the main-process modules
// keep running the old code, producing the maddening "I changed it, why isn't
// it doing the new thing?" failure mode.
const PROCESS_START_MS = Date.now();

/**
 * Returns the mtime (ms) of the newest main-process source file we care about,
 * or null if any stat fails. Comparing this to PROCESS_START_MS tells us if a
 * source file has been edited since the main process booted.
 */
function getNewestMainProcessSourceMtime() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // electron/ipc/
    const candidates = [
      'bugReport.js', 'settings.js', 'gemini.js', 'claude.js', 'llm.js',
      'jobs.js', 'marketplace.js', 'jobsHistory.js',
    ].map(f => path.join(here, f));
    candidates.push(path.join(here, '..', 'preload.js'));
    candidates.push(path.join(here, '..', 'main.js'));

    let newest = 0;
    for (const p of candidates) {
      try {
        const stat = fs.statSync(p);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch { /* missing file is fine */ }
    }
    return newest || null;
  } catch {
    return null;
  }
}

/**
 * Captures the AI configuration relevant to "why did nothing happen when I
 * clicked X" reports. NEVER includes the raw key strings — only whether they
 * are present and (for the active key) a short prefix for sanity-checking
 * that the user pasted the right format.
 */
function buildAIConfigSnapshot() {
  let ai = {};
  try { ai = getAISettings() || {}; } catch { /* settings store may not be ready */ }

  const geminiKey   = ai.geminiApiKey;
  const claudeKey   = ai.anthropicApiKey;
  const provider    = ai.provider || 'gemini';
  const activeKey   = provider === 'claude' ? claudeKey : geminiKey;
  const keyPrefix   = activeKey ? `${String(activeKey).slice(0, 7)}…` : '(none)';

  // resolveServiceAccountPath checks the user-configured path first, then
  // falls back to process.cwd()/service-account.json. Returns null if neither
  // is readable — which is the exact "I added a path but nothing happened"
  // failure mode that needs to be visible in the report.
  let resolvedSAPath = null;
  try { resolvedSAPath = resolveServiceAccountPath(); } catch { /* ignore */ }

  // Gemini works with either a UI key OR a resolvable service-account.json;
  // Claude needs the UI key.
  const effectivelyConfigured = provider === 'claude'
    ? !!claudeKey
    : (!!geminiKey || !!resolvedSAPath);

  // For Gemini, the runtime picks AI Studio when a key is set, Vertex when
  // a service-account is resolvable, and Mock Mode otherwise. Surfacing the
  // effective endpoint (not just "which keys are set") means a future
  // "billing depleted on Vertex" vs "rate-limited on AI Studio" report is
  // immediately disambiguated.
  let activeEndpoint;
  if (provider === 'claude') {
    activeEndpoint = claudeKey ? 'Anthropic API' : '(no key)';
  } else if (geminiKey) {
    activeEndpoint = 'Gemini API (AI Studio — generativelanguage.googleapis.com)';
  } else if (resolvedSAPath) {
    activeEndpoint = 'Vertex AI (aiplatform.googleapis.com via service-account)';
  } else {
    activeEndpoint = 'Mock Mode (placeholder data)';
  }

  return {
    provider,
    geminiModel:           ai.geminiModel || '(unset)',
    claudeModel:           ai.claudeModel || '(unset)',
    hasGeminiKey:          !!geminiKey,
    hasAnthropicKey:       !!claudeKey,
    activeKeyPrefix:       keyPrefix,
    configuredSAPath:      ai.serviceAccountPath || '(unset)',
    resolvedSAPath:        resolvedSAPath || '(none)',
    serviceAccountUsable:  !!resolvedSAPath,
    activeEndpoint,
    effectivelyConfigured,
  };
}

// ── Shared markdown generation ────────────────────────────────────────────────
// Used by both the "save to file" and "copy to clipboard" handlers so the
// report content is identical regardless of how the user chooses to export it.
function generateMarkdown(payload) {
  const { description, nodes, edges, drawings, frontEndState, nodeInternals, nodeComponentStates, mediaState, imageState, lastSaveError, activeEditableText } = payload;

  const systemInfo = {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    appVersion: app.getVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
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

  // Index full nodes by id so we can pull `data` for the preview column —
  // nodeInternals is intentionally stripped of `data` to keep its shape small.
  const nodeDataById = {};
  (nodes || []).forEach(n => { nodeDataById[n.id] = n.data || {}; });

  let nodeDiagMarkdown = '';
  if (nodeInternals && nodeInternals.length > 0) {
    const rows = nodeInternals.map(n => {
      const cs = compStateById[n.id] || {};
      const flags = [
        cs.isEditing ? 'editing' : null,
        cs.isResizing ? 'resizing' : null,
        cs.hasEdgeCursor ? 'edgeCursor' : null,
        n.selected ? 'selected' : null,
      ].filter(Boolean).join(', ') || '—';
      // Hub-aware preview: include hubState plus whichever payload keys this
      // node carries. `nodeInternals` is intentionally stripped of `data`, so
      // pull from `nodeDataById` (built above from the full `nodes` array).
      const d = nodeDataById[n.id] || {};
      const previewParts = [];
      if (d.hubState)                  previewParts.push(`hubState: ${d.hubState}`);
      if (d.errorMessage)              previewParts.push(`err: ${String(d.errorMessage).slice(0, 60)}`);
      if (d.isRateLimit)               previewParts.push(`rateLimit: true`);
      if (Array.isArray(d.imagePaths)) previewParts.push(`imagePaths: ${d.imagePaths.length}`);
      if (Array.isArray(d.images))     previewParts.push(`images: ${d.images.length}`);
      if (d.file)                      previewParts.push(`file: ${d.file.name || d.file}`);
      if (d.filePath)                  previewParts.push(`filePath: ${path.basename(String(d.filePath))}`);
      if (d.resumeProfile)             previewParts.push('resumeProfile: ✓');
      if (d.url)                       previewParts.push(`url: ${String(d.url).slice(0, 50)}`);
      if (d.product?.brand)            previewParts.push(`brand: ${d.product.brand}`);
      // Mock-mode flag is set by gemini.js when AI wasn't configured at call
      // time. Surfacing it here turns "why is the product info wrong?" reports
      // into a one-glance diagnosis.
      if (d.product?._mockMode)        previewParts.push('⚠️ mockMode: true');
      if (d.resumeProfile?._mockMode)  previewParts.push('⚠️ resume._mockMode: true');
      // Per-source ring progress lives in component state, not node data.
      // Compact it as `comp: ebay-sold=done/12,poshmark=searching/0,...` so a
      // "stale ring after re-research" report is diagnosable at a glance.
      const ringProgress = cs.compProgress || cs.sourceProgress;
      if (ringProgress && typeof ringProgress === 'object') {
        const entries = Object.entries(ringProgress);
        if (entries.length > 0) {
          const tag = cs.compProgress ? 'comp' : 'src';
          previewParts.push(`${tag}: ` + entries.map(([k, v]) => `${k}=${v?.status || '?'}/${v?.count ?? '?'}`).join(','));
        }
      }
      const dataPreview = previewParts.join(', ');

      return (
        `| \`${n.id.slice(0, 8)}\` ` +
        `| ${n.type} ` +
        `| ${n.selected ? '✅' : '—'} ` +
        `| (${n.position?.x?.toFixed(0)}, ${n.position?.y?.toFixed(0)}) ` +
        `| ${n.fontSize ?? '—'}/${n.fontFamily ?? '—'} ` +
        `| ${n.textColor ?? '—'} ` +
        `| ${n.backgroundColor ?? '—'} ` +
        `| ${n.width_prop ?? '—'} ` +
        `| ${n.style_width ?? '—'} ` +
        `| ${n.measured_width ?? '—'} ` +
        `| ${cs.size ?? '—'} ` +
        `| ${flags} ` +
        `| ${dataPreview || '—'} |`
      );
    }).join('\n');
    nodeDiagMarkdown = `
## Node Diagnostics
> **Size columns**: mismatches reveal ResizeObserver/setNodes race conditions.
> **Component state**: React state at the moment the report was generated.

| ID (first 8) | Type | Selected | Position | Font | T-Color | B-Color | width (prop) | style.width | measured.width | currentSize | state flags | data preview |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows}
`;
  }

  // ── Media player state section ────────────────────────────────────────────
  let mediaMarkdown = '';
  if (mediaState && mediaState.length > 0) {
    const READY_STATE = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
    const NET_STATE = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
    const fmtRanges = (arr) => {
      if (!arr || arr.length === 0) return '(none)';
      return arr.map(([s, e]) => `${s.toFixed(2)}–${e.toFixed(2)}`).join(', ');
    };
    const rows = mediaState.map((m, i) => {
      const durStr = typeof m.duration === 'number' ? `${m.duration.toFixed(2)}s` : (m.duration || 'unknown');
      const progress = `${m.currentTime?.toFixed(2)}s / ${durStr}`;
      const errorStr = m.errorCode != null ? `code=${m.errorCode} ${m.errorMessage || ''}`.trim() : '—';
      return (
        `| ${i + 1} ` +
        `| ${m.tag} ` +
        `| ${m.paused ? 'paused' : m.ended ? 'ended' : 'playing'} ` +
        `| ${progress} ` +
        `| ${READY_STATE[m.readyState] ?? m.readyState} ` +
        `| ${NET_STATE[m.networkState] ?? m.networkState} ` +
        `| ${fmtRanges(m.seekable)} ` +
        `| ${fmtRanges(m.buffered)} ` +
        `| ${errorStr} |`
      );
    }).join('\n');
    mediaMarkdown = `
## Media Player State
> Snapshot taken at report time. \`readyState\`/\`networkState\` reveal stalls and decode/network issues.
> An empty \`seekable\` range while \`buffered\` is populated means the source isn't Range-capable — timeline clicks are ignored.

| # | Tag | Status | Progress | readyState | networkState | Seekable | Buffered | Error |
|---|---|---|---|---|---|---|---|---|
${rows}
`;
  }

  // ── Image element state section ───────────────────────────────────────────
  // Captures <img> load state at report time. `broken: true` (complete=true,
  // naturalWidth=0) means the protocol returned an error or an undisplayable
  // payload — the primary signature of HEIC / unsupported-format failures.
  let imageMarkdown = '';
  if (imageState && imageState.length > 0) {
    const rows = imageState.map((img, i) => {
      const srcShort = img.src ? img.src.replace(/^local-file:\/\//, '').slice(-60) : '(none)';
      return (
        `| ${i + 1} ` +
        `| ${img.broken ? '⚠️ broken' : img.complete ? 'ok' : 'loading'} ` +
        `| ${img.naturalWidth} × ${img.naturalHeight} ` +
        `| \`...${srcShort}\` |`
      );
    }).join('\n');
    imageMarkdown = `
## Image Element State
> \`broken\` = complete with naturalWidth=0 — protocol returned 4xx/5xx or undisplayable bytes.

| # | Status | Natural Size | src (last 60 chars) |
|---|---|---|---|
${rows}
`;
  }

  // ── Active editable section ────────────────────────────────────────────────
  // Captures the divergence between the focused contenteditable's live DOM
  // text and the saved data.text on its node. A `divergent: true` here is the
  // signature of a "saved while editing — lost my edit" report.
  let activeEditableMarkdown = '';
  if (activeEditableText) {
    const a = activeEditableText;
    activeEditableMarkdown = `
## Active Editable At Report Time
- Editing node: \`${a.editingNodeId || '(unknown)'}\`
- Diverges from saved data.text: ${a.divergent === true ? '⚠️ YES' : a.divergent === false ? 'no' : 'unknown'}
- Live DOM text: \`${(a.liveText || '').replace(/`/g, '\\`')}\`
- Saved data.text: \`${(a.savedText || '').replace(/`/g, '\\`')}\`
`;
  }

  // ── Last save error section ────────────────────────────────────────────────
  // Save errors used to be lost: the toast was shown, the user dismissed it,
  // and the bug report had no record of *why* the save failed. Surfacing this
  // up front means a "Save Failed" report is actionable instead of a guess.
  let lastSaveErrorMarkdown = '';
  if (lastSaveError) {
    lastSaveErrorMarkdown = `
## Last Save Error
- Reason: \`${lastSaveError.reason || 'unknown'}\`
- File: \`${lastSaveError.filePath || '(no current file)'}\`
- When: ${lastSaveError.timestamp || 'unknown'}
`;
  }

  // ── Active IPC tasks ──────────────────────────────────────────────────────
  // Catches the "I clicked Cancel/X but the pipeline kept running" failure
  // mode. The renderer can mark a node visually 'done' instantly, but if the
  // backend AbortControllers weren't cancelled, the underlying tasks finish
  // and overwrite the user's reset. This snapshot makes that immediately
  // diagnosable in any report.
  let activeTasksMarkdown = '';
  try {
    const tasks = snapshotActiveNodeTasks() || [];
    if (tasks.length > 0) {
      const rows = tasks
        .map(t => `| \`${String(t.nodeId).slice(0, 8)}\` | ${t.taskCount} |`)
        .join('\n');
      activeTasksMarkdown = `
## Active IPC Tasks
> Nodes with backend AbortControllers still registered at report time.
> A node showing tasks here while its UI looks idle means a cancel/abort
> request never reached the backend.

| Node ID (first 8) | Active task count |
|---|---|
${rows}
`;
    } else {
      activeTasksMarkdown = `
## Active IPC Tasks
- ✅ None registered.
`;
    }
  } catch { /* never break the report on diagnostic failure */ }

  // ── Build freshness ───────────────────────────────────────────────────────
  // Catches the "I edited a file but the running app still does the old thing"
  // failure mode. Vite hot-reloads the renderer, but Electron main-process
  // files (preload, IPC handlers, settings store) only reload on a full restart.
  // If any tracked source is newer than the process start, the running build is
  // stale — flag it loudly so the report doesn't waste time chasing a phantom.
  const newestSrcMs = getNewestMainProcessSourceMtime();
  const uptimeMs    = Math.round(process.uptime() * 1000);
  const startedAt   = new Date(PROCESS_START_MS).toISOString();
  const newestSrcStr = newestSrcMs ? new Date(newestSrcMs).toISOString() : '(unknown)';
  const isStale     = !!(newestSrcMs && newestSrcMs > PROCESS_START_MS);
  const stalenessLine = isStale
    ? `⚠️ **STALE BUILD**: a tracked main-process source file was modified ${Math.round((newestSrcMs - PROCESS_START_MS) / 1000)}s after the process started. The running app is NOT executing the current source on disk — fully restart Electron (not just Vite) before treating this report as authoritative.`
    : '✅ Up to date — no tracked main-process source has been modified since the process started.';
  const buildFreshnessMarkdown = `
## Build Freshness
- Main process started: \`${startedAt}\` (uptime ${Math.round(uptimeMs / 1000)}s)
- Newest tracked source file mtime: \`${newestSrcStr}\`
- ${stalenessLine}
`;

  // ── AI configuration snapshot ─────────────────────────────────────────────
  // Surfaces missing keys / wrong provider — the most common cause of
  // "I clicked the AI button and nothing happened" reports.
  const aiConfig = buildAIConfigSnapshot();
  const aiConfigMarkdown = `
## AI Configuration
- Active provider: \`${aiConfig.provider}\`
- **Active endpoint**: \`${aiConfig.activeEndpoint}\`
- Gemini model: \`${aiConfig.geminiModel}\`
- Claude model: \`${aiConfig.claudeModel}\`
- Gemini API key set: ${aiConfig.hasGeminiKey ? '✅' : '❌'}
- Anthropic API key set: ${aiConfig.hasAnthropicKey ? '✅' : '❌'}
- Active key prefix: \`${aiConfig.activeKeyPrefix}\`
- service-account.json configured path: \`${aiConfig.configuredSAPath}\`
- service-account.json resolved path: \`${aiConfig.resolvedSAPath}\`
- service-account.json usable: ${aiConfig.serviceAccountUsable ? '✅' : '❌'}
- **Effectively configured for active provider**: ${aiConfig.effectivelyConfigured ? '✅' : '❌ — AI calls will fall back to Mock Mode (Gemini) or fail (Claude) until a key is added in Settings'}
`;

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

  let baseMarkdown = `Do not change the bug report feature, just what it reports. First assess if this bug report has all the data you need to debug this. If not, improve the reporting. Then, fix the following bug:

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
${buildFreshnessMarkdown}${activeTasksMarkdown}${aiConfigMarkdown}${activeEditableMarkdown}${lastSaveErrorMarkdown}${nodeDiagMarkdown}${mediaMarkdown}${imageMarkdown}
<details>
<summary><b>Click here to expand the full JSON Application State</b></summary>

\`\`\`json
${appStateJson}
\`\`\`

</details>

## Event History
`;

  const MAX_BUDGET_BYTES = 10 * 1024 * 1024; // 10MB
  const bufferBytes = Buffer.byteLength(baseMarkdown, 'utf8');
  const events = payload.eventLogs || [];
  const remainingBytes = MAX_BUDGET_BYTES - bufferBytes;

  let trimmedEventsMarkdown = '';
  if (remainingBytes > 0 && events.length > 0) {
    const eventsBlockOpen = `\`\`\`text\n`;
    const eventsBlockClose = `\n\`\`\`\n`;
    let eventsBytes = Buffer.byteLength(eventsBlockOpen) + Buffer.byteLength(eventsBlockClose);

    const includedEvents = [];
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
