import { assert, hasProfileCookieCommitAdvanced, path, profileCookieStorePaths } from '../test-dependencies.js';

// What a wrong answer here costs: hasProfileCookieCommitAdvanced is the sole gate
// waitForNativeProfileCookieCommit polls on before it closes a native (CDP-less)
// Indeed/Swappa/Mercari login window. A false POSITIVE — reporting "committed"
// before Chromium has actually flushed SQLitePersistentCookieStore's pending
// batch to disk — closes the window on SIGTERM early, exactly like the fixed
// duration this replaced: the user's just-completed login is silently thrown
// away with zero cookie rows on disk (the reported bug — 21.8s open, 2.7s after
// success, ZERO cookie rows). A false NEGATIVE only costs time (the window keeps
// waiting up to the 34s ceiling, then closes anyway and reports uncommitted) —
// asymmetric, so every ambiguous case below is pinned to the SAFE (false) answer.
// profileCookieStorePaths must stay in lockstep: if it stops enumerating a real
// Chrome cookie-store layout, the checkpoint wait watches files that can never
// change and hasProfileCookieCommitAdvanced silently degrades into that same
// false-positive-by-omission (current.found stays 0, which this suite also pins
// to false — never "committed").

export default [
{
    name: 'profileCookieStorePaths: empty/nullish input yields no paths to watch',
    run: () => {
      assert(Array.isArray(profileCookieStorePaths(null)) && profileCookieStorePaths(null).length === 0,
        'null userDataDir must return [] (nothing to stat, not a crash)');
      assert(profileCookieStorePaths(undefined).length === 0, 'undefined userDataDir must return []');
      assert(profileCookieStorePaths('').length === 0, 'empty-string userDataDir must return []');
      assert(profileCookieStorePaths(0).length === 0, 'falsy non-string userDataDir must return []');
      return { ok: true };
    },
  },
{
    name: 'profileCookieStorePaths: covers both Chrome cookie-store layouts under the given profile dir',
    run: () => {
      const base = '/Users/jack/Library/Application Support/InfiniteCanvas/shared-profile';
      const paths = profileCookieStorePaths(base);

      // Every path must be rooted under the supplied userDataDir — a checkpoint
      // wait must never end up watching some other profile's files.
      assert(paths.length > 0, 'a real userDataDir must yield at least one watched path');
      assert(paths.every(p => p.startsWith(base)), 'every stamped path must be built under the given userDataDir');

      // Old layout: <profile>/Default/Cookies (+ SQLite side files).
      const oldStore = path.join(base, 'Default', 'Cookies');
      assert(paths.includes(oldStore), 'must include the pre-Network Cookies path');
      assert(paths.includes(`${oldStore}-journal`), 'must include the old layout -journal side file');
      assert(paths.includes(`${oldStore}-wal`), 'must include the old layout -wal side file');

      // Current layout: <profile>/Default/Network/Cookies (+ SQLite side files).
      // A Chrome version that moved the store to this layout must not make the
      // checkpoint wait blind — both variants have to be present simultaneously,
      // not a version-branch that picks only one.
      const networkStore = path.join(base, 'Default', 'Network', 'Cookies');
      assert(paths.includes(networkStore), 'must include the post-migration Network/Cookies path');
      assert(paths.includes(`${networkStore}-journal`), 'must include the new layout -journal side file');
      assert(paths.includes(`${networkStore}-wal`), 'must include the new layout -wal side file');

      assert(oldStore !== networkStore, 'the two layout variants must be genuinely distinct paths');
      return { pathCount: paths.length };
    },
  },
{
    name: 'hasProfileCookieCommitAdvanced: missing baseline/current never reads as committed',
    run: () => {
      const current = { mtimeMs: 100, size: 10, found: 1 };
      const baseline = { mtimeMs: 100, size: 10, found: 1 };
      assert(hasProfileCookieCommitAdvanced(null, current) === false, 'missing baseline must return false, not throw');
      assert(hasProfileCookieCommitAdvanced(undefined, current) === false, 'undefined baseline must return false');
      assert(hasProfileCookieCommitAdvanced(baseline, null) === false, 'missing current must return false, not throw');
      assert(hasProfileCookieCommitAdvanced(baseline, undefined) === false, 'undefined current must return false');
      assert(hasProfileCookieCommitAdvanced(null, null) === false, 'both missing must return false');
      return { ok: true };
    },
  },
{
    name: 'hasProfileCookieCommitAdvanced: found=0 is nothing-on-disk, never "committed"',
    run: () => {
      // If NONE of the candidate cookie-store files exist yet (found: 0), any
      // mtime/size delta is meaningless noise, not a checkpoint — reading it as
      // "committed" would close the native window while the profile has no
      // cookie store at all, discarding the session with no evidence it ever
      // wrote anything. This must stay false even when the numbers superficially
      // "look like" a commit (mtime/size both larger).
      const baseline = { mtimeMs: 0, size: 0, found: 0 };
      const current = { mtimeMs: 500, size: 200, found: 0 };
      assert(hasProfileCookieCommitAdvanced(baseline, current) === false,
        'current.found === 0 must short-circuit to false regardless of mtime/size deltas');
      return { ok: true };
    },
  },
{
    name: 'hasProfileCookieCommitAdvanced: identical stamp is not a commit',
    run: () => {
      const baseline = { mtimeMs: 1_700_000_000_000, size: 4096, found: 3 };
      const current = { mtimeMs: 1_700_000_000_000, size: 4096, found: 3 };
      assert(hasProfileCookieCommitAdvanced(baseline, current) === false,
        'an unchanged mtime AND size must not be reported as a checkpoint');
      return { ok: true };
    },
  },
{
    name: 'hasProfileCookieCommitAdvanced: mtime advancing is a commit',
    run: () => {
      const baseline = { mtimeMs: 1_700_000_000_000, size: 4096, found: 2 };
      const current = { mtimeMs: 1_700_000_000_500, size: 4096, found: 2 };
      assert(hasProfileCookieCommitAdvanced(baseline, current) === true,
        'a later mtimeMs than baseline must be reported as a checkpoint even with size unchanged');
      return { ok: true };
    },
  },
{
    name: 'hasProfileCookieCommitAdvanced: size changing with an identical mtime is still a commit',
    run: () => {
      // Filesystem mtime resolution (some volumes round to whole seconds) can
      // hide an in-place SQLite page rewrite that lands within the same
      // granularity window. Size is the second, independent signal so that kind
      // of commit is not missed and the window closes on a fixed timer again.
      const baseline = { mtimeMs: 1_700_000_000_000, size: 4096, found: 2 };
      const current = { mtimeMs: 1_700_000_000_000, size: 4608, found: 2 };
      assert(hasProfileCookieCommitAdvanced(baseline, current) === true,
        'a size delta at an identical mtime must still be reported as a checkpoint');
      // Shrinking counts too — SQLite can also vacuum/rewrite smaller.
      const shrunk = { mtimeMs: 1_700_000_000_000, size: 2048, found: 2 };
      assert(hasProfileCookieCommitAdvanced(baseline, shrunk) === true,
        'a size decrease at an identical mtime must also be reported as a checkpoint');
      return { ok: true };
    },
  },
];
