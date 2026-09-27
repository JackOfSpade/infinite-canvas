import { EventEmitter } from 'node:events';

export function createFakeSpawn({ processTable, pidStart = 2000 } = {}) {
  let nextPid = pidStart;
  const calls = [];
  const spawn = (command, args = [], options = {}) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    const row = processTable?.add({ pid: child.pid, argv: [command, ...args], options });
    const finish = (code = 0, signal = null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.signalCode = signal;
      processTable?.markExited(child.pid);
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    };
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true;
      const alive = processTable?.kill(child.pid, signal);
      if (alive !== false) queueMicrotask(() => finish(signal === 'SIGKILL' ? null : 0, signal));
      return alive !== false;
    };
    child.__emitError = error => child.emit('error', error);
    child.__exit = finish;
    child.__writeStdout = value => child.stdout.emit('data', Buffer.from(value));
    child.__writeStderr = value => child.stderr.emit('data', Buffer.from(value));
    calls.push({ command, args: [...args], options: { ...options }, child, row });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  spawn.calls = calls;
  spawn.last = () => calls.at(-1) || null;
  return spawn;
}
