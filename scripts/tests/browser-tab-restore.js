import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { clearOwnedBrowserTabRestoreState, browserTabRestoreDiagnosticsMarkdown } from '../../electron/ipc/browser/tabRestoreState.js';
import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import { applyBugReportCode } from '../../src/utils/bugReportCodes.js';

async function withProfile(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-tab-restore-'));
  const profile = path.join(root, 'owned-profile');
  await fs.mkdir(path.join(profile, 'Default', 'Sessions'), { recursive: true });
  try { return await run({ root, profile }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function writeFixture(profile, relative, contents = 'private-browser-content-sentinel') {
  const file = path.join(profile, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, { mode: 0o600 });
  return file;
}

export default [
  {
    name: 'browser tab restore: only exact restore files are removed; cookies, storage and preferences retain bytes and identities',
    run: () => withProfile(async ({ profile }) => {
      const removedFiles = [
        'Default/Sessions/Session_123', 'Default/Sessions/Tabs_456', 'Default/Sessions/Apps_789',
        'Default/Current Session', 'Default/Last Session', 'Default/Current Tabs', 'Default/Last Tabs',
      ];
      const retainedFiles = [
        'Local State', 'Default/Preferences', 'Default/Secure Preferences', 'Default/Cookies',
        'Default/Network/Cookies', 'Default/Login Data', 'Default/Web Data',
        'Default/Local Storage/leveldb/000001.log', 'Default/Session Storage/000001.log',
        'Default/Service Worker/Database/000001.log', 'Default/Sessions/Session_123.bak',
        'Default/Sessions/Other_123', 'Default/Sessions/session_999', 'Default/Sessions/.DS_Store',
      ];
      for (const relative of removedFiles) await writeFixture(profile, relative);
      const retained = [];
      for (const relative of retainedFiles) {
        const file = await writeFixture(profile, relative, `retained:${relative}`);
        retained.push({ file, contents: await fs.readFile(file, 'utf8'), stat: await fs.stat(file) });
      }
      const result = await clearOwnedBrowserTabRestoreState(profile, profile);
      assert(result.outcome === 'cleared' && result.removed === removedFiles.length,
        'all modern and legacy restore records are removed');
      for (const relative of removedFiles) {
        assert(await fs.lstat(path.join(profile, relative)).then(() => false, error => error.code === 'ENOENT'),
          `${relative} must not remain available for Chrome restoration`);
      }
      for (const before of retained) {
        const after = await fs.stat(before.file);
        assert(await fs.readFile(before.file, 'utf8') === before.contents
          && after.ino === before.stat.ino && after.mode === before.stat.mode,
        'authentication, website storage, preferences and unrelated entries stay untouched');
      }
      const repeated = await clearOwnedBrowserTabRestoreState(profile, profile);
      assert(repeated.outcome === 'empty' && repeated.removed === 0, 'preparation is idempotent');
    }),
  },
  {
    name: 'browser tab restore: busy profiles, including dangling Chromium locks, are never modified',
    run: () => withProfile(async ({ profile }) => {
      const restore = await writeFixture(profile, 'Default/Sessions/Tabs_12');
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
        const lock = path.join(profile, name);
        // Chromium uses dangling symlinks for some lock markers. Checking
        // access()/stat() instead of lstat() would miss this live ownership.
        await fs.symlink(path.join(profile, 'missing-lock-target'), lock);
        const result = await clearOwnedBrowserTabRestoreState(profile, profile);
        assert(result.outcome === 'profile-busy' && result.removed === 0,
          `${name} must prevent profile mutation even when its symlink target is absent`);
        assert(await fs.readFile(restore, 'utf8') === 'private-browser-content-sentinel');
        await fs.unlink(lock);
      }
      await fs.writeFile(path.join(profile, 'SingletonLock'), 'lock');
      assert((await clearOwnedBrowserTabRestoreState(profile, profile)).outcome === 'profile-busy',
        'regular lock files also prevent cleanup');
    }),
  },
  {
    name: 'browser tab restore: unowned and symlinked profiles or restore entries cannot redirect cleanup',
    run: async () => {
      await withProfile(async ({ root, profile }) => {
        const restore = await writeFixture(profile, 'Default/Sessions/Tabs_12');
        const other = path.join(root, 'another-profile');
        for (const args of [[profile, other], [null, profile], [profile, null]]) {
          const result = await clearOwnedBrowserTabRestoreState(...args);
          assert(result.outcome === 'unowned-profile' && result.removed === 0);
        }
        assert(await fs.readFile(restore, 'utf8') === 'private-browser-content-sentinel');
      });
      for (const relative of ['', 'Default', 'Default/Sessions']) {
        await withProfile(async ({ root, profile }) => {
          await writeFixture(profile, 'Default/Sessions/Tabs_12');
          const location = path.join(profile, relative);
          const parked = path.join(root, 'parked');
          await fs.rename(location, parked);
          await fs.symlink(parked, location);
          const result = await clearOwnedBrowserTabRestoreState(profile, profile);
          assert(result.outcome === 'unsafe-path' && result.removed === 0,
            `symlink at ${relative || 'profile root'} must fail closed`);
          const parkedRestore = relative === '' ? 'Default/Sessions/Tabs_12'
            : relative === 'Default' ? 'Sessions/Tabs_12' : 'Tabs_12';
          assert(await fs.readFile(path.join(parked, parkedRestore), 'utf8') === 'private-browser-content-sentinel');
        });
      }
      await withProfile(async ({ root, profile }) => {
        const external = await writeFixture(root, 'external-session', 'external-private-content');
        await fs.symlink(external, path.join(profile, 'Default', 'Sessions', 'Tabs_12'));
        const result = await clearOwnedBrowserTabRestoreState(profile, profile);
        assert(result.outcome === 'unsafe-path' && result.removed === 0);
        assert(await fs.readFile(external, 'utf8') === 'external-private-content');
      });
    },
  },
  {
    name: 'browser tab restore: diagnostics are bounded, privacy-safe and included in FULL and BTABS reports',
    run: () => withProfile(async ({ profile }) => {
      for (let index = 0; index < 25; index++) {
        await writeFixture(profile, `Default/Sessions/Tabs_${index}`);
        await clearOwnedBrowserTabRestoreState(profile, profile);
      }
      const markdown = browserTabRestoreDiagnosticsMarkdown();
      assert(markdown.split('\n').filter(line => line.startsWith('- ')).length === 20,
        'only the newest twenty preparation receipts are retained');
      assert(markdown.includes('cleared · restore files removed 1')
        && !markdown.includes(profile) && !markdown.includes('private-browser-content-sentinel')
        && !markdown.includes('Tabs_24'), 'receipts contain only fixed outcomes and aggregate counts');
      const payload = { nodes: [], edges: [], drawings: [], eventLogs: [], description: 'Synthetic browser check' };
      for (const filterCode of ['FULL', 'BTABS']) {
        const report = generateMarkdown({ ...payload, filterCode }).markdown;
        assert(report.includes('## Browser Tab Restore Prevention (BTABS)')
          && report.includes('cleared · restore files removed 1'), `${filterCode} includes restore receipts`);
      }
      assert(!generateMarkdown({ ...payload, filterCode: 'APPOUTPUT' }).markdown.includes('## Browser Tab Restore Prevention'),
        'unrelated narrow reports omit browser preparation receipts');
      assert(applyBugReportCode([], {}, 'BTABS').matchedCodes.includes('BTABS'), 'BTABS is a recognized filter');
    }),
  },
];
