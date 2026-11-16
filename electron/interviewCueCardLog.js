/**
 * After-interview diagnostics for one cue card session.
 *
 * The cue card shows nothing but cues, so a blank or wrong card cannot be
 * explained on screen. Each session appends what it heard and decided to one
 * private JSON-lines file, read after the interview:
 *   <userData>/interview-cue-card-logs/cue-card-<time>.jsonl
 * Lines: { t (ISO time), ms (since open), type, ...data }. Writing never
 * throws and never delays the live path: lines queue behind one another.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CUE_CARD_LOG_DIRECTORY = 'interview-cue-card-logs';
const MAX_LOG_FILES = 40;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_LINES = 20_000;

const clip = value => {
  const line = JSON.stringify(value);
  return Buffer.byteLength(line) <= MAX_LINE_BYTES ? line : JSON.stringify({ t: value.t, ms: value.ms, type: value.type, clipped: true, head: line.slice(0, 4000) });
};

export function createCueCardLog({ userDataPath, now = () => new Date(), onError = () => {} } = {}) {
  const usable = typeof userDataPath === 'string' && path.isAbsolute(userDataPath);
  const directory = usable ? path.join(userDataPath, CUE_CARD_LOG_DIRECTORY) : null;
  const opened = now();
  const file = usable ? path.join(directory, `cue-card-${opened.toISOString().replace(/[:.]/gu, '-')}.jsonl`) : null;
  let queue = Promise.resolve();
  let lines = 0;
  let failed = !usable;
  const run = task => { queue = queue.then(task).catch(error => { failed = true; try { onError(error); } catch { /* reporting is best effort */ } }); return queue; };
  if (usable) {
    run(async () => {
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const old = (await fs.promises.readdir(directory)).filter(name => /^cue-card-.*\.jsonl$/u.test(name)).sort();
      for (const name of old.slice(0, Math.max(0, old.length - (MAX_LOG_FILES - 1)))) await fs.promises.rm(path.join(directory, name), { force: true });
    });
  }
  return Object.freeze({
    file,
    write(type, data = {}) {
      if (failed || lines >= MAX_LINES) return;
      lines += 1;
      const at = now();
      let line;
      try { line = clip({ t: at.toISOString(), ms: at.getTime() - opened.getTime(), type, ...data }); } catch { return; }
      run(() => fs.promises.appendFile(file, `${line}\n`, { mode: 0o600 }));
    },
    /** Resolves once every queued line is on disk. */
    flush: () => queue,
  });
}
