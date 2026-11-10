// Durable progress journal for AI test runs (ladders, replays, A/B research,
// live bundle runs).
//
// Every run records itself in docs/ai-test-runs.md while it runs, not only at
// the end: the section is written when the run starts, rewritten as results
// arrive (at most once a minute, and at once on milestones), and marked
// interrupted if the process is stopped. The doc holds counts and costs only;
// prompts and answers stay in the run's private out dir. A copy of the same
// state is written to <outDir>/journal.json.
//
// Why: on 2026-11-09 a session ran out of usage mid-run and was then deleted.
// Its result rows lived in the session scratchpad and nothing had been copied
// to the doc, so measured results were lost. assertDurableOutDir() refuses
// session scratchpads and OS temp folders as --out for the same reason.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUN_LOG_DOC = path.join(REPO_ROOT, 'docs', 'ai-test-runs.md');
/** Private, outside the repository, and not tied to any session. */
export const DURABLE_RUN_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'infinite-canvas', 'ai-test-runs');
export const DEFAULT_MIN_INTERVAL_MS = 60_000;

const DOC_HEADER = `# AI test run log

Written by the test tools themselves while they run (\`scripts/ai-test-journal.mjs\`): \`claude-effort-ladder.mjs\`, \`ai-task-replay.mjs\`, \`web-research-ab.mjs\` and \`live-bundle-harness.mjs\`. Each section is one run. It appears when the run starts, is rewritten as results arrive, and is marked interrupted if the process is stopped, so the numbers survive even if the session that started the run does not.

These are raw results, kept whether or not a decision was made. Conclusions go in \`ai-model-selection.md\`, which should cite the run here. Only counts and costs are written; prompts and answers stay in each run's private out dir (default under \`~/Library/Application Support/infinite-canvas/ai-test-runs/\`).
`;

function realOrResolved(dir) {
  const resolved = path.resolve(dir);
  // Resolve the deepest existing ancestor so /tmp -> /private/tmp style links are seen.
  let current = resolved;
  const rest = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    rest.unshift(path.basename(current));
    current = parent;
  }
  try { return path.join(fs.realpathSync(current), ...rest); } catch { return resolved; }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Why a directory would not survive the session, or null when it is durable. */
export function ephemeralReason(dir, { tmpRoots = null } = {}) {
  const target = realOrResolved(dir);
  if (/\/scratchpad(?:\/|$)/u.test(target)) return 'it is inside a session scratchpad';
  if (/\/claude-\d+\//u.test(`${target}/`)) return 'it is inside a Claude Code session temp folder';
  const roots = tmpRoots ?? [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  for (const root of roots) {
    if (isInside(target, realOrResolved(root))) return 'it is inside a temporary folder';
  }
  return null;
}

/**
 * Refuse an out dir that will not outlive the session. --ephemeral (allowEphemeral)
 * is for dry runs and tests only.
 */
export function assertDurableOutDir(dir, { allowEphemeral = false, tmpRoots = null, flag = '--out' } = {}) {
  if (!dir || allowEphemeral) return dir;
  const reason = ephemeralReason(dir, { tmpRoots });
  if (!reason) return dir;
  const suggestion = path.join(DURABLE_RUN_ROOT, path.basename(path.resolve(dir)) || 'run');
  throw new Error(`${flag} ${dir} is not durable: ${reason}, and results there are lost when the session ends. `
    + `Use a folder under ${DURABLE_RUN_ROOT}, for example ${suggestion}, or pass --ephemeral for a throwaway run.`);
}

/** Strip --ephemeral from argv; returns [argv, allowEphemeral]. */
export function takeEphemeralFlag(argv = []) {
  const rest = argv.filter(arg => arg !== '--ephemeral');
  return [rest, rest.length !== argv.length];
}

const tilde = value => (typeof value === 'string' ? value.split(os.homedir()).join('~') : value);
const cell = value => String(value ?? '').replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').trim();
const money = value => (Number.isFinite(value) ? `$${value.toFixed(value >= 10 ? 2 : 3)}` : '');

export function renderRunSection(run) {
  const lines = [`<!-- ai-test-run:${run.runId} -->`, `### ${run.startedAt.slice(0, 16).replace('T', ' ')} UTC · ${run.tool}${run.task ? ` · ${run.task}` : ''}${run.label ? ` · ${run.label}` : ''}`, ''];
  lines.push(`- Status: **${run.status}** (updated ${run.updatedAt.slice(0, 19).replace('T', ' ')} UTC)`);
  if (run.outDir) lines.push(`- Out dir: \`${tilde(run.outDir)}\``);
  if (run.command) lines.push(`- Command: \`${cell(tilde(run.command))}\``);
  for (const [key, value] of Object.entries(run.facts || {})) lines.push(`- ${key}: ${cell(tilde(value))}`);
  const rows = Array.isArray(run.rows) ? run.rows : [];
  if (rows.length) {
    lines.push('', '| Arm | n | Valid | Failed | Cost | Notes |', '|---|---|---|---|---|---|');
    for (const row of rows) {
      lines.push(`| ${cell(row.arm)} | ${row.n ?? ''} | ${row.valid ?? ''} | ${row.failed ?? ''} | ${money(row.costUsd)} | ${cell(row.notes)} |`);
    }
    const total = rows.reduce((sum, row) => sum + (Number.isFinite(row.costUsd) ? row.costUsd : 0), 0);
    lines.push('', `Recorded cost so far: ${money(total) || '$0.000'}.`);
  } else {
    lines.push('', 'No results yet.');
  }
  for (const note of run.notes || []) lines.push(`- Note: ${cell(tilde(note))}`);
  lines.push(`<!-- /ai-test-run:${run.runId} -->`);
  return lines.join('\n');
}

/** Replace the run's section in place, or append it; the rest of the doc is kept as is. */
export function upsertRunSection(docText, runId, section) {
  const base = typeof docText === 'string' && docText.trim() ? docText : DOC_HEADER;
  const start = `<!-- ai-test-run:${runId} -->`;
  const end = `<!-- /ai-test-run:${runId} -->`;
  const from = base.indexOf(start);
  const to = from >= 0 ? base.indexOf(end, from) : -1;
  if (from >= 0 && to >= 0) return `${base.slice(0, from)}${section}${base.slice(to + end.length)}`;
  return `${base.replace(/\s*$/u, '')}\n\n${section}\n`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Several runs can share the doc, so each rewrite holds a short lock. */
function withDocLock(docPath, work) {
  const lock = `${docPath}.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      try { return work(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* the holder just released it */ }
      sleepSync(25);
    }
  }
  return work();
}

function writeAtomic(file, text, mode) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, mode ? { mode } : undefined);
  fs.renameSync(temp, file);
}

/**
 * createRunJournal({ tool, task, label, outDir, command, facts }) writes the
 * run's section at once and returns { runId, update, finish, flush, state }.
 * update({ rows, facts, note, status }, { force }) merges and rewrites the doc
 * when force is set or minIntervalMs has passed; journal.json in outDir is
 * rewritten on every call. Writing never throws into the run: a failure is
 * reported once on stderr and the run goes on.
 */
export function createRunJournal({
  tool, task = '', label = '', outDir = '', command = '', facts = {},
  docPath = RUN_LOG_DOC, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = () => Date.now(), handleSignals = true, exitOnSignal = true,
} = {}) {
  const startedAt = new Date(now()).toISOString();
  const runId = `${startedAt.replace(/[:.]/gu, '-')}-${String(tool).replace(/[^a-z0-9-]/giu, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const state = { runId, tool, task, label, outDir: outDir ? path.resolve(outDir) : '', command, facts: { ...facts }, startedAt, updatedAt: startedAt, status: 'running', rows: [], notes: [] };
  let lastDocWrite = 0;
  let warned = false;
  let finished = false;

  const warn = error => {
    if (warned) return;
    warned = true;
    process.stderr.write(`ai-test-journal: could not record progress (${error?.message || error}); the run continues.\n`);
  };
  const writeDoc = () => {
    try {
      withDocLock(docPath, () => {
        let text = '';
        try { text = fs.readFileSync(docPath, 'utf8'); } catch { /* first run creates it */ }
        writeAtomic(docPath, upsertRunSection(text, runId, renderRunSection(state)));
      });
      lastDocWrite = now();
    } catch (error) { warn(error); }
  };
  const writeLocal = () => {
    if (!state.outDir) return;
    try {
      fs.mkdirSync(state.outDir, { recursive: true, mode: 0o700 });
      writeAtomic(path.join(state.outDir, 'journal.json'), `${JSON.stringify(state, null, 2)}\n`, 0o600);
    } catch (error) { warn(error); }
  };
  const flush = () => { writeLocal(); writeDoc(); };

  function update({ rows, facts: moreFacts, note, status } = {}, { force = false, final = false } = {}) {
    // A heartbeat that fires after finish() must not reopen the record.
    if (finished && !final) return;
    if (Array.isArray(rows)) state.rows = rows;
    if (moreFacts) Object.assign(state.facts, moreFacts);
    if (note) state.notes.push(note);
    if (status) state.status = status;
    state.updatedAt = new Date(now()).toISOString();
    writeLocal();
    if (force || now() - lastDocWrite >= minIntervalMs) writeDoc();
  }

  function finish(status = 'finished', patch = {}) {
    if (finished) return;
    finished = true;
    detach();
    update({ ...patch, status }, { force: true, final: true });
  }

  const onSignal = signal => {
    finish(`interrupted (${signal}) before finishing; rows above are complete up to that point`);
    if (exitOnSignal) process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  const onExit = code => { if (!finished) finish(`stopped (process exited with code ${code}) before finishing`); };
  function detach() {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('exit', onExit);
  }
  if (handleSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('exit', onExit);
  }

  flush();
  return { runId, update, finish, flush, state };
}

/** Group result rows by arm: { arm, n, valid, failed, costUsd }. */
export function tallyRows(rows, armOf, { validOf = row => row.valid === true, failedOf = row => row.ok === false, costOf = row => row.costUsd } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const arm = armOf(row);
    if (arm === null || arm === undefined) continue;
    let group = groups.get(arm);
    if (!group) { group = { arm, n: 0, valid: 0, failed: 0, costUsd: 0 }; groups.set(arm, group); }
    group.n += 1;
    if (validOf(row)) group.valid += 1;
    if (failedOf(row)) group.failed += 1;
    const cost = Number(costOf(row));
    if (Number.isFinite(cost)) group.costUsd += cost;
  }
  return [...groups.values()].sort((a, b) => String(a.arm).localeCompare(String(b.arm)));
}

// ---- record: write a hand-made result (a judging pass, a comparison) -------
//
//   node scripts/ai-test-journal.mjs record --tool "blind judge" --task requirements \
//     --label "haiku:medium vs production" [--status finished] [--out <durable dir>] \
//     --row "arm|n|valid|failed|costUsd|notes" [--row ...] [--fact "Key=Value"] [--note "..."]
//
// Use it for every result that no test tool recorded itself: the numbers go in
// the run log at once, not only into the conversation.

const RECORD_FLAGS = { '--tool': 'tool', '--task': 'task', '--label': 'label', '--status': 'status', '--out': 'out', '--doc': 'doc' };
const RECORD_REPEATABLE = { '--row': 'rows', '--fact': 'facts', '--note': 'notes' };

/** "arm|n|valid|failed|cost|notes" -> a journal row; empty fields stay empty. */
export function parseRecordRow(text) {
  const [arm, n, valid, failed, cost, ...notes] = String(text).split('|').map(part => part.trim());
  if (!arm) throw new Error(`--row ${text} needs an arm name before the first |.`);
  const number = (name, value) => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value.replace(/^\$/u, ''));
    if (!Number.isFinite(parsed)) throw new Error(`--row ${text}: ${name} must be a number.`);
    return parsed;
  };
  return { arm, n: number('n', n), valid: number('valid', valid), failed: number('failed', failed), costUsd: number('cost', cost), notes: notes.join('|') };
}

export function parseRecordArgs(argv = []) {
  const opts = { rows: [], facts: [], notes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const name = RECORD_FLAGS[flag] ?? RECORD_REPEATABLE[flag];
    if (!name) throw new Error(`Unknown argument ${flag}.`);
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value.`);
    const value = argv[i + 1];
    i += 1;
    if (RECORD_REPEATABLE[flag]) opts[name].push(value);
    else opts[name] = value;
  }
  if (!opts.tool) throw new Error('--tool is required (what produced the result, for example "blind judge").');
  if (!opts.rows.length && !opts.notes.length) throw new Error('Pass at least one --row or --note.');
  return opts;
}

/** Records one finished section; returns its run id. */
export function recordResult(argv, { docPath = null, now = () => Date.now(), allowEphemeral = false } = {}) {
  const opts = parseRecordArgs(argv);
  if (opts.out) assertDurableOutDir(opts.out, { allowEphemeral });
  const facts = {};
  for (const fact of opts.facts) {
    const at = fact.indexOf('=');
    if (at <= 0) throw new Error(`--fact ${fact} must be Key=Value.`);
    facts[fact.slice(0, at).trim()] = fact.slice(at + 1).trim();
  }
  const rows = opts.rows.map(parseRecordRow);
  const journal = createRunJournal({
    tool: opts.tool, task: opts.task ?? '', label: opts.label ?? '', outDir: opts.out ?? '', facts,
    docPath: docPath ?? opts.doc ?? RUN_LOG_DOC, now, handleSignals: false,
  });
  journal.update({ rows });
  for (const note of opts.notes) journal.update({ note });
  journal.finish(opts.status || 'finished');
  return journal.runId;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command !== 'record') throw new Error('Usage: node scripts/ai-test-journal.mjs record --tool <name> --row "arm|n|valid|failed|cost|notes" ...');
    const [args, allowEphemeral] = takeEphemeralFlag(rest);
    const runId = recordResult(args, { allowEphemeral });
    process.stdout.write(`recorded ${runId} in ${path.relative(process.cwd(), RUN_LOG_DOC) || RUN_LOG_DOC}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
