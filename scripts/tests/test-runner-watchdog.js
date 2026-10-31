import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runnerPath = fileURLToPath(new URL('../test-runner.js', import.meta.url));
const stubPath = fileURLToPath(new URL('../test-stubs/register.mjs', import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export default [
  {
    name: 'test runner: positional filenames select only registered suites',
    run() {
      const child = spawnSync(process.execPath, ['--import', stubPath, runnerPath, 'scripts/tests/base64.js'], {
        encoding: 'utf8', timeout: 10_000, env: { ...process.env, TEST_RUNNER_SELFTEST: '' },
      });
      const output = `${child.stdout || ''}\n${child.stderr || ''}`;
      assert(child.status === 0, `selected suite must pass: ${output}`);
      assert(output.includes('(1 groups)') && output.includes('PASS base64.js ('), `must run only the selected suite: ${output}`);
      assert(!output.includes('PASS interview-'), `must not run unrelated suites: ${output}`);
    },
  },
  {
    name: 'test runner: unknown positional filenames fail before running suites',
    run() {
      const child = spawnSync(process.execPath, ['--import', stubPath, runnerPath, 'missing-suite.js'], {
        encoding: 'utf8', timeout: 10_000, env: { ...process.env, TEST_RUNNER_SELFTEST: '' },
      });
      const output = `${child.stdout || ''}\n${child.stderr || ''}`;
      assert(child.status === 1 && output.includes('Unknown test file(s): missing-suite.js'), `unknown suite must fail closed: ${output}`);
      assert(!output.includes('Deterministic smoke tests'), `unknown suite must not start the full run: ${output}`);
    },
  },
  {
    name: 'test runner: watchdog fails a suspended test and completes the summary',
    run() {
      const child = spawnSync(process.execPath, ['--import', stubPath, runnerPath], {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          ...process.env,
          TEST_RUNNER_SELFTEST: 'never-settles',
          TEST_RUNNER_TIMEOUT_MS: '25',
        },
      });
      const output = `${child.stdout || ''}\n${child.stderr || ''}`;
      assert(child.error === undefined, `watchdog fixture did not finish: ${child.error?.message || 'unknown process error'}`);
      assert(child.status === 1, `watchdog fixture must exit failing, got ${JSON.stringify({ status: child.status, signal: child.signal, output })}`);
      assert(output.includes('FAIL watchdog-fixture.js :: test runner watchdog fixture: never settles'),
        `watchdog fixture must name the exact timed-out group and test: ${output}`);
      assert(output.includes('FAIL watchdog-fixture.js (1/2 tests)'),
        `watchdog fixture must continue after its timed-out test: ${output}`);
      assert(output.includes('[TEST RUNNER] 1 passed, 1 failed'),
        `watchdog fixture must print a final failure summary: ${output}`);
      return { exitCode: child.status, summary: '1 passed, 1 failed' };
    },
  },
];
