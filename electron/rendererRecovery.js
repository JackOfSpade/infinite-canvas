import fs from 'node:fs';
import path from 'node:path';

const LIMIT = 10;
const REASONS = new Set(['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);
const FILE = 'renderer-crashes.json';

function safeReceipt(value) {
  if (!value || !REASONS.has(value.reason) || (!Number.isFinite(value.at) || value.at < 0 || value.at > 8_640_000_000_000_000)) return null;
  return {
    at: value.at,
    reason: value.reason,
    exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode : null,
    savedWorkspaceBytes: Number.isSafeInteger(value.savedWorkspaceBytes) && value.savedWorkspaceBytes >= 0
      ? value.savedWorkspaceBytes : null,
  };
}

export function readRendererCrashes(userData) {
  try {
    const file = path.join(userData, FILE);
    if (fs.statSync(file).size > 16_384) return [];
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows.map(safeReceipt).filter(Boolean).slice(-LIMIT) : [];
  } catch { return []; }
}

export function recordRendererCrash(userData, details, canvasPath, now = Date.now) {
  let savedWorkspaceBytes = null;
  try { if (canvasPath) savedWorkspaceBytes = fs.statSync(canvasPath).size; } catch { /* no saved workspace */ }
  const receipt = safeReceipt({ ...details, at: now(), savedWorkspaceBytes });
  if (!receipt) return;
  const file = path.join(userData, FILE);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...readRendererCrashes(userData), receipt].slice(-LIMIT)), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function buildRendererCrashMarkdown(userData) {
  const rows = readRendererCrashes(userData);
  return `## Renderer Crash Recovery\n> Bounded receipts survive app restarts. No canvas contents, filenames, URLs or crash-stack text are retained.\n\n${rows.length
    ? rows.map(row => `- ${new Date(row.at).toISOString()} · reason \`${row.reason}\` · exit ${row.exitCode ?? 'unknown'} · saved workspace ${row.savedWorkspaceBytes ?? 'unknown'} bytes`).join('\n')
    : '- No renderer crash receipt retained (older builds did not record these events).'}\n`;
}

export function hasStoppedRenderer(win) {
  return !!win && !win.isDestroyed() && (win.__rendererStopped === true || win.webContents?.isCrashed?.() === true);
}

export function attachRendererRecovery(win, { isQuitting, record, showMessageBox, reload, log = () => {} }) {
  const contents = win.webContents;
  let showing = false;
  const onGone = async (_event, details) => {
    if (win.isDestroyed() || details?.reason === 'clean-exit') return;
    win.__rendererStopped = true;
    try { record(details); } catch { log('Could not persist renderer crash receipt'); }
    if (showing || isQuitting()) return;
    showing = true;
    try {
      const { response } = await showMessageBox(win, {
        type: 'error',
        title: 'Canvas stopped unexpectedly',
        message: 'The canvas renderer stopped unexpectedly.',
        detail: 'Reload to reopen the last saved version of this canvas. Unsaved changes in the stopped renderer cannot be recovered. Your saved files have not been deleted.',
        buttons: ['Reload saved canvas', 'Leave window open'], defaultId: 0, cancelId: 1,
        noLink: true,
      });
      if (response === 0 && !win.isDestroyed() && !isQuitting()) await reload();
    } catch { log('Could not recover stopped canvas renderer'); }
    finally { showing = false; }
  };
  const onLoaded = () => { win.__rendererStopped = false; };
  contents.on('render-process-gone', onGone);
  contents.on('did-finish-load', onLoaded);
  return () => {
    contents.removeListener('render-process-gone', onGone);
    contents.removeListener('did-finish-load', onLoaded);
  };
}
