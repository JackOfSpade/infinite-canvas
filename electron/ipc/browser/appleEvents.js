import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export function isAppleEventsJsDisabledError(msg) {
  const value = String(msg || '');
  return /JavaScript through AppleScript is turned off/i.test(value)
    || /Allow JavaScript from Apple Events/i.test(value)
    || /Executing JavaScript through AppleScript/i.test(value);
}

// Page text travels as an argv item, never as part of AppleScript source.
export async function runChromeAppleScript(script, args = [], options = {}) {
  const { stdout } = await execFile('/usr/bin/osascript', ['-e', script, ...args], {
    timeout: options.timeout ?? 10_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  return String(stdout ?? '').trim();
}
