import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCueCardLog, CUE_CARD_LOG_DIRECTORY } from '../../electron/interviewCueCardLog.js';

async function temp(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-cue-log-'));
  try { return await fn(directory); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

export default [
  { name: 'cue card log: every event is one private JSON line with its time, in order', async run() {
    await temp(async (directory) => {
      let tick = Date.parse('2026-11-16T10:00:00.000Z');
      const log = createCueCardLog({ userDataPath: directory, now: () => new Date(tick) });
      log.write('open', { cards: 2 });
      tick += 1500;
      log.write('turn', { turnId: 3, heard: 'Tell me about a project you built.' });
      log.write('decision', { turnId: 3, stage: 'matcher', selection: { kind: 'question', cardId: 'project', confidence: 0.91 } });
      await log.flush();
      assert.equal(path.dirname(log.file), path.join(directory, CUE_CARD_LOG_DIRECTORY));
      const lines = (await fs.promises.readFile(log.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(lines.map(line => [line.type, line.ms]), [['open', 0], ['turn', 1500], ['decision', 1500]]);
      assert.equal(lines[1].heard, 'Tell me about a project you built.');
      assert.equal(lines[2].selection.confidence, 0.91);
      assert.equal(lines[0].t, '2026-11-16T10:00:00.000Z');
      if (process.platform !== 'win32') {
        assert.equal((await fs.promises.stat(log.file)).mode & 0o077, 0, 'the log holds interview speech and must be private to the user');
        assert.equal((await fs.promises.stat(path.dirname(log.file))).mode & 0o077, 0);
      }
    });
  } },
  { name: 'cue card log: old sessions are pruned, oversized lines are clipped, and failures never throw', async run() {
    await temp(async (directory) => {
      const folder = path.join(directory, CUE_CARD_LOG_DIRECTORY);
      await fs.promises.mkdir(folder, { recursive: true });
      for (let index = 0; index < 45; index += 1) await fs.promises.writeFile(path.join(folder, `cue-card-2026-01-01T00-00-${String(index).padStart(2, '0')}-000Z.jsonl`), '{}\n');
      await fs.promises.writeFile(path.join(folder, 'keep-me.txt'), 'not a log');
      const log = createCueCardLog({ userDataPath: directory });
      log.write('big', { text: 'x'.repeat(100_000) });
      await log.flush();
      const names = await fs.promises.readdir(folder);
      assert.equal(names.filter(name => name.startsWith('cue-card-')).length, 40, 'only the most recent sessions are kept');
      assert(names.includes('keep-me.txt') && !names.includes('cue-card-2026-01-01T00-00-00-000Z.jsonl'), 'the oldest logs go first and other files are untouched');
      const [line] = (await fs.promises.readFile(log.file, 'utf8')).trim().split('\n');
      assert(line.length < 20_000 && JSON.parse(line).clipped === true);
    });
    const errors = [];
    const broken = createCueCardLog({ userDataPath: '/dev/null/not-a-folder', onError: error => errors.push(error) });
    broken.write('open', {});
    broken.write('turn', {});
    await broken.flush();
    assert(errors.length >= 1, 'a storage failure is reported once to the app log, not thrown');
    const none = createCueCardLog({ userDataPath: undefined });
    none.write('open', {});
    await none.flush();
    assert.equal(none.file, null);
  } },
];
