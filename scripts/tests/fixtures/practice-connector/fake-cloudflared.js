#!/usr/bin/env node
// Executed only by the out-of-band tunnel self-test, never by npm test.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function runFakeCloudflared({ argv = process.argv, env = process.env } = {}) {
  const mode = env.IC_FAKE_CLOUDFLARED_MODE || argv[2] || 'ready';
  const rejectFlag = argv.find(arg => arg === '--grace-period' || arg.startsWith('--management-diagnostics'));
  if (mode === 'reject-flag' && rejectFlag) {
    process.stderr.write(`flag provided but not defined: ${rejectFlag}\n`);
    process.exitCode = 2;
    return;
  }
  if (mode === 'record-argv-env') {
    process.stdout.write(JSON.stringify({ argv: argv.slice(2), env: Object.fromEntries(Object.entries(env).filter(([key]) => ['HOME', 'PATH', 'TMPDIR'].includes(key))) }) + '\n');
  }
  if (mode === 'secret-in-log') process.stderr.write('synthetic tunnel credential marker\n');
  if (mode === 'crash-on-start') {
    process.exitCode = 1;
    return;
  }
  if (mode === 'ready' || mode === 'crash-after-ready' || mode === 'spawn-child') process.stdout.write('ready\n');

  let child = null;
  const stopChild = () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  if (mode === 'spawn-child') {
    // This is deliberately an out-of-band-only real child. It uses the
    // absolute Node executable rather than PATH and is reaped on clean exit.
    child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    process.stdout.write(`child:${child.pid}\n`);
  }
  if (mode === 'crash-after-ready') setTimeout(() => process.exit(1), 20).unref();
  if (mode === 'exit-clean-unrequested') setTimeout(() => process.exit(0), 20).unref();
  if (mode === 'hang-no-ready' || mode === 'ignore-sigterm' || mode === 'ready' || mode === 'spawn-child') {
    process.on('SIGTERM', () => {
      if (mode === 'ignore-sigterm') return;
      stopChild();
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  }
  process.on('exit', stopChild);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runFakeCloudflared();
