#!/usr/bin/env node
// Deliberately outside npm test. On macOS this starts at most five generated
// fake cloudflared children: one own-status crash, one direct TERM case, and
// three watchdog-hosted children at different phases of the one-second poll.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFakeCloudflaredLauncher } from './tests/fixtures/handoff-bridge/bridgeFixtures.js';
import { spawnCloudflared } from '../electron/ipc/handoffBridge/tunnel/exec.js';
import { reapOrphans } from '../electron/ipc/handoffBridge/tunnel/reap.js';
import { parsePsRows } from '../electron/ipc/handoffBridge/tunnel/psParse.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const isGone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
const killPid = (pid, signal = 'SIGKILL') => { try { process.kill(pid, signal); } catch { /* already gone */ } };
const killGroup = (pid, signal = 'SIGKILL') => { try { process.kill(-pid, signal); } catch { /* already gone */ } };
const quote = value => JSON.stringify(String(value));

async function waitFor(predicate, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (predicate()) return; await delay(20); }
  throw new Error(`${label} timed out`);
}

function processRow(pid) {
  try {
    return parsePsRows(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000, maxBuffer: 64 * 1024,
    }))[0] || null;
  } catch { return null; }
}

if (process.platform !== 'darwin') {
  console.error('tunnel self-test is darwin-only');
  process.exitCode = 2;
} else {
  const fixture = writeFakeCloudflaredLauncher();
  const directChildren = []; const hostedPids = []; let host = null; let lookalike = null;
  const cleanup = () => {
    killPid(host?.pid); killGroup(lookalike?.pid);
    for (const pid of hostedPids) killGroup(pid);
    for (const child of directChildren) killGroup(child.pid);
    fixture.cleanup();
  };
  process.once('exit', cleanup);
  try {
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir() };
    const runDirect = async (mode, terminate = false) => {
      const lines = [];
      const child = spawnCloudflared({ binaryPath: fixture.launcher, args: [mode], cwd: fixture.directory, env, onLine: line => lines.push(line) });
      directChildren.push(child);
      const exited = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${mode} did not exit within 6 seconds`)), 6_000);
        child.once('exit', (code, signal) => { clearTimeout(timeout); resolve([code, signal]); });
      });
      let termStartedAt = null;
      if (terminate) { await delay(100); termStartedAt = Date.now(); child.kill('SIGTERM'); }
      const [code, signal] = await exited;
      const termLatency = termStartedAt === null ? null : Date.now() - termStartedAt;
      await waitFor(() => isGone(child.pid), 500, `${mode} wrapper cleanup`);
      return { code, signal, lines, pid: child.pid, termLatency };
    };

    const crashed = await runDirect('crash-on-start');
    if (crashed.code !== 1) throw new Error(`child exit status did not pass through watchdog (${crashed.code}/${crashed.signal})`);
    const terminated = await runDirect('ready', true);
    if (terminated.code !== 0 || terminated.termLatency > 500) throw new Error(`TERM-mid-sleep wrapper took ${terminated.termLatency}ms or returned ${terminated.code}`);

    const fakePath = fileURLToPath(new URL('./tests/fixtures/handoff-bridge/fake-cloudflared.js', import.meta.url));
    const recordPath = path.join(fixture.directory, 'record.json');
    const recordProgram = path.join(fixture.directory, 'record-and-wait.mjs');
    const recordLauncher = path.join(fixture.directory, 'record-cloudflared');
    fs.writeFileSync(recordProgram, `import fs from 'node:fs';\nfs.writeFileSync(${quote(recordPath)}, JSON.stringify({argv:process.argv.slice(2),env:Object.fromEntries(Object.entries(process.env).filter(([key])=>['HOME','PATH','TMPDIR'].includes(key))),cwd:process.cwd()}));\nprocess.on('SIGTERM',()=>process.exit(0));\nsetInterval(()=>{},1000);\n`, { mode: 0o600 });
    fs.writeFileSync(recordLauncher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recordProgram)} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(recordLauncher, 0o755);

    const orphanRoot = path.join(fixture.directory, 'orphan user');
    const tunnelRoot = path.join(orphanRoot, 'handoff-bridge', 'tunnel');
    const binRoot = path.join(tunnelRoot, 'bin');
    const configPath = path.join(tunnelRoot, 'config.yml');
    const pidfile = path.join(tunnelRoot, 'tunnel.pid.json');
    const ownedLauncher = path.join(binRoot, 'cloudflared-deadbeef');
    fs.mkdirSync(binRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownedLauncher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakePath)} ignore-sigterm "$@"\n`, { mode: 0o755 });
    fs.chmodSync(ownedLauncher, 0o755);

    // The helper owns three wrappers launched 333 ms apart. The middle one
    // has the exact app-copy/config marker and becomes the real reaper target.
    const productionArgs = ['tunnel', '--config', configPath, '--no-autoupdate', '--grace-period', '2s', '--management-diagnostics=false', 'run', '123e4567-e89b-42d3-a456-426614174000'];
    const launches = [
      { name: 'record', binaryPath: recordLauncher, args: ['record-argv-env', 'literal-value'] },
      { name: 'owned-ignore', binaryPath: ownedLauncher, args: productionArgs },
      { name: 'spawn-child', binaryPath: fixture.launcher, args: ['spawn-child'] },
    ];
    const execUrl = new URL('../electron/ipc/handoffBridge/tunnel/exec.js', import.meta.url).href;
    const hostProgram = `import { spawnCloudflared } from ${JSON.stringify(execUrl)};\nconst env=${JSON.stringify(env)},cwd=${JSON.stringify(fixture.directory)},launches=${JSON.stringify(launches)};\nfor(let i=0;i<launches.length;i++)setTimeout(()=>{const item=launches[i];const child=spawnCloudflared({binaryPath:item.binaryPath,args:item.args,cwd,env,onLine:line=>process.stdout.write('LINE:'+line+'\\n')});process.stdout.write('PID:'+child.pid+':'+item.name+'\\n');},i*333);\nsetInterval(()=>{},1000);`;
    const hostLines = []; let hostPending = '';
    host = spawn(process.execPath, ['--input-type=module', '--eval', hostProgram], { stdio: ['ignore', 'pipe', 'pipe'] });
    const readHost = chunk => { hostPending += String(chunk); const lines = hostPending.split('\n'); hostPending = lines.pop(); hostLines.push(...lines.filter(Boolean)); };
    host.stdout.on('data', readHost); host.stderr.on('data', readHost);
    await waitFor(() => hostLines.filter(line => line.startsWith('PID:')).length === 3 && fs.existsSync(recordPath), 3_000, 'watchdog helper start');
    const hosted = new Map(hostLines.filter(line => line.startsWith('PID:')).map(line => { const [, pid, name] = line.split(':'); return [name, Number(pid)]; }));
    hostedPids.push(...hosted.values());
    if ([...hosted.values()].some(pid => !Number.isInteger(pid) || isGone(pid))) throw new Error('hosted wrapper did not start');
    await waitFor(() => hostLines.some(line => line.startsWith('LINE:child:')), 3_000, 'hosted grandchild');
    const grandchildPid = Number(hostLines.find(line => line.startsWith('LINE:child:')).slice('LINE:child:'.length));

    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (JSON.stringify(record.argv) !== JSON.stringify(['record-argv-env', 'literal-value'])) throw new Error(`argv recording drifted: ${JSON.stringify(record.argv)}`);
    if (JSON.stringify(Object.keys(record.env).sort()) !== JSON.stringify(['HOME', 'PATH', 'TMPDIR'])
      || Object.entries(env).some(([key, value]) => record.env[key] !== value)) throw new Error(`environment was not the exact allow-list: ${JSON.stringify(record.env)}`);
    if (fs.realpathSync(record.cwd) !== fs.realpathSync(fixture.directory)) throw new Error(`cwd was not the tunnel directory: ${record.cwd}`);
    for (const [name, pid] of hosted) {
      const row = processRow(pid);
      if (!row || row.pgid !== pid) throw new Error(`${name} wrapper did not own its process group (${JSON.stringify(row)})`);
    }

    const ownedPid = hosted.get('owned-ignore'); const ownedRow = processRow(ownedPid);
    fs.writeFileSync(pidfile, JSON.stringify({ v: 1, pid: ownedPid, pgid: ownedPid, lstart: ownedRow.lstart, configPath, createdAt: Date.now() }), { mode: 0o600 });
    const otherConfig = path.join(tunnelRoot, 'different-config.yml');
    lookalike = spawn('/bin/sh', ['-c', "trap 'exit 0' TERM INT; while :; do sleep 1; done", 'sh', ownedLauncher, 'tunnel', '--config', otherConfig, '--no-autoupdate', 'run', 'lookalike'], { detached: true, stdio: 'ignore' });
    await waitFor(() => processRow(lookalike.pid)?.pgid === lookalike.pid, 1_000, 'different-config look-alike');

    const hostExited = new Promise(resolve => host.once('exit', resolve));
    const crashStartedAt = Date.now(); host.kill('SIGKILL'); await hostExited;
    await waitFor(() => processRow(ownedPid)?.ppid === 1, 1_000, 'launchd reparenting');
    const reaped = await reapOrphans({ userData: orphanRoot, configPath, parentPid: host.pid, wait: delay });
    if (reaped.reaped !== 1 || !reaped.notices.includes('orphan-stopped')) throw new Error(`real orphan was not reaped: ${JSON.stringify(reaped)}`);
    if (!reaped.notices.includes('foreign-connector')) throw new Error('different-config connector was not reported as foreign');
    if (isGone(lookalike.pid)) throw new Error('different-config look-alike was touched');
    await Promise.all([...hosted.values()].map(pid => waitFor(() => isGone(pid), 6_000, `wrapper ${pid} after helper SIGKILL`)));
    await waitFor(() => isGone(grandchildPid), 6_000, 'watchdog process-group grandchild');
    const crashLatency = Date.now() - crashStartedAt;
    if (crashLatency > 6_000) throw new Error(`helper crash left a child alive for ${crashLatency}ms`);

    console.log(`tunnel watchdog self-test passed (five fake children; exit=${crashed.code}; TERM-mid-sleep=${terminated.termLatency}ms; helper-crash/reaper=${crashLatency}ms across 0/333/666ms poll offsets; reparented orphan and grandchild gone; different-config look-alike survived)`);
  } catch (error) {
    console.error(`tunnel watchdog self-test failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    cleanup(); process.removeListener('exit', cleanup);
  }
}
