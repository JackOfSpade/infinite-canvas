#!/usr/bin/env node

// Focused, isolated Interview Helper checks. This never starts Electron or
// imports the app entry. Usage from the repository root:
// node --import ./scripts/test-stubs/register.mjs scripts/run-interview-tests.mjs
import './test-stubs/register.mjs';
import fs from 'node:fs/promises';
import { blockUnexpectedNetworkRequest } from './test-stubs/networkGuard.mjs';

// Match the unit runner's no-provider-network boundary. Browser e2e tests use
// their own isolated loopback transport rather than this global fetch.
globalThis.fetch = async input => blockUnexpectedNetworkRequest(input);

let summaryPrinted = false;
process.exitCode = 1;
process.on('exit', () => {
  if (summaryPrinted) return;
  process.exitCode = 1;
  process.stderr.write('[INTERVIEW TESTS] Exited before the summary; the run failed.\n');
});

function configuredTimeout() {
  const value = process.env.TEST_TIMEOUT_MS;
  if (value === undefined) return 30_000;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('TEST_TIMEOUT_MS must be a positive integer.');
  return timeout;
}

async function runWithWatchdog(test, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // Keep the event loop alive until an unsettled test is reported as failed.
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => test.run()), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const testDirectory = new URL('./tests/', import.meta.url);
  const files = (await fs.readdir(testDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^interview-.*\.js$/u.test(entry.name))
    .map(entry => entry.name).sort();
  if (!files.length) throw new Error('No Interview Helper suites were discovered.');
  const timeoutMs = configuredTimeout();
  let passed = 0;
  let failed = 0;
  const names = new Set();
  console.log(`[INTERVIEW TESTS] ${files.length} suites`);
  for (const file of files) {
    let tests;
    try {
      tests = (await import(new URL(file, testDirectory))).default;
      if (!Array.isArray(tests) || !tests.length) throw new Error('Suite must default-export a nonempty test array.');
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${file} (suite load):`, error.stack || error.message);
      continue;
    }
    let groupPassed = 0;
    for (const test of tests) {
      try {
        if (!test || typeof test.name !== 'string' || !test.name || typeof test.run !== 'function') throw new Error('Invalid test declaration.');
        if (names.has(test.name)) throw new Error(`Duplicate test name: ${test.name}`);
        names.add(test.name);
        const details = await runWithWatchdog(test, /e2e/u.test(file) ? Math.max(timeoutMs, 180_000) : timeoutMs);
        passed += 1;
        groupPassed += 1;
        if (process.env.TEST_VERBOSE === '1') console.log(`PASS ${test.name}`, details ? JSON.stringify(details) : '');
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${file} :: ${test?.name || '(unnamed test)'}:`, error.stack || error.message);
      }
    }
    console.log(`${groupPassed === tests.length ? 'PASS' : 'FAIL'} ${file} (${groupPassed}/${tests.length} tests)`);
  }
  console.log(`[INTERVIEW TESTS] ${passed} passed, ${failed} failed across ${files.length} suites`);
  summaryPrinted = true;
  process.exitCode = failed ? 1 : 0;
}

run().catch(error => {
  console.error('[INTERVIEW TESTS] Fatal error:', error.stack || error.message);
  process.exitCode = 1;
});
