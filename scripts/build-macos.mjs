#!/usr/bin/env node
/**
 * macOS packaging entry point.
 *
 * electron-builder's completion only says its packaging process exited cleanly;
 * it is not an integrity assertion for every nested signature in the emitted
 * application bundle. Keep the configured electron-builder identity intact,
 * reject a machine that cannot use it before doing expensive work, and make a
 * strict deep codesign verification the final success condition.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PACKAGING_LOCK_DIRECTORY = '.packaging-build.lock';
export const PACKAGING_RECLAIM_GUARD_DIRECTORY = '.packaging-build.reclaim-guard.lock';
export const PACKAGING_RECLAIM_CLAIMS_DIRECTORY = '.packaging-build.reclaim-claims';
const UNKNOWN_LOCK_STALE_MS = 5 * 60_000;

function commandFailure(label, result) {
  const detail = [result?.stdout, result?.stderr]
    .filter(Boolean)
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
    .join('\n')
    .trim();
  return new Error(`${label}${detail ? `\n${detail}` : ''}`);
}

export function packagingLockPath(projectDir = process.cwd()) {
  // Deliberately separate from scripts/launch-app.command's
  // release/.launcher/build.lock: direct npm builds and Finder launches need
  // distinct ownership protocols, but concurrent direct package builds must
  // serialize writes to the same electron-builder output directory.
  return path.join(projectDir, 'release', PACKAGING_LOCK_DIRECTORY);
}

export function packagingReclaimGuardPath(projectDir = process.cwd()) {
  return path.join(projectDir, 'release', PACKAGING_RECLAIM_GUARD_DIRECTORY);
}

function reclaimClaimPath(projectDir, guardToken) {
  return path.join(projectDir, 'release', PACKAGING_RECLAIM_CLAIMS_DIRECTORY, `${guardToken}.lock`);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves a process exists but belongs to another user. Treat any
    // other error as dead; a reused PID can only cause a safe false contention.
    return error?.code === 'EPERM';
  }
}

function lockOwner(lockPath) {
  try {
    const raw = fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath, now) {
  try { return Math.max(0, now() - fs.statSync(lockPath).mtimeMs); }
  catch { return Infinity; }
}

function quarantineLock(lockPath, token) {
  const quarantine = `${lockPath}.reclaim-${token}`;
  fs.renameSync(lockPath, quarantine);
  fs.rmSync(quarantine, { recursive: true, force: true });
}

function releaseOwnedLock(lockPath, token) {
  const ownerNow = lockOwner(lockPath);
  if (ownerNow?.token !== token) return;
  try { quarantineLock(lockPath, token); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function validLockToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(token);
}

function recoverDeadReclaimGuard(projectDir, {
  now,
  pid,
  token,
  pidAlive,
  onReclaimGuardRecoveryClaim = null,
} = {}) {
  const guardPath = packagingReclaimGuardPath(projectDir);
  const owner = lockOwner(guardPath);
  const ageMs = lockAgeMs(guardPath, now);
  if (!owner || !validLockToken(owner.token) || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { state: 'guard-manual', ageMs };
  }
  if (pidAlive(owner.pid)) return { state: 'guard-live', pid: owner.pid, ageMs };

  // A claim is keyed by the dead guard's immutable owner token. Every
  // concurrent reclaimer of this generation competes for the SAME atomic
  // mkdir. The winner re-reads the guard before moving it; losers never touch
  // the guard. This avoids creating another stale-lock TOCTOU recursively.
  const claimPath = reclaimClaimPath(projectDir, owner.token);
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  try {
    fs.mkdirSync(claimPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const claimOwner = lockOwner(claimPath);
      if (claimOwner?.pid && pidAlive(claimOwner.pid)) {
        return { state: 'guard-reclaiming', pid: claimOwner.pid, ageMs };
      }
      // Do not recursively reclaim a dead claim: that would recreate the
      // exact compare-then-remove race this claim prevents. A crashed guard
      // with no claim is recovered automatically above; a crashed reclaimer
      // leaves an explicit, bounded manual intervention path instead.
      return { state: 'guard-manual', ageMs };
    }
    throw error;
  }
  const claimToken = `${token}-guard-claim`;
  try {
    fs.writeFileSync(path.join(claimPath, 'owner.json'), `${JSON.stringify({ pid, token: claimToken, startedAt: new Date(now()).toISOString(), guardToken: owner.token })}\n`, { encoding: 'utf8', flag: 'wx' });
    onReclaimGuardRecoveryClaim?.();
    const current = lockOwner(guardPath);
    if (!current || current.token !== owner.token) return { state: 'guard-changed', ageMs };
    if (pidAlive(current.pid)) return { state: 'guard-live', pid: current.pid, ageMs };
    quarantineLock(guardPath, `${token}-dead-guard`);
    return { state: 'guard-recovered', pid: owner.pid, ageMs };
  } finally {
    releaseOwnedLock(claimPath, claimToken);
  }
}

function acquireReclaimGuard(projectDir, {
  now,
  pid,
  token,
  pidAlive,
  onReclaimGuardRecoveryClaim,
} = {}) {
  const guardPath = packagingReclaimGuardPath(projectDir);
  try {
    fs.mkdirSync(guardPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return recoverDeadReclaimGuard(projectDir, { now, pid, token, pidAlive, onReclaimGuardRecoveryClaim });
    }
    throw error;
  }
  const guardToken = `${token}-reclaim`;
  try {
    fs.writeFileSync(path.join(guardPath, 'owner.json'), `${JSON.stringify({ pid, token: guardToken, startedAt: new Date(now()).toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    try { quarantineLock(guardPath, guardToken); } catch {}
    throw commandFailure(`Could not record packaging reclaim-guard ownership at ${guardPath}.`, { error });
  }
  return {
    state: 'guard-acquired',
    guardPath,
    release() { releaseOwnedLock(guardPath, guardToken); },
  };
}

function reclaimCurrentStalePackagingLock(projectDir, {
  now,
  pid,
  token,
  pidAlive,
  onReclaimGuardRecoveryClaim,
} = {}) {
  const guard = acquireReclaimGuard(projectDir, { now, pid, token, pidAlive, onReclaimGuardRecoveryClaim });
  if (guard.state !== 'guard-acquired') return guard;
  const lockPath = packagingLockPath(projectDir);
  try {
    // This re-read under the exclusive guard closes the stale-lock TOCTOU:
    // another contender may have already reclaimed S and acquired A before we
    // got the guard, in which case A is assessed here and never quarantined.
    if (!fs.existsSync(lockPath)) return { state: 'gone' };
    const owner = lockOwner(lockPath);
    if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
      if (pidAlive(owner.pid)) return { state: 'live', pid: owner.pid };
    } else if (lockAgeMs(lockPath, now) < UNKNOWN_LOCK_STALE_MS) {
      return { state: 'initializing' };
    }
    quarantineLock(lockPath, `${token}-stale`);
    return { state: 'reclaimed' };
  } finally {
    guard.release();
  }
}

/**
 * Atomically acquire the per-workspace package lock. A stale owner is only
 * reclaimed after its PID is confirmed dead; ownerless/corrupt locks get a
 * five-minute grace period so a creator cannot be deleted during its tiny
 * mkdir→owner-file window. Rename-before-remove ensures cleanup targets only
 * the lock generation it inspected, never a newly acquired replacement.
 */
export function acquirePackagingLock(projectDir = process.cwd(), {
  now = () => Date.now(),
  pid = process.pid,
  token = crypto.randomUUID(),
  pidAlive = isPidAlive,
  onMainLockContention = null,
  onReclaimGuardRecoveryClaim = null,
} = {}) {
  const lockPath = packagingLockPath(projectDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lockPath);
      const owner = { pid, token, startedAt: new Date(now()).toISOString() };
      try {
        fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        try { quarantineLock(lockPath, token); } catch {}
        throw commandFailure(`Could not record packaging lock ownership at ${lockPath}.`, { error });
      }
      let released = false;
      return {
        lockPath,
        release() {
          if (released) return;
          released = true;
          releaseOwnedLock(lockPath, token);
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      onMainLockContention?.();
      const reclaim = reclaimCurrentStalePackagingLock(projectDir, { now, pid, token, pidAlive, onReclaimGuardRecoveryClaim });
      if (reclaim.state === 'reclaiming' || reclaim.state === 'guard-reclaiming') {
        throw new Error(`Another process is reclaiming a stale workspace package lock; retry npm run build shortly.`);
      }
      if (reclaim.state === 'guard-live') {
        throw new Error(`Another process is reclaiming a stale workspace package lock (pid ${reclaim.pid}); retry npm run build shortly.`);
      }
      if (reclaim.state === 'guard-manual') {
        throw new Error(`The stale workspace reclaim guard cannot be recovered safely automatically (age ${Math.round(reclaim.ageMs)}ms); remove ${packagingReclaimGuardPath(projectDir)} and its matching reclaim claim manually only after confirming no build is running.`);
      }
      if (reclaim.state === 'live') {
        throw new Error(`Another package build is already running for this workspace (pid ${reclaim.pid}); wait for it to finish before running npm run build again.`);
      }
      if (reclaim.state === 'initializing') {
        throw new Error(`Another package build is initializing its workspace lock at ${lockPath}; retry npm run build shortly.`);
      }
    }
  }
  throw new Error(`Could not acquire the workspace package lock at ${lockPath}; another build changed it while stale state was being reclaimed.`);
}

export function withPackagingLock(projectDir, operation, options = {}) {
  const lock = acquirePackagingLock(projectDir, options);
  try { return operation(); }
  finally { lock.release(); }
}

export function readConfiguredMacSigningConfig(projectDir = process.cwd()) {
  const packagePath = path.join(projectDir, 'package.json');
  const packageConfig = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (packageConfig?.build?.mac?.forceCodeSigning !== true) {
    throw new Error('macOS packaging requires build.mac.forceCodeSigning to be true.');
  }
  const identity = packageConfig?.build?.mac?.identity;
  if (typeof identity !== 'string' || !identity.trim()) {
    throw new Error('macOS packaging requires build.mac.identity to name a configured code-signing identity.');
  }
  return { identity: identity.trim() };
}

export function readConfiguredSigningIdentity(projectDir = process.cwd()) {
  return readConfiguredMacSigningConfig(projectDir).identity;
}

function hasIdentity(securityOutput, identity) {
  return securityOutput.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]+)\s+"([^"]+)"/i);
    return Boolean(match && (match[1] === identity || match[2] === identity));
  });
}

export function assertMacSigningPrerequisites({
  identity,
  platform = process.platform,
  runCommand = spawnSync,
  toolExists = fs.existsSync,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('macOS packaging requires macOS: the configured signing identity must be verified with security(1).');
  }
  if (!identity || identity === '-') {
    throw new Error('macOS packaging requires a named configured signing identity; ad-hoc signing is not accepted.');
  }
  if (!toolExists('/usr/bin/codesign') || !toolExists('/usr/bin/security')) {
    throw new Error('macOS packaging requires /usr/bin/codesign and /usr/bin/security.');
  }

  const result = runCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  if (result?.error || result?.status !== 0) {
    throw commandFailure('Could not inspect macOS code-signing identities.', result);
  }
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
    .join('\n');
  if (!hasIdentity(output, identity)) {
    throw new Error(`No valid macOS code-signing identity matching "${identity}" is available. Import or configure that certificate, then retry; npm run build intentionally stops before emitting an unsigned or partially signed app.`);
  }
}

export function findMacApplications(releaseDir) {
  let platformDirs;
  try { platformDirs = fs.readdirSync(releaseDir, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`electron-builder did not create its release directory: ${releaseDir}`);
    throw error;
  }

  const apps = [];
  for (const entry of platformDirs) {
    if (!entry.isDirectory() || !/^mac(?:-|$)/.test(entry.name)) continue;
    const platformDir = path.join(releaseDir, entry.name);
    for (const candidate of fs.readdirSync(platformDir, { withFileTypes: true })) {
      if (candidate.isDirectory() && candidate.name.endsWith('.app')) apps.push(path.join(platformDir, candidate.name));
    }
  }
  if (!apps.length) throw new Error(`electron-builder did not emit a macOS .app under ${releaseDir}.`);
  return apps.sort();
}

export function snapshotMacApplications(releaseDir) {
  try {
    return new Map(findMacApplications(releaseDir).map((appPath) => {
      const stat = fs.statSync(appPath);
      // A builder can update an existing bundle in place, leaving the outer
      // directory metadata unchanged. CodeResources is written by codesign
      // after nested resources are sealed, so its content identifies a fresh
      // signed bundle without scanning the app's many gigabytes of resources.
      const resources = path.join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
      const resourceHash = fs.existsSync(resources)
        ? crypto.createHash('sha256').update(fs.readFileSync(resources)).digest('hex')
        : 'missing';
      return [appPath, `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${resourceHash}`];
    }));
  } catch (error) {
    if (/did not create its release directory|did not emit a macOS .app/.test(String(error?.message || error))) return new Map();
    throw error;
  }
}

export function findCurrentMacApplications(releaseDir, before) {
  const current = findMacApplications(releaseDir).filter((appPath) => {
    const stat = fs.statSync(appPath);
    const resources = path.join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
    const resourceHash = fs.existsSync(resources)
      ? crypto.createHash('sha256').update(fs.readFileSync(resources)).digest('hex')
      : 'missing';
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${resourceHash}`;
    return before.get(appPath) !== fingerprint;
  });
  if (!current.length) {
    throw new Error('electron-builder reported success but did not emit a fresh macOS .app; refusing to verify a stale bundle.');
  }
  return current;
}

export function verifyMacApplications({
  apps,
  identity,
  platform = process.platform,
  runCommand = spawnSync,
} = {}) {
  if (platform !== 'darwin') throw new Error('macOS package integrity verification can only run on macOS.');
  if (!Array.isArray(apps) || !apps.length) throw new Error('At least one freshly emitted macOS application is required to verify package integrity.');
  if (!identity || identity === '-') throw new Error('A named configured signing identity is required to verify macOS package integrity.');
  for (const appPath of apps) {
    const result = runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (result?.error || result?.status !== 0) {
      throw commandFailure(`macOS package integrity verification failed for ${appPath}.`, result);
    }
    const details = runCommand('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
    if (details?.error || details?.status !== 0) {
      throw commandFailure(`Could not inspect the macOS signing identity for ${appPath}.`, details);
    }
    const output = [details.stdout, details.stderr]
      .filter(Boolean)
      .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
      .join('\n');
    const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map(match => match[1].trim());
    if (/^Signature=adhoc$/mi.test(output) || !authorities.length || !authorities.includes(identity)) {
      throw new Error(`macOS package signing identity verification failed for ${appPath}: expected Authority=${identity}, found ${authorities.length ? authorities.join(' | ') : 'no Authority'}${/^Signature=adhoc$/mi.test(output) ? ' (Signature=adhoc)' : ''}.`);
    }
  }
  return apps;
}

// electron-builder normally signs a macOS app itself. On current macOS builds,
// however, a local (non-Developer-ID) identity can be reported in its log while
// the final `dir` target is still ad-hoc signed. Seal the freshly emitted bundle
// explicitly before verification so the configured identity is the authority
// that reaches the release artifact, rather than trusting that log line.
export function signMacApplications({
  apps,
  identity,
  platform = process.platform,
  runCommand = spawnSync,
} = {}) {
  if (platform !== 'darwin') throw new Error('macOS package signing can only run on macOS.');
  if (!Array.isArray(apps) || !apps.length) throw new Error('At least one freshly emitted macOS application is required to sign package integrity.');
  if (!identity || identity === '-') throw new Error('A named configured signing identity is required to sign macOS package integrity.');
  for (const appPath of apps) {
    const result = runCommand('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--preserve-metadata=identifier,entitlements,requirements,flags,runtime',
      '--sign',
      identity,
      appPath,
    ], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (result?.error || result?.status !== 0) {
      throw commandFailure(`macOS package signing failed for ${appPath}.`, result);
    }
  }
  return apps;
}

function runOrThrow(command, args, { cwd }) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result?.error || result?.status !== 0) throw commandFailure(`${path.basename(command)} ${args.join(' ')} failed.`, result);
}

function compileApplication(projectDir) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) runOrThrow(process.execPath, [npmCli, 'run', 'build:compile'], { cwd: projectDir });
  else runOrThrow('npm', ['run', 'build:compile'], { cwd: projectDir });
}

export function electronBuilderInvocation(projectDir, {
  exists = fs.existsSync,
} = {}) {
  // Execute the dependency's JavaScript CLI with Node. This is argv-safe on
  // every platform and avoids spawning `.cmd` directly (which requires a
  // shell on Windows) or relying on the POSIX `.bin` shebang shim.
  const builderCli = path.join(projectDir, 'node_modules', 'electron-builder', 'cli.js');
  if (!exists(builderCli)) throw new Error('electron-builder is not installed. Run npm install before packaging.');
  return { command: process.execPath, args: [builderCli] };
}

function packageApplication(projectDir, platform = process.platform) {
  const { command, args } = electronBuilderInvocation(projectDir);
  runOrThrow(command, args, { cwd: projectDir });
}

export function usesMacIntegrityGate(platform = process.platform) {
  return platform === 'darwin';
}

export function buildMacApplication(projectDir = process.cwd()) {
  const { identity } = readConfiguredMacSigningConfig(projectDir);
  assertMacSigningPrerequisites({ identity });

  compileApplication(projectDir);
  const releaseDir = path.join(projectDir, 'release');
  const before = snapshotMacApplications(releaseDir);
  packageApplication(projectDir, 'darwin');

  const apps = findCurrentMacApplications(releaseDir, before);
  signMacApplications({ apps, identity });
  return verifyMacApplications({ apps, identity });
}

export function buildApplication(projectDir = process.cwd(), platform = process.platform) {
  return withPackagingLock(projectDir, () => {
  // Preserve the project's generic electron-builder behavior on non-macOS
  // hosts. A macOS signature cannot be inspected there, so do not pretend to
  // offer the Darwin integrity guarantee or invoke codesign at all.
  if (!usesMacIntegrityGate(platform)) {
    compileApplication(projectDir);
    packageApplication(projectDir, platform);
    return [];
  }
  return buildMacApplication(projectDir);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const apps = buildApplication();
    if (usesMacIntegrityGate()) process.stdout.write(`Verified macOS package integrity: ${apps.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
