// Temporary. Keeps real prompts and accepted ChatGPT answers so each task's
// Claude model and effort can be tested before the bridge is shelved. Private
// candidate material: it stays under userData and out of Git. Delete this file
// and its one call in nonApiAi.js when the task tests are finished.
import fs from 'node:fs';
import path from 'node:path';

export const AI_TASK_CORPUS_DIR = 'ai-task-corpus';
export const AI_TASK_CORPUS_MAX_PER_DAY = 40;
export const AI_TASK_CORPUS_MAX_PER_TASK = 300;

const TASK_NAME_RE = /^[a-z0-9-]{1,80}$/u;

export function createAiTaskCorpus({ dir, now = () => new Date() } = {}) {
  const counts = new Map();
  let queue = Promise.resolve();

  async function taskCounts(taskDir) {
    let saved = counts.get(taskDir);
    if (saved) return saved;
    saved = { total: 0, days: new Map() };
    await fs.promises.mkdir(taskDir, { recursive: true, mode: 0o700 });
    for (const name of await fs.promises.readdir(taskDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const text = await fs.promises.readFile(path.join(taskDir, name), 'utf8');
      const lines = text.split('\n').filter(Boolean).length;
      saved.days.set(name, lines);
      saved.total += lines;
    }
    counts.set(taskDir, saved);
    return saved;
  }

  async function write(sample) {
    const at = now();
    const taskDir = path.join(dir, sample.task);
    const saved = await taskCounts(taskDir);
    const file = `${at.toISOString().slice(0, 10)}.jsonl`;
    const today = saved.days.get(file) || 0;
    if (saved.total >= AI_TASK_CORPUS_MAX_PER_TASK || today >= AI_TASK_CORPUS_MAX_PER_DAY) return false;
    // Claim the slot first so a failed append is not retried past the cap.
    saved.total += 1;
    saved.days.set(file, today + 1);
    await fs.promises.appendFile(path.join(taskDir, file), `${JSON.stringify({ at: at.toISOString(), ...sample })}\n`, { mode: 0o600 });
    return true;
  }

  // Never throws: the corpus must not be able to fail an accepted answer.
  return function capture(sample) {
    if (!dir || !TASK_NAME_RE.test(sample?.task ?? '')
      || typeof sample.prompt !== 'string' || typeof sample.response !== 'string') return Promise.resolve(false);
    const result = queue.then(() => write(sample)).catch(() => false);
    queue = result;
    return result;
  };
}
