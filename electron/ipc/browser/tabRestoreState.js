import fs from 'node:fs/promises';
import path from 'node:path';

// Chrome defers session restoration with --no-startup-window, then restores the
// previous automation tabs when the first headed window is created. The app
// retains this profile for authentication, never for tabs. Clear only restore
// metadata while Chrome is stopped; cookies and all website storage stay put.
const RESTORE_FILE = /^(?:Session|Tabs|Apps)_\d+$/;
const LEGACY_FILES = ['Current Session', 'Last Session', 'Current Tabs', 'Last Tabs'];
const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];
const receipts = [];

async function lstat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function clearOwnedBrowserTabRestoreState(userDataDir, ownedUserDataDir) {
  // An explicit second path prevents a generic Puppeteer caller from clearing
  // another profile. The launcher supplies the app's getUserDataDir() result.
  if (!userDataDir || !ownedUserDataDir || path.resolve(userDataDir) !== path.resolve(ownedUserDataDir)) {
    return { outcome: 'unowned-profile', removed: 0 };
  }
  let removed = 0;
  const finish = outcome => {
    const receipt = { at: new Date().toISOString(), outcome, removed };
    receipts.push(receipt);
    if (receipts.length > 20) receipts.shift();
    return { ...receipt };
  };
  try {
    const root = await lstat(userDataDir);
    if (!root) return finish('empty');
    if (!root.isDirectory() || root.isSymbolicLink()) return finish('unsafe-path');
    // lstat sees Chromium's lock symlinks even when their targets don't exist.
    // Leave collision/stale-lock handling to the launcher; never mutate a
    // profile while another Chrome may still own it.
    for (const name of LOCK_FILES) {
      if (await lstat(path.join(userDataDir, name))) return finish('profile-busy');
    }
    const profile = path.join(userDataDir, 'Default');
    const profileStat = await lstat(profile);
    if (!profileStat) return finish('empty');
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) return finish('unsafe-path');
    const sessions = path.join(profile, 'Sessions');
    const sessionsStat = await lstat(sessions);
    if (sessionsStat && (!sessionsStat.isDirectory() || sessionsStat.isSymbolicLink())) return finish('unsafe-path');
    const files = LEGACY_FILES.map(name => path.join(profile, name));
    if (sessionsStat) {
      for (const name of await fs.readdir(sessions)) {
        if (RESTORE_FILE.test(name)) files.push(path.join(sessions, name));
      }
    }
    for (const file of files) {
      // A separate launcher may acquire the profile while we enumerate it.
      for (const name of LOCK_FILES) {
        if (await lstat(path.join(userDataDir, name))) return finish('profile-busy');
      }
      const stat = await lstat(file);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) return finish('unsafe-path');
      try { await fs.unlink(file); removed++; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return finish(removed ? 'cleared' : 'empty');
  } catch {
    return finish('failed');
  }
}

export function browserTabRestoreDiagnosticsMarkdown() {
  const lines = [
    '\n## Browser Tab Restore Prevention (BTABS)',
    '> Process-local, newest first, at most 20 app-profile launch checks. Counts refer to restore files, not tabs. No paths, URLs, cookies or file contents are retained. Older reports cannot reconstruct these checks.',
  ];
  if (!receipts.length) lines.push('- No profile preparation recorded in this process.');
  for (const receipt of [...receipts].reverse()) {
    lines.push(`- ${receipt.at} · ${receipt.outcome} · restore files removed ${receipt.removed}`);
  }
  return `${lines.join('\n')}\n`;
}
