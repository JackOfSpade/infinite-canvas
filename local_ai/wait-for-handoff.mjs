#!/usr/bin/env node
/**
 * Deterministic terminal-state wait for a Local AI application handoff.
 *
 * This intentionally does not infer a deadline from result.json. The app is
 * allowed to remove that private file (and its whole job directory) as soon as
 * a bundle is durably saved, so both are normal terminal observations.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_AI_HANDOFF_POLL_MS = 3 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readJsonIfFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function directoryExists(dir) {
  try {
    await fs.readdir(dir);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function matchingReceipt(receipt, jobId, resultSha256) {
  return receipt?.version === 1
    && receipt?.jobId === jobId
    && receipt?.status === 'imported'
    && receipt?.resultSha256 === resultSha256;
}

function matchingFeedback(feedback, jobId, resultSha256) {
  return feedback?.jobId === jobId && feedback?.resultSha256 === resultSha256
    ? feedback
    : null;
}

/**
 * Observe a handoff once. Receipt intentionally comes before the directory
 * probe: it preserves final app measurements when cleanup has already run.
 */
export async function inspectLocalAiHandoff({ jobFolder, receiptFile, jobId, resultSha256 }) {
  const receipt = await readJsonIfFile(receiptFile);
  if (matchingReceipt(receipt, jobId, resultSha256)) {
    return { outcome: 'imported', receipt };
  }

  if (!await directoryExists(jobFolder)) {
    // A matching receipt is the sole durable proof of a successful import.
    // The app can also remove a folder when a card/job is discarded or stale
    // work is pruned, neither of which is an accepted application.
    return { outcome: 'job-folder-gone-unconfirmed' };
  }

  // A result can disappear between this read and a sibling read because the
  // application is importing it. That is a normal race; the next poll checks
  // receipt/folder again instead of converting it into a failed deadline.
  let resultRaw;
  try { resultRaw = await fs.readFile(path.join(jobFolder, 'result.json'), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { outcome: 'waiting' };
    throw error;
  }
  if (sha256(resultRaw) !== resultSha256) return { outcome: 'waiting' };

  const feedback = matchingFeedback(
    await readJsonIfFile(path.join(jobFolder, 'fit-feedback.json')),
    jobId,
    resultSha256,
  );
  if (!feedback) return { outcome: 'waiting' };
  if (feedback.status === 'revision-required' || feedback.status === 'revision-exhausted') {
    return { outcome: 'revision-required', feedback };
  }
  if (feedback.status === 'render-retry-required') {
    return { outcome: 'render-retry-required', feedback };
  }
  if (feedback.status === 'invalid' && feedback.measured === false) {
    return { outcome: 'invalid', feedback };
  }
  return { outcome: 'waiting' };
}

/**
 * Poll until the app returns a terminal observation. Production has no
 * deadline: a slow render or a long chain of quality revisions must not end
 * the active authoring session. Tests may inject a finite absolute deadline.
 * Terminal states are checked before that test-only clock.
 */
export async function waitForLocalAiHandoff({
  jobFolder,
  receiptFile,
  jobId,
  resultSha256,
  deadlineMs = null,
  pollMs = LOCAL_AI_HANDOFF_POLL_MS,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  if (!jobFolder || !receiptFile || !jobId || !/^[a-f0-9]{64}$/i.test(resultSha256 || '')) {
    throw new Error('jobFolder, receiptFile, jobId, and a 64-character resultSha256 are required.');
  }
  // Production callers deliberately omit deadlineMs and wait indefinitely.
  // A finite deadline is solely a deterministic-test seam.
  if (deadlineMs != null && !Number.isFinite(deadlineMs)) throw new Error('deadlineMs must be a finite wall-clock timestamp.');
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('pollMs must be a finite positive number.');
  while (true) {
    const observed = await inspectLocalAiHandoff({ jobFolder, receiptFile, jobId, resultSha256 });
    if (observed.outcome !== 'waiting') return observed;
    if (deadlineMs != null) {
      const remaining = deadlineMs - now();
      if (remaining <= 0) return { outcome: 'timeout' };
      await sleep(Math.min(Math.max(1, pollMs), remaining));
    } else {
      await sleep(Math.max(1, pollMs));
    }
  }
}

function cliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`Invalid argument: ${key || ''}`);
    args[key.slice(2)] = value;
  }
  return args;
}

async function main() {
  const args = cliArgs(process.argv.slice(2));
  const result = await waitForLocalAiHandoff({
    jobFolder: args['job-folder'],
    receiptFile: args['receipt-file'],
    jobId: args['job-id'],
    resultSha256: args['result-sha256'],
    deadlineMs: args['deadline-ms'] == null ? null : Number(args['deadline-ms']),
    pollMs: args['poll-ms'] == null ? LOCAL_AI_HANDOFF_POLL_MS : Number(args['poll-ms']),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Local AI handoff wait failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
