import { spawn as nativeSpawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WATCHDOG_SCRIPT } from './constants.js';
import { redactLine } from './redact.js';

export function execFixed(command, args = [], { execFileSyncImpl = execFileSync, spawnSyncImpl = spawnSync } = {}) {
  const fixed = { ps: '/bin/ps', codesign: '/usr/bin/codesign', xattr: '/usr/bin/xattr' }[command];
  if (!fixed) throw new TypeError('unsupported fixed command');
  if (command === 'codesign') {
    const result = spawnSyncImpl(fixed, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    if (result.error || result.status !== 0) throw result.error || Object.assign(new Error('fixed command failed'), { code: result.status });
    return `${result.stdout || ''}${result.stderr || ''}`;
  }
  return execFileSyncImpl(fixed, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
}

export function execBinary(binaryPath, args = [], { spawnSyncImpl = spawnSync, cwd, env, timeoutMs = 5_000, maxOutputBytes = 64 * 1024 } = {}) {
  const envKeys = env && Object.keys(env);
  if (!path.isAbsolute(binaryPath || '') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !path.isAbsolute(cwd || '')
    || JSON.stringify(envKeys) !== JSON.stringify(['PATH', 'HOME', 'TMPDIR']) || env.PATH !== '/usr/bin:/bin:/usr/sbin:/sbin') throw new TypeError('invalid binary command');
  const result = spawnSyncImpl(binaryPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd, env, timeout: timeoutMs, maxBuffer: maxOutputBytes, killSignal: 'SIGKILL' });
  const output = `${result?.stdout || ''}${result?.stderr || ''}`;
  if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) throw Object.assign(new Error('binary output too large'), { code: 'config-rejected', output });
  if (result?.error || result?.status !== 0) throw Object.assign(result?.error || new Error('binary command failed'), { code: 'binary-command-failed', status: result?.status, output });
  return output;
}

export function spawnCloudflared({ appPid = process.pid, binaryPath, args, cwd, env, spawnImpl = null, onLine = null, redact = redactLine, redactContext = {} } = {}) {
  const envKeys = env && Object.keys(env);
  if (!Number.isInteger(appPid) || appPid <= 1 || !path.isAbsolute(binaryPath || '') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !path.isAbsolute(cwd || '')
    || JSON.stringify(envKeys) !== JSON.stringify(['PATH', 'HOME', 'TMPDIR']) || env.PATH !== '/usr/bin:/bin:/usr/sbin:/sbin') throw Object.assign(new Error('bad spawn parameters'), { code: 'spawn-failed' });
  const spawn = spawnImpl || nativeSpawn;
  const child = spawn('/bin/sh', ['-c', WATCHDOG_SCRIPT, 'sh', String(appPid), binaryPath, ...args], { shell: false, detached: true, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pending = { stdout: '', stderr: '' };
  const truncated = { stdout: false, stderr: false };
  const publish = line => { if (!line) return; try { onLine?.(redact(line, redactContext)); } catch { /* output hooks cannot crash supervision */ } };
  const consume = (stream, chunk) => {
    const parts = String(chunk).split(/\r?\n/);
    for (let index = 0; index < parts.length; index++) {
      const last = index === parts.length - 1;
      if (!truncated[stream]) pending[stream] += parts[index].slice(0, Math.max(0, 1024 - pending[stream].length));
      if (!last) {
        publish(pending[stream]);
        pending[stream] = '';
        truncated[stream] = false;
      } else if (pending[stream].length >= 1024 && parts[index].length > 0) truncated[stream] = true;
    }
  };
  child.stdout?.on?.('data', chunk => consume('stdout', chunk)); child.stderr?.on?.('data', chunk => consume('stderr', chunk));
  child.once?.('close', () => { for (const stream of Object.keys(pending)) publish(pending[stream]); pending.stdout = pending.stderr = ''; });
  return child;
}

export function readTextFile(target, { fsImpl = fs } = {}) { return fsImpl.readFileSync(target, 'utf8'); }
