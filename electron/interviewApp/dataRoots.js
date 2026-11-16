// Where the standalone Interview Helper app keeps things.
//
// `profile` is this app's own Electron folder (cookies, cache, single-instance
// lock, and the Claude worker's bookkeeping files that only one process may
// rewrite). `data` is the folder Infinite Canvas created: the interview stores
// and career snapshots stay there so existing work carries over untouched.
import fs from 'node:fs';
import path from 'node:path';

export const INTERVIEW_APP_PROFILE_DIRECTORY = 'Interview Helper';
export const SHARED_DATA_DIRECTORY = 'infinite-canvas';

export function interviewAppDataRoots({ appDataPath, env = {} } = {}) {
  if (typeof appDataPath !== 'string' || !path.isAbsolute(appDataPath)) throw new TypeError('Interview Helper needs the application data path.');
  const override = name => (typeof env[name] === 'string' && path.isAbsolute(env[name]) ? path.resolve(env[name]) : null);
  // The overrides exist so tests and trial runs never touch real interview data.
  const profile = override('INTERVIEW_HELPER_PROFILE_DIR') || path.join(appDataPath, INTERVIEW_APP_PROFILE_DIRECTORY);
  const data = override('INTERVIEW_HELPER_DATA_DIR') || path.join(appDataPath, SHARED_DATA_DIRECTORY);
  if (profile === data) throw new Error('Interview Helper needs a profile folder separate from the shared data folder.');
  return Object.freeze({
    profile, data,
    async ensure() {
      await fs.promises.mkdir(profile, { recursive: true, mode: 0o700 });
      await fs.promises.mkdir(data, { recursive: true, mode: 0o700 });
    },
  });
}
