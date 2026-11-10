// Records every Claude call the app makes, so it can be re-measured offline on
// a future model without a special capture run. A sample is one JSON file per
// call under <userData>/ai-replay-samples/<task>/; usage rows go to the same
// claude-task-usage.jsonl the task worker already writes. Recording is opt-in
// (configureAiRecording) and must never throw: a capture failure may not change
// or fail the call it describes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AI_REPLAY_SAMPLES_DIR = 'ai-replay-samples';
export const AI_USAGE_FILE = 'claude-task-usage.jsonl';
export const AI_REPLAY_KEEP_PER_TASK = 24;
// Task names become directory names, so only this shape is accepted.
const TASK_NAME = /^[a-z0-9-]{1,80}$/;

let recordingRoot = null;

/**
 * Points recording at a userData directory. Until this is called (and after a
 * call with no usable path), every recording function is a no-op.
 */
export function configureAiRecording({ userData } = {}) {
  try {
    recordingRoot = typeof userData === 'string' && userData ? path.resolve(userData) : null;
  } catch {
    recordingRoot = null;
  }
  return recordingRoot;
}

/** True once configureAiRecording gave recording a root. */
export function aiRecordingConfigured() {
  return recordingRoot !== null;
}

const stringOrNull = value => (typeof value === 'string' && value ? value : null);
const numberOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function isoTime(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* mode is best-effort hardening */ }
}

function writeUnique(dir, base, content) {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const file = path.join(dir, `${base}${suffix === 0 ? '' : `-${suffix}`}.json`);
    try {
      fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
      try { fs.chmodSync(file, 0o600); } catch { /* mode is best-effort hardening */ }
      return file;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return null;
}

/** Keeps only the newest files of a task; names start with the ISO capture time. */
function pruneTaskDir(dir) {
  const names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();
  if (names.length <= AI_REPLAY_KEEP_PER_TASK) return;
  for (const name of names.slice(0, names.length - AI_REPLAY_KEEP_PER_TASK)) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* one old file cannot fail a record */ }
  }
}

/**
 * Writes one sample of a Claude call: the exact text and system append sent,
 * the resolved and requested models, effort/tools, spend and usage, the answer,
 * and how the app judged it. Returns the file path, or null when skipped.
 */
export function recordAiReplaySample(sample) {
  try {
    const root = recordingRoot;
    if (!root || !sample || typeof sample !== 'object') return null;
    const task = typeof sample.task === 'string' ? sample.task : '';
    if (!TASK_NAME.test(task)) return null;
    const text = typeof sample.text === 'string' ? sample.text : '';
    const systemAppend = typeof sample.systemAppend === 'string' ? sample.systemAppend : '';
    const at = isoTime(sample.at);
    const hash = crypto.createHash('sha256').update(`${text}\u0000${systemAppend}`, 'utf8').digest('hex').slice(0, 12);
    const row = {
      at,
      task,
      stage: stringOrNull(sample.stage),
      attempt: Number.isInteger(sample.attempt) && sample.attempt >= 0 ? sample.attempt : 0,
      text,
      systemAppend,
      model: stringOrNull(sample.model),
      requestedModel: stringOrNull(sample.requestedModel),
      effort: stringOrNull(sample.effort),
      tools: stringOrNull(sample.tools),
      costUsd: numberOrNull(sample.costUsd),
      usage: sample.usage && typeof sample.usage === 'object' ? sample.usage : null,
      durationMs: numberOrNull(sample.durationMs),
      answer: typeof sample.answer === 'string' ? sample.answer : String(sample.answer ?? ''),
      outcome: sample.outcome === 'accepted' || sample.outcome === 'rejected' ? sample.outcome : null,
      validationCode: stringOrNull(sample.validationCode),
    };
    const samplesRoot = path.join(root, AI_REPLAY_SAMPLES_DIR);
    const taskDir = path.join(samplesRoot, task);
    ensurePrivateDir(taskDir);
    // The capture time is the file prefix, so a lexicographic sort is chronological.
    const file = writeUnique(taskDir, `${at.replace(/[:.]/gu, '-')}-${hash}`, `${JSON.stringify(row)}\n`);
    pruneTaskDir(taskDir);
    return file;
  } catch {
    return null;
  }
}

/** Appends one usage row to the worker's usage log. Returns the file path or null. */
export function recordAiUsage(row) {
  try {
    const root = recordingRoot;
    if (!root || !row || typeof row !== 'object') return null;
    try { fs.mkdirSync(root, { recursive: true }); } catch { /* an existing userData needs no chmod */ }
    const file = path.join(root, AI_USAGE_FILE);
    const line = `${JSON.stringify({ ...row, at: isoTime(row.at) })}\n`;
    fs.appendFileSync(file, line, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* mode is best-effort hardening */ }
    return file;
  } catch {
    return null;
  }
}
