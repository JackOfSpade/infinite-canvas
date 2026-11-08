/**
 * Reads the ElevenLabs API key from the login keychain.
 * The secret is only ever the resolved value: it is never logged, never attached to an
 * error and never returned in any other object. execFile is injected so the lookup can be
 * exercised without touching the real keychain.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { userInfo } from 'node:os';

export const KEYCHAIN_SERVICE = 'infinite-canvas-elevenlabs-api-key';
export const SECURITY_BIN = '/usr/bin/security';

const FAILURE_MESSAGE = 'could not read the ElevenLabs API key from the keychain';

function readFailure(code, cause) {
  const error = new Error(FAILURE_MESSAGE);
  error.code = code;
  // Only the child-process exit code is copied: stdout/stderr could echo the secret.
  if (cause && typeof cause.code === 'number') error.exitCode = cause.code;
  return error;
}

/**
 * @param {object} [options]
 * @param {Function} [options.execFile] node:child_process execFile-compatible function
 * @param {string} [options.user] keychain account name, defaults to the login user
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} the API key
 */
export function readElevenLabsKey({ execFile = nodeExecFile, user, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const aborted = new Error('keychain lookup aborted');
      aborted.name = 'AbortError';
      aborted.code = 'ABORTED';
      reject(aborted);
      return;
    }
    let account;
    try {
      account = user || userInfo().username;
    } catch {
      reject(readFailure('voice-auth', null));
      return;
    }
    const args = ['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w'];
    const onResult = (error, stdout) => {
      if (error) {
        reject(readFailure('voice-auth', error));
        return;
      }
      const key = String(stdout ?? '').trim();
      if (!key) {
        reject(readFailure('voice-auth', null));
        return;
      }
      resolve(key);
    };
    try {
      execFile(SECURITY_BIN, args, onResult);
    } catch (error) {
      reject(readFailure('voice-auth', error));
    }
  });
}

export default readElevenLabsKey;
