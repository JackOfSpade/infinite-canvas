// Process-local, bounded receipts. Never retain paths, file contents, inode
// values or exception text; all exported fields use host-owned vocabularies.
const reasons = new Set(['parent-unavailable', 'parent-path-mismatch', 'parent-not-directory',
  'parent-symlink', 'target-not-file', 'target-symlink', 'target-hardlink',
  'target-path-mismatch', 'binding-changed']);
const codes = new Set(['RENDERER_WORKSPACE_PATH_CHANGED', 'RENDERER_WORKSPACE_RECOVERY_AMBIGUOUS', 'WORKSPACE_SYNC_LINK_BUSY',
  'PRIVATE_RENDERER_PATH', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EBUSY']);
const receipts = [];

// `waiting` is an attempt the save itself retries once cloud sync lets go of
// the file; only a final `failed` means that save did not happen.
export function recordWorkspaceWriteOutcome(error = null, { waiting = false } = {}) {
  receipts.push({ at: new Date().toISOString(), outcome: !error ? 'saved' : waiting ? 'waiting' : 'failed',
    code: error ? (codes.has(error.code) ? error.code : 'OTHER') : 'OK',
    reason: error ? (reasons.has(error.workspacePathCheck) ? error.workspacePathCheck : 'unclassified') : 'verified',
  });
  if (receipts.length > 40) receipts.shift();
}

export function workspaceIoDiagnosticsMarkdown() {
  const rows = receipts.slice(-20);
  return '\n## Workspace Save Diagnostics (WSIO)\n'
    + '> Process-local, newest first; up to 20 of 40 retained save outcomes. Paths, contents and filesystem identities are never retained. Older reports cannot reconstruct these checks.\n'
    + (rows.length ? rows.reverse().map(row => `- ${row.at} · ${row.outcome} · ${row.code} · check ${row.reason}`).join('\n')
      : '- No workspace save outcome retained in this process.') + '\n';
}
