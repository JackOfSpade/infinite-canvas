import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../test-dependencies.js';
import {
  AI_TASK_CORPUS_MAX_PER_DAY,
  AI_TASK_CORPUS_MAX_PER_TASK,
  createAiTaskCorpus,
} from '../../electron/ipc/aiTaskCorpus.js';

const sample = (extra = {}) => ({ task: 'job-scoring', prompt: 'P', response: 'R', ...extra });

function withDir(run) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-task-corpus-'));
    try {
      return await run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const linesIn = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

export default [
  {
    name: 'ai task corpus: saves the prompt and answer privately under the task',
    run: withDir(async (dir) => {
      const capture = createAiTaskCorpus({ dir, now: () => new Date('2026-11-01T12:00:00Z') });
      assert(await capture(sample({ rejections: 2 })) === true, 'the first sample is saved');
      const file = path.join(dir, 'job-scoring', '2026-11-01.jsonl');
      const [saved] = linesIn(file);
      assert(saved.prompt === 'P' && saved.response === 'R' && saved.rejections === 2, 'the record keeps its fields');
      assert((fs.statSync(file).mode & 0o777) === 0o600, 'only the owner can read the file');
      return { saved: true };
    }),
  },
  {
    name: 'ai task corpus: enforces the daily and per-task caps, including after a restart',
    run: withDir(async (dir) => {
      let day = new Date('2026-11-01T12:00:00Z');
      const capture = createAiTaskCorpus({ dir, now: () => day });
      for (let i = 0; i < AI_TASK_CORPUS_MAX_PER_DAY; i += 1) await capture(sample());
      assert(await capture(sample()) === false, 'the daily cap stops the next sample');

      const restarted = createAiTaskCorpus({ dir, now: () => day });
      assert(await restarted(sample()) === false, 'a restart counts what is already on disk');

      let saved = AI_TASK_CORPUS_MAX_PER_DAY;
      for (let d = 2; saved < AI_TASK_CORPUS_MAX_PER_TASK; d += 1) {
        day = new Date(Date.UTC(2026, 10, d, 12));
        for (let i = 0; i < AI_TASK_CORPUS_MAX_PER_DAY && saved < AI_TASK_CORPUS_MAX_PER_TASK; i += 1) {
          await restarted(sample());
          saved += 1;
        }
      }
      day = new Date('2026-12-15T12:00:00Z');
      assert(await restarted(sample()) === false, 'the task cap stops every later day');
      return { saved };
    }),
  },
  {
    name: 'ai task corpus: unusable input and write failures never throw',
    run: withDir(async (dir) => {
      const capture = createAiTaskCorpus({ dir });
      assert(await capture(sample({ task: '../escape' })) === false, 'a path-like task is refused');
      assert(await capture(sample({ prompt: null })) === false, 'a missing prompt is refused');
      assert(!fs.existsSync(path.join(path.dirname(dir), 'escape')), 'nothing is written outside the corpus');

      const blocked = path.join(dir, 'blocked');
      fs.writeFileSync(blocked, '');
      const failing = createAiTaskCorpus({ dir: blocked });
      assert(await failing(sample()) === false, 'a write failure resolves false');
      return { refused: true };
    }),
  },
];
