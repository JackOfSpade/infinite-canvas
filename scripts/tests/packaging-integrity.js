import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert } from '../test-dependencies.js';

const SCANNED_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.md']);
// Tab (9), LF (10) and CR (13) are the only control bytes source text may hold.
const isForbiddenControlByte = byte => (byte <= 8) || byte === 11 || byte === 12 || (byte >= 14 && byte <= 31) || byte === 127;

// Returns [{ file, offset, byte }] for every raw control byte in the listed files
// (offset is the 0-based byte offset, so `head -c` / a hex editor lands on it).
async function findRawControlBytes(root, files) {
  const offenders = [];
  for (const file of files) {
    if (!SCANNED_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    let data;
    try { data = await fs.readFile(path.join(root, file)); }
    catch (cause) { if (cause?.code === 'ENOENT') continue; throw cause; } // listed but deleted in the working tree
    for (let offset = 0; offset < data.length; offset += 1) {
      if (isForbiddenControlByte(data[offset])) offenders.push({ file, offset, byte: data[offset] });
    }
  }
  return offenders;
}

const describeControlBytes = offenders => offenders
  .map(({ file, offset, byte }) => `${file} @ byte ${offset} (0x${byte.toString(16).padStart(2, '0')})`).join('; ');

// null when git is unusable here (e.g. a detached CI worktree whose .git points at an unmounted repo).
function listTrackedFiles(root) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) return null;
  return listed.stdout.split(String.fromCharCode(0)).filter(Boolean);
}

export default [
  {
    name: 'launcher source manifest: content changes trigger a rebuild even with unchanged size and mtime',
    run: async () => {
      const { sourceManifestDigest } = await import('../../scripts/source-manifest.mjs');
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-source-manifest-'));
      const external = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-source-manifest-external-'));
      try {
        const source = path.join(root, 'source.js');
        const env = path.join(root, '.env');
        await fs.writeFile(source, 'alpha');
        await fs.writeFile(env, 'PRIVATE=value-a');
        const fixedTime = new Date('2024-01-01T00:00:00.000Z');
        await fs.utimes(source, fixedTime, fixedTime);
        const beforeStat = await fs.stat(source);
        const before = sourceManifestDigest(root, ['source.js', '.env']);

        await fs.writeFile(source, 'omega');
        await fs.utimes(source, fixedTime, fixedTime);
        const afterStat = await fs.stat(source);
        const afterSourceEdit = sourceManifestDigest(root, ['source.js', '.env']);
        assert(beforeStat.size === afterStat.size && beforeStat.mtimeMs === afterStat.mtimeMs && before !== afterSourceEdit,
          'a same-size source edit with the original mtime must change the rebuild stamp');

        await fs.writeFile(env, 'PRIVATE=value-b');
        const afterEnvEdit = sourceManifestDigest(root, ['source.js', '.env']);
        assert(afterEnvEdit !== afterSourceEdit && !afterEnvEdit.includes('PRIVATE'),
          'an ignored .env edit changes the digest without exposing secret text');

        const cli = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'source-manifest.mjs')], {
          cwd: root, encoding: 'utf8', input: 'source.js\0.env\0',
        });
        assert(cli.status === 0 && cli.stdout.trim() === afterEnvEdit,
          `the launcher helper reads the NUL-delimited inventory (${cli.status}: ${cli.stderr})`);
        await fs.rm(source);
        assert(sourceManifestDigest(root, ['source.js', '.env']) !== afterEnvEdit,
          'removing a tracked file also changes the digest');
        let unsafe = false;
        try { sourceManifestDigest(root, ['../outside']); } catch { unsafe = true; }
        assert(unsafe, 'the helper refuses inventory paths outside the workspace');

        const externalFile = path.join(external, 'private.txt');
        await fs.writeFile(externalFile, 'outside-a');
        await fs.symlink(externalFile, path.join(root, 'source-link'));
        let symlinkRejected = false;
        try { sourceManifestDigest(root, ['source-link']); }
        catch (error) { symlinkRejected = /does not support symlinks/.test(error.message); }
        assert(symlinkRejected,
          'the launcher fails closed on symlinked input instead of reading outside the workspace or stamping a stale target');
        await fs.symlink(external, path.join(root, 'linked-parent'), 'dir');
        let linkedParentRejected = false;
        try { sourceManifestDigest(root, ['linked-parent/private.txt']); }
        catch (error) { linkedParentRejected = /parent must be a real directory/.test(error.message); }
        assert(linkedParentRejected,
          'a symlinked parent directory cannot make an indexed child read outside the workspace');

        await fs.mkdir(path.join(root, 'source-directory'));
        let directoryRejected = false;
        try { sourceManifestDigest(root, ['source-directory']); } catch { directoryRejected = true; }
        assert(directoryRejected, 'a directory cannot be misread as a source file');
        return { ok: true };
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(external, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'macOS packaging: workspace lock serializes direct builds and safely recovers stale owners',
    run: async () => {
      const { acquirePackagingLock, packagingLockPath, packagingReclaimGuardPath, withPackagingLock } = await import('../../scripts/build-macos.mjs');
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-packaging-lock-'));
      const lockPath = packagingLockPath(root);
      const guardPath = packagingReclaimGuardPath(root);
      const exists = async target => fs.access(target).then(() => true, () => false);
      try {
        const first = acquirePackagingLock(root, { pid: 401, token: 'first', pidAlive: () => true });
        let contention = '';
        try { acquirePackagingLock(root, { pid: 402, token: 'second', pidAlive: candidate => candidate === 401 }); }
        catch (cause) { contention = String(cause?.message || cause); }
        assert(contention.includes('pid 401') && await exists(lockPath),
          'a live lock owner must block a concurrent direct build without deleting its lock');
        first.release();
        assert(!(await exists(lockPath)), 'a successful build releases only its own workspace lock');

        let failed = false;
        try {
          withPackagingLock(root, () => { throw new Error('package failed'); }, { pid: 403, token: 'failure', pidAlive: () => true });
        } catch { failed = true; }
        assert(failed && !(await exists(lockPath)), 'a failed compile/package/verify operation releases its workspace lock in finally');

        await fs.mkdir(lockPath, { recursive: true });
        await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: 404, token: 'stale' })}\n`);
        const replacement = acquirePackagingLock(root, { pid: 405, token: 'replacement', pidAlive: () => false });
        const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
        assert(owner.pid === 405 && owner.token === 'replacement',
          'a dead owner is atomically reclaimed and replaced without treating its stale directory as live');
        replacement.release();
        assert(!(await exists(lockPath)) && !(await exists(guardPath)) && !lockPath.includes('.launcher/build.lock'),
          'stale recovery cleans its own lock generation and never conflicts with the launcher lock');

        // Deterministic version of the old TOCTOU: B sees stale S, A fully
        // reclaims S and acquires a live lock, then B proceeds. B must re-read
        // A only after owning the reclaim guard and may not delete it.
        await fs.mkdir(lockPath, { recursive: true });
        await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: 501, token: 'stale-s' })}\n`);
        let liveA = null;
        let contenderError = '';
        try {
          acquirePackagingLock(root, {
            pid: 503,
            token: 'contender-b',
            pidAlive: candidate => candidate === 502,
            onMainLockContention: () => {
              liveA = acquirePackagingLock(root, { pid: 502, token: 'live-a', pidAlive: () => false });
            },
          });
        } catch (cause) { contenderError = String(cause?.message || cause); }
        const afterInterleave = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
        assert(contenderError.includes('pid 502') && afterInterleave.token === 'live-a',
          'a contender that observed stale S must not delete A after A reclaims and reacquires before B gets the reclaim guard');

        // An old handle must not remove a newer lock generation after a manual
        // replacement or recovery has already changed owner token.
        await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: 504, token: 'newer-owner' })}\n`);
        liveA.release();
        const afterOldRelease = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
        assert(afterOldRelease.token === 'newer-owner',
          'releasing an old handle never removes a replacement lock generation');
        await fs.rm(lockPath, { recursive: true, force: true });

        // If a process crashes while it owns the reclaim guard, a later build
        // proves that PID dead and claims THAT guard generation before moving
        // it. A concurrent recovery attempt sees the token-scoped claim and
        // cannot touch either guard or main lock.
        await fs.mkdir(lockPath, { recursive: true });
        await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({ pid: 601, token: 'stale-main' })}\n`);
        await fs.mkdir(guardPath, { recursive: true });
        await fs.writeFile(path.join(guardPath, 'owner.json'), `${JSON.stringify({ pid: 600, token: 'crashed-guard', startedAt: new Date(0).toISOString() })}\n`);
        let competingRecovery = '';
        const recovered = acquirePackagingLock(root, {
          pid: 602,
          token: 'recovered-owner',
          pidAlive: () => false,
          onReclaimGuardRecoveryClaim: () => {
            // The competing reclaimer sees our just-recorded claim as live,
            // even though the outer process is deliberately treating only
            // the original crashed owner as dead for this schedule.
            try { acquirePackagingLock(root, { pid: 603, token: 'competing-owner', pidAlive: candidate => candidate === 602 }); }
            catch (cause) { competingRecovery = String(cause?.message || cause); }
          },
        });
        const afterGuardRecovery = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
        assert(afterGuardRecovery.token === 'recovered-owner'
          && competingRecovery.includes('Another process is reclaiming')
          && !(await exists(guardPath)),
        'a proven-dead guard is recovered once, while concurrent guard reclaimers cannot delete or replace the live recovered lock');
        recovered.release();
        return { ok: true };
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'macOS packaging: configured signing identity is required before packaging',
    run: async () => {
      const { assertMacSigningPrerequisites } = await import('../../scripts/build-macos.mjs');
      let error = '';
      try {
        assertMacSigningPrerequisites({
          identity: 'Example Signing Identity',
          platform: 'darwin',
          runCommand: () => ({ status: 0, stdout: '     0 valid identities found\n', stderr: '' }),
          toolExists: () => true,
        });
      } catch (cause) { error = String(cause?.message || cause); }
      assert(error.includes('No valid macOS code-signing identity matching "Example Signing Identity"'),
        'a missing configured identity must stop packaging before electron-builder can emit an unsigned app');

      let missingToolError = '';
      try {
        assertMacSigningPrerequisites({
          identity: 'Example Signing Identity',
          platform: 'darwin',
          toolExists: () => false,
        });
      } catch (cause) { missingToolError = String(cause?.message || cause); }
      assert(missingToolError.includes('/usr/bin/codesign and /usr/bin/security'),
        'Darwin tool availability is injected for deterministic tests while production still checks the exact system paths');

      let adHocError = '';
      try { assertMacSigningPrerequisites({ identity: '-', platform: 'darwin' }); }
      catch (cause) { adHocError = String(cause?.message || cause); }
      assert(adHocError.includes('ad-hoc signing is not accepted'),
        'an ad-hoc identity must never satisfy the configured signing gate');

      let wrongIdentityError = '';
      try {
        assertMacSigningPrerequisites({
          identity: 'Expected Identity',
          platform: 'darwin',
          runCommand: () => ({ status: 0, stdout: '  1) AABBCCDD "Different Identity"\n', stderr: '' }),
          toolExists: () => true,
        });
      } catch (cause) { wrongIdentityError = String(cause?.message || cause); }
      assert(wrongIdentityError.includes('Expected Identity'),
        'a different valid keychain identity must not be substituted for the configured identity');

      assertMacSigningPrerequisites({
        identity: 'Example Signing Identity',
        platform: 'darwin',
        runCommand: () => ({ status: 0, stdout: '  1) AABBCCDD "Example Signing Identity"\n', stderr: '' }),
        toolExists: () => true,
      });

      let platformError = '';
      try { assertMacSigningPrerequisites({ identity: 'Example Signing Identity', platform: 'linux' }); }
      catch (cause) { platformError = String(cause?.message || cause); }
      assert(platformError.includes('requires macOS'),
        'the Darwin-only signing preflight rejects direct non-macOS use');
      return { ok: true };
    },
  },
  {
    name: 'macOS packaging: every emitted app gets strict deep codesign verification',
    run: async () => {
      const { findCurrentMacApplications, findMacApplications, signMacApplications, snapshotMacApplications, verifyMacApplications } = await import('../../scripts/build-macos.mjs');
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-package-integrity-'));
      const releaseDir = path.join(root, 'release');
      const appPath = path.join(releaseDir, 'mac-arm64', 'infinite-canvas.app');
      try {
        const resourcesPath = path.join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
        await fs.mkdir(path.dirname(resourcesPath), { recursive: true });
        await fs.writeFile(resourcesPath, 'first signature');
        const apps = findMacApplications(releaseDir);
        assert(apps.length === 1 && apps[0] === appPath,
          `the emitted macOS app must be discovered under the platform output directory, got ${JSON.stringify(apps)}`);

        const calls = [];
        const signed = signMacApplications({
          apps,
          identity: 'Example Signing Identity',
          platform: 'darwin',
          runCommand: (command, args) => {
            calls.push({ command, args });
            return { status: 0, stdout: '', stderr: '' };
          },
        });
        assert(signed[0] === appPath
          && calls.length === 1
          && calls[0].command === '/usr/bin/codesign'
          && JSON.stringify(calls[0].args) === JSON.stringify([
            '--force',
            '--deep',
            '--preserve-metadata=identifier,entitlements,requirements,flags,runtime',
            '--sign',
            'Example Signing Identity',
            appPath,
          ]),
        'each freshly emitted bundle must be explicitly sealed with the configured identity while retaining Electron/runtime signature metadata before verification');

        calls.length = 0;
        const verified = verifyMacApplications({
          apps,
          identity: 'Example Signing Identity',
          // The verifier's Darwin-only guard is asserted directly below. Pin the
          // platform for the injected-runCommand cases so this suite proves the
          // codesign policy on every CI host rather than only on a macOS runner.
          platform: 'darwin',
          runCommand: (command, args) => {
            calls.push({ command, args });
            if (args[0] === '-dv') return { status: 0, stdout: '', stderr: 'Signature=not ad hoc\nAuthority=Example Signing Identity\n' };
            return { status: 0, stdout: '', stderr: '' };
          },
        });
        assert(verified[0] === appPath
          && calls.length === 2
          && calls[0].command === '/usr/bin/codesign'
          && JSON.stringify(calls[0].args) === JSON.stringify(['--verify', '--deep', '--strict', '--verbose=2', appPath]),
        'the final build gate must invoke codesign --verify --deep --strict before inspecting its visible signing Authority');

        let error = '';
        try {
          verifyMacApplications({ apps, identity: 'Example Signing Identity', platform: 'darwin', runCommand: () => ({ status: 1, stdout: '', stderr: 'signature broken' }) });
        } catch (cause) { error = String(cause?.message || cause); }
        assert(error.includes('macOS package integrity verification failed') && error.includes('signature broken'),
          'a failed strict verification must make npm run build fail instead of reporting packaging success');

        const stale = snapshotMacApplications(releaseDir);
        // Leave the outer bundle directory untouched: a valid in-place
        // electron-builder rewrite must still be recognized from CodeResources.
        await fs.writeFile(resourcesPath, 'second signature');
        const fresh = findCurrentMacApplications(releaseDir, stale);
        assert(fresh.length === 1 && fresh[0] === appPath,
          'the verifier selects the app changed by this build, never a pre-existing output bundle');

        let identityError = '';
        try {
          verifyMacApplications({
            apps,
            identity: 'Example Signing Identity',
            platform: 'darwin',
            runCommand: (_command, args) => (args[0] === '-dv'
              ? { status: 0, stdout: '', stderr: 'Signature=adhoc\n' }
              : { status: 0, stdout: '', stderr: '' }),
          });
        } catch (cause) { identityError = String(cause?.message || cause); }
        assert(identityError.includes('Signature=adhoc') && identityError.includes('no Authority'),
          'an ad-hoc or Authority-less signature must fail even if codesign --verify exits cleanly');

        let wrongAuthorityError = '';
        try {
          verifyMacApplications({
            apps,
            identity: 'Example Signing Identity',
            platform: 'darwin',
            runCommand: (_command, args) => (args[0] === '-dv'
              ? { status: 0, stdout: '', stderr: 'Signature=not ad hoc\nAuthority=Different Identity\n' }
              : { status: 0, stdout: '', stderr: '' }),
          });
        } catch (cause) { wrongAuthorityError = String(cause?.message || cause); }
        assert(wrongAuthorityError.includes('expected Authority=Example Signing Identity')
          && wrongAuthorityError.includes('Different Identity'),
        'a bundle signed by a different valid identity must fail the configured-Authority gate');

        let nonDarwinError = '';
        try { verifyMacApplications({ apps, identity: 'Example Signing Identity', platform: 'linux' }); }
        catch (cause) { nonDarwinError = String(cause?.message || cause); }
        assert(nonDarwinError.includes('only run on macOS'),
          'the Darwin-only verifier may never be invoked from a non-macOS build path');

        const staleSecondApp = path.join(releaseDir, 'mac-x64', 'old-output.app');
        await fs.mkdir(staleSecondApp, { recursive: true });
        const noNewApp = snapshotMacApplications(releaseDir);
        let staleError = '';
        try { findCurrentMacApplications(releaseDir, noNewApp); }
        catch (cause) { staleError = String(cause?.message || cause); }
        assert(staleError.includes('did not emit a fresh macOS .app'),
          'a successful builder exit with only stale app bundles must fail rather than verifying a prior build');
        return { ok: true };
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'macOS packaging: npm build uses the signing and integrity gate',
    run: async () => {
      const [{ electronBuilderInvocation, usesMacIntegrityGate }, packageConfig, launcher] = await Promise.all([
        import('../../scripts/build-macos.mjs'),
        fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(process.cwd(), 'scripts', 'launch-app.command'), 'utf8'),
      ]);
      assert(packageConfig.scripts?.build === 'node scripts/build-macos.mjs',
        'npm run build must use the macOS signing/integrity entry point');
      assert(packageConfig.build?.forceCodeSigning == null && packageConfig.build?.mac?.forceCodeSigning === true
        && packageConfig.build?.mac?.identity
        && packageConfig.build?.mac?.timestamp === 'none',
      'electron-builder must enforce local macOS signing, retain its configured identity, and avoid an unavailable timestamp authority');
      assert(usesMacIntegrityGate('darwin') && !usesMacIntegrityGate('linux') && !usesMacIntegrityGate('win32'),
        'only Darwin dispatches through codesign preflight and final integrity verification; other platforms retain the generic build flow');
      const checked = [];
      const invocation = electronBuilderInvocation(process.cwd(), {
        exists: candidate => {
          checked.push(candidate);
          return candidate.endsWith('node_modules/electron-builder/cli.js');
        },
      });
      assert(invocation.command === process.execPath
        && invocation.args.length === 1
        && invocation.args[0].endsWith('node_modules/electron-builder/cli.js')
        && checked.length === 1
        && checked[0] === invocation.args[0],
      'the generic build invokes electron-builder through Node and validates the exact installed JS CLI, never a platform-specific shim');
      const verifyStart = launcher.indexOf('verify_app() {');
      const verifyEnd = launcher.indexOf('\n}', verifyStart);
      const verifyApp = verifyStart >= 0 && verifyEnd > verifyStart ? launcher.slice(verifyStart, verifyEnd) : '';
      assert(verifyApp.includes('codesign --verify --deep --strict "$RELEASE_APP"')
        && !verifyApp.includes('codesign --verify "$RELEASE_APP"'),
      'the launcher must use the same strict deep codesign policy as npm run build before opening an existing bundle');
      assert(launcher.includes('node "$PROJECT_DIR/scripts/source-manifest.mjs"')
        && !launcher.includes("stat -f '%N|%m|%z'"),
      'the launcher must use the content digest instead of a filename/mtime/size stamp');
      const buildStart = launcher.indexOf('npm run build 2>&1 | tee "$LOG"');
      const postBuild = launcher.indexOf('postbuild_manifest="$(source_manifest)"', buildStart);
      const changedDuringBuild = launcher.indexOf('[[ "$postbuild_manifest" != "$manifest" ]]', postBuild);
      const stampWrite = launcher.indexOf('print -r -- "$manifest" > "$STAMP"', changedDuringBuild);
      assert(buildStart >= 0 && postBuild > buildStart && changedDuringBuild > postBuild && stampWrite > changedDuringBuild
        && launcher.includes('setopt local_options pipe_fail')
        && launcher.includes('ls-files -z --cached --others --exclude-standard || return 1'),
      'the launcher fails closed on inventory errors and writes a success stamp only when the source is unchanged after build');
      if (!spawnSync('zsh', ['-c', 'exit 0']).error) {
        const functionStart = launcher.indexOf('source_manifest() {');
        const functionEnd = launcher.indexOf('\n}', functionStart);
        const manifestFunction = launcher.slice(functionStart, functionEnd + 2);
        const failingGit = spawnSync('zsh', ['-c', `
          git() {
            if [[ "$*" == *ls-files* ]]; then return 79; fi
            command git "$@"
          }
          ${manifestFunction}
          source_manifest
        `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PROJECT_DIR: process.cwd() } });
        assert(failingGit.status !== 0,
          `a failed source-list producer must not be hidden by a successful digest consumer (${failingGit.status}: ${failingGit.stderr})`);
        const failingFind = spawnSync('zsh', ['-c', `
          git() { return 1; }
          find() { return 79; }
          ${manifestFunction}
          source_manifest
        `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PROJECT_DIR: process.cwd() } });
        assert(failingFind.status !== 0,
          `a failed fallback source walk must not be hidden by a successful digest consumer (${failingFind.status}: ${failingFind.stderr})`);
        const noEnvRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-launcher-no-env-'));
        try {
          await fs.mkdir(path.join(noEnvRoot, 'scripts'));
          await fs.copyFile(path.join(process.cwd(), 'scripts', 'source-manifest.mjs'), path.join(noEnvRoot, 'scripts', 'source-manifest.mjs'));
          await fs.writeFile(path.join(noEnvRoot, 'source.js'), 'const answer = 42;\n');
          const noEnv = spawnSync('zsh', ['-c', `${manifestFunction}\nsource_manifest`], {
            cwd: noEnvRoot, encoding: 'utf8', env: { ...process.env, PROJECT_DIR: noEnvRoot },
          });
          assert(noEnv.status === 0 && /^[a-f0-9]{64}\n$/.test(noEnv.stdout),
            `a valid source tree without optional .env still produces a digest (${noEnv.status}: stdout=${JSON.stringify(noEnv.stdout)}, stderr=${JSON.stringify(noEnv.stderr)})`);
        } finally {
          await fs.rm(noEnvRoot, { recursive: true, force: true });
        }
      }
      return { ok: true };
    },
  },
  {
    name: 'repo hygiene: no tracked source file holds a raw control byte (a literal NUL makes grep treat the file as binary)',
    run: async () => {
      // The scanner itself: it must flag NUL and other control bytes with file + offset, and pass tab/LF/CR.
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-control-bytes-'));
      try {
        await fs.writeFile(path.join(scratch, 'clean.js'), Buffer.from([97, 9, 10, 13, 98]));
        await fs.writeFile(path.join(scratch, 'nul.js'), Buffer.from([97, 98, 0, 99]));
        await fs.writeFile(path.join(scratch, 'esc.md'), Buffer.from([10, 10, 27]));
        await fs.writeFile(path.join(scratch, 'del.json'), Buffer.from([127]));
        await fs.writeFile(path.join(scratch, 'ignored.bin'), Buffer.from([0]));
        const found = await findRawControlBytes(scratch, ['clean.js', 'nul.js', 'esc.md', 'del.json', 'ignored.bin', 'missing.js']);
        const summary = describeControlBytes(found);
        assert(found.length === 3 && summary === 'nul.js @ byte 2 (0x00); esc.md @ byte 2 (0x1b); del.json @ byte 0 (0x7f)',
          `the control-byte scanner must flag NUL/ESC/DEL with file and offset while ignoring tab, LF, CR and unscanned extensions (got: ${summary})`);
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }

      const root = process.cwd();
      const tracked = listTrackedFiles(root);
      if (!tracked) return { ok: true, skipped: 'git is not usable here (not a work tree)' };
      const offenders = await findRawControlBytes(root, tracked);
      assert(offenders.length === 0,
        `tracked source files must not contain raw control bytes (write escapes such as \\u0000 instead): ${describeControlBytes(offenders)}`);
      return { ok: true };
    },
  },
];
