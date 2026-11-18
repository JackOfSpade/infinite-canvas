import fs from 'node:fs';
import path from 'node:path';

// The Jobs IPC handlers are an entry file plus a folder of cohesive modules.
// A POSITIVE source assertion reads the single module that holds the text
// (readJobsSource('state')); a NEGATIVE one (text that must appear nowhere)
// scans the entry and every module (readAllJobsSources()).
const ENTRY = 'electron/ipc/jobs.js';
const FOLDER = 'electron/ipc/jobs';

function folderFiles() {
  const dir = path.resolve(FOLDER);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
}

// name: 'jobs' (the entry) or a module name under electron/ipc/jobs/, with or without '.js'.
export function readJobsSource(name = 'jobs') {
  const base = String(name).replace(/\.js$/, '');
  const file = base === 'jobs' ? ENTRY : `${FOLDER}/${base}.js`;
  return fs.readFileSync(path.resolve(file), 'utf8');
}

export function readAllJobsSources() {
  const files = [ENTRY, ...folderFiles().map((f) => `${FOLDER}/${f}`)];
  return files.map((f) => fs.readFileSync(path.resolve(f), 'utf8')).join('\n');
}

// Several modules, concatenated in the order given (a slice taken from one
// module to a later marker still reads in that order).
export function readJobsSources(...names) {
  return names.map((name) => readJobsSource(name)).join('\n');
}
