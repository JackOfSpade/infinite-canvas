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

// The app runs its own Chrome (headless scraping, login windows) from the same
// Google Chrome.app. With two instances running, `tell application "Google
// Chrome"` reaches whichever one macOS picks — often the app's own, which has
// Apple Events JavaScript off and is not signed in to ChatGPT. Chat launches
// therefore address the person's own Chrome by process id through JXA.
const CHROME_MAIN_BINARY = /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$)/;
const APP_OWNED_CHROME_FLAG = /\s--(?:headless(?:=\S*)?|remote-debugging-port=\S*|remote-debugging-pipe|user-data-dir=)/;

// The person's Chrome: the main Google Chrome binary started without the
// flags the app uses for its own instances. Exported for tests.
export function pickUserChromePid(psOutput) {
  for (const line of String(psOutput || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const args = match[2];
    if (!CHROME_MAIN_BINARY.test(args) || APP_OWNED_CHROME_FLAG.test(` ${args}`)) continue;
    return Number(match[1]);
  }
  return null;
}

async function findUserChromePid() {
  const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,args='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
  return pickUserChromePid(stdout);
}

let userChromePid = null;
async function userChromePidOrLaunch() {
  if (userChromePid) {
    try { process.kill(userChromePid, 0); return userChromePid; } catch { userChromePid = null; }
  }
  userChromePid = await findUserChromePid();
  if (userChromePid) return userChromePid;
  // Not running: open the person's Chrome. `-n` starts a new instance even
  // while the app's own Chrome is running; the default profile then behaves
  // exactly as if they had opened Chrome themselves.
  await execFile('/usr/bin/open', ['-n', '-g', '-b', 'com.google.Chrome'], { timeout: 10_000 });
  for (let attempt = 0; attempt < 30 && !userChromePid; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    userChromePid = await findUserChromePid();
  }
  if (!userChromePid) throw new Error('Google Chrome did not start');
  return userChromePid;
}

// Runs a JXA script against the person's own Chrome. The script's argv[0] is
// that Chrome's process id; the caller's args follow unchanged.
export async function runUserChromeScript(script, args = [], options = {}) {
  const pid = await userChromePidOrLaunch();
  try {
    const { stdout } = await execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, String(pid), ...args], {
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
    return String(stdout ?? '').trim();
  } catch (error) {
    // A Chrome that quit between lookup and call is found again next time.
    try { process.kill(pid, 0); } catch { userChromePid = null; }
    throw error;
  }
}
