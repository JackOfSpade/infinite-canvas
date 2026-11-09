#!/usr/bin/env node
/**
 * Plain-Node, private Interview Helper Prepare probe. Never starts Electron.
 *
 * node --import ./scripts/test-stubs/register.mjs scripts/interview-live-prepare-harness.mjs \
 *   --user-data "<dir>" --snapshot-id <id> --job-url <url> \
 *   --bundle-dir "<applied-job folder>" --out /tmp/interview-live-prep \
 *   [--transport claude|replay] [--ultracode on|off] \
 *   [--research native|tavily|merged] [--merge-from "<dirA>,<dirB>"] [--stop-after all|brief]
 *
 * The Claude transport feeds the real Prepare handoffs (buildInterviewBrief
 * then buildInterviewPreparedAnswers) through the same headless Claude Code
 * runner and per-stage model/effort profiles as the app. --ultracode on
 * forwards ultracode:true to every stage, so one run can be compared with
 * --ultracode off (the default, as everywhere in the app).
 *
 * --research picks how the one 'interview-brief-research' call is answered:
 * native (default) is the transport's own CLI call with Claude's built-in web
 * search; tavily calls runClaudeSdkStage directly with the Tavily MCP tools and
 * the qa-research profile; merged researches nothing and reads the two source
 * sets from two earlier harness output dirs (--merge-from <dirA>,<dirB>, where
 * A is the built-in-search dir and B the Tavily dir), labelled and
 * proportionally trimmed to the research validator's maximum. Every other call
 * keeps using the transport. --stop-after brief stops after final-brief.json
 * and still writes report.json and calls.jsonl.
 *
 * Every Claude attempt is recorded: 001.prompt.txt / 001.response.txt and one
 * calls.jsonl line with task, stage, attempt, duration, cost, usage, Workflow
 * use and error code. Replay consumes those numbered response files verbatim
 * from --out, so a live run's transcripts replay without the CLI or network.
 * Prompts/responses and sealed artifacts contain private evidence: --out is
 * private (0700 directories/0600 files). Console output is metadata only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAVILY_RESEARCH_TOOLS, readTavilyKey, tavilyMcpServers } from '../electron/ipc/tavily.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const WORKFLOW_TOOL = 'Workflow';
const TRANSPORTS = Object.freeze(['claude', 'replay']);
const ULTRACODE_SETTINGS = Object.freeze(['on', 'off']);
export const RESEARCH_MODES = Object.freeze(['native', 'tavily', 'merged']);
export const STOP_AFTER_SETTINGS = Object.freeze(['all', 'brief']);
export const RESEARCH_TASK = 'interview-brief-research';
export const RESEARCH_STAGE = 'qa-research';
export const TAVILY_RESEARCH_MAX_TURNS = 24;
// The responseValidator buildInterviewBrief attaches (validateGroundedResearchText).
export const RESEARCH_MAX_CHARS = 80_000;
export const RESEARCH_SOURCE_LABELS = Object.freeze({
  builtIn: 'SOURCE SET A (built-in web search)',
  tavily: 'SOURCE SET B (Tavily search)',
});
const INPUT_FILES = ['Application.html', 'Original Job Listing.md', 'Generation Audit.json', 'Resume.pdf', 'Cover Letter.pdf'];
const inside = (parent, child) => child === parent || (!path.relative(parent, child).startsWith(`..${path.sep}`)
  && path.relative(parent, child) !== '..' && !path.isAbsolute(path.relative(parent, child)));

function fail(code) { const error = new Error(code); error.code = code; throw error; }

export function parseHarnessArgs(argv) {
  const args = { transport: 'claude', ultracode: 'off', research: 'native', 'stop-after': 'all' };
  const allowed = new Set(['user-data', 'snapshot-id', 'job-url', 'bundle-dir', 'out', 'transport', 'ultracode', 'ultracode-off-tasks',
    'research', 'merge-from', 'stop-after']);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2);
    if (!argv[index]?.startsWith('--') || !allowed.has(key) || seen.has(key)
      || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    seen.add(key); args[key] = argv[index + 1];
  }
  for (const key of ['user-data', 'snapshot-id', 'job-url', 'bundle-dir', 'out']) if (!args[key]) fail('MISSING_ARGUMENTS');
  if (!/^[a-f0-9]{64}$/u.test(args['snapshot-id']) || !TRANSPORTS.includes(args.transport)
    || !ULTRACODE_SETTINGS.includes(args.ultracode) || !RESEARCH_MODES.includes(args.research)
    || !STOP_AFTER_SETTINGS.includes(args['stop-after'])) fail('INVALID_ARGUMENTS');
  // Tasks that keep ultracode off even under --ultracode on, so later stages can be
  // measured on top of a stage known to fail with it (comma list of task ids).
  args.ultracodeOffTasks = String(args['ultracode-off-tasks'] || '').split(',').map(task => task.trim()).filter(Boolean);
  if (args.ultracodeOffTasks.some(task => !/^interview-[a-z-]+$/u.test(task))) fail('INVALID_ARGUMENTS');
  for (const key of ['user-data', 'bundle-dir', 'out']) {
    if (!path.isAbsolute(args[key])) fail('ABSOLUTE_DIRECTORIES_REQUIRED');
    args[key] = path.resolve(args[key]);
  }
  // Only a merged run reads sources: exactly two earlier harness output dirs.
  const mergeFrom = String(args['merge-from'] ?? '').split(',').map(directory => directory.trim()).filter(Boolean);
  if (args.research === 'merged') {
    if (mergeFrom.length !== 2) fail('INVALID_ARGUMENTS');
    for (const directory of mergeFrom) if (!path.isAbsolute(directory)) fail('ABSOLUTE_DIRECTORIES_REQUIRED');
    args.mergeFrom = mergeFrom.map(directory => path.resolve(directory));
  } else {
    if (args['merge-from'] !== undefined) fail('INVALID_ARGUMENTS');
    args.mergeFrom = [];
  }
  return args;
}

async function realDirectory(directory) {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
  return fs.promises.realpath(directory);
}

// Resolve existing ancestors before creating anything, including /tmp's macOS
// alias. No output may be within, or contain, either protected input tree.
function prospectiveRealPath(target) {
  let current = target;
  const tail = [];
  while (!fs.existsSync(current)) {
    try { fs.lstatSync(current); fail('UNSAFE_OUTPUT'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    tail.unshift(path.basename(current)); current = path.dirname(current);
  }
  return path.join(fs.realpathSync(current), ...tail);
}

/** Fail closed on filesystem mutations outside the owned output root.
 * Also check every existing output component for symlinks/hardlinks. This is
 * defense in depth around the production read-only readers, not an OS sandbox.
 * Like the production intake, this assumes no hostile concurrent same-user
 * replacement of the roots.
 */
export function installWriteGuard(roots) {
  const undo = [];
  // The harness's own stdout/stderr may be redirected to a log file; they are never inputs.
  const writableFds = new Set([1, 2]);
  const ownedInodes = new Set();
  const check = value => {
    if (typeof value === 'number') { if (!writableFds.has(value)) fail('INPUT_WRITE_REFUSED'); return; }
    const target = path.resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : String(value));
    const root = roots.find(candidate => inside(candidate, target));
    if (!root) fail('INPUT_WRITE_REFUSED');
    let current = root;
    for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const inode = `${stat.dev}:${stat.ino}`;
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1 && !ownedInodes.has(inode))) fail('UNSAFE_OUTPUT');
      // Atomic production publication temporarily gives a verified private
      // temporary file two names in this same output tree.
      if (stat.isFile() && stat.nlink === 1) ownedInodes.add(inode);
    }
  };
  const writeFlags = flags => typeof flags === 'number'
    ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/u.test(String(flags || 'r'));
  const replace = (object, key, build) => {
    if (typeof object[key] !== 'function') return;
    const original = object[key]; object[key] = build(original);
    undo.push(() => { object[key] = original; });
  };
  const mutations = {
    appendFile: [0], writeFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0], unlink: [0],
    chmod: [0], lchmod: [0], chown: [0], lchown: [0], utimes: [0], lutimes: [0], truncate: [0],
    rename: [0, 1], link: [0, 1], symlink: [0, 1], copyFile: [1], cp: [1],
    write: [0], writev: [0], fchmod: [0], fchown: [0], futimes: [0], ftruncate: [0],
  };
  for (const [name, positions] of Object.entries(mutations)) {
    for (const [object, key] of [[fs, name], [fs, `${name}Sync`], [fs.promises, name]]) {
      replace(object, key, original => function (...args) {
        for (const position of positions) check(args[position]);
        return original.apply(this, args);
      });
    }
  }
  replace(fs.promises, 'open', original => async function (target, flags, ...rest) {
    const writable = writeFlags(flags);
    if (writable) check(target);
    const handle = await original.call(this, target, flags, ...rest);
    for (const key of ['appendFile', 'writeFile', 'write', 'writev', 'chmod', 'chown', 'utimes', 'truncate', 'createWriteStream']) {
      if (typeof handle[key] !== 'function') continue;
      const method = handle[key];
      handle[key] = function (...args) { check(target); return method.apply(this, args); };
    }
    return handle;
  });
  replace(fs, 'openSync', original => function (target, flags, ...rest) {
    if (writeFlags(flags)) check(target);
    const fd = original.call(this, target, flags, ...rest);
    if (roots.some(root => inside(root, path.resolve(String(target))))) writableFds.add(fd);
    return fd;
  });
  replace(fs, 'open', original => function (target, flags, ...rest) {
    if (writeFlags(flags)) check(target);
    const callback = rest.pop();
    return original.call(this, target, flags, ...rest, (error, fd) => {
      if (!error && roots.some(root => inside(root, path.resolve(String(target))))) writableFds.add(fd);
      callback(error, fd);
    });
  });
  for (const name of ['close', 'closeSync']) replace(fs, name, original => function (fd, ...rest) {
    writableFds.delete(fd); return original.call(this, fd, ...rest);
  });
  replace(fs, 'createWriteStream', original => function (target, options) {
    check(options?.fd ?? target); return original.call(this, target, options);
  });
  return () => { for (const restore of undo.reverse()) restore(); };
}

async function readPrivate(file, limit = MAX_RESPONSE_BYTES) {
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) fail('UNSAFE_SAVED_FILE');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit) fail('UNSAFE_SAVED_FILE');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > limit || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail('SAVED_FILE_CHANGED');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

/** Workflow launches in one onActivity event. Only a tool frame's calls count. */
export function workflowToolCalls(event) {
  if (!event || event.kind !== 'tool' || !Array.isArray(event.calls)) return 0;
  return event.calls.filter(call => call && call.tool === WORKFLOW_TOOL).length;
}

/**
 * Per-attempt metrics for the Claude transport. `save(name, text)` writes the
 * numbered prompt/response files, `append(line)` appends one calls.jsonl line,
 * and `now` is injectable so tests can pin durations.
 */
export function createCallRecorder({ save, append, now = () => Date.now() } = {}) {
  if (typeof save !== 'function' || typeof append !== 'function' || typeof now !== 'function') {
    throw new TypeError('CALL_RECORDER_NEEDS_SAVE_APPEND_AND_CLOCK');
  }
  const calls = [];
  let sequence = 0;
  const file = (number, kind) => `${number}.${kind}`;
  async function write(record) {
    await append(JSON.stringify(record));
    return record;
  }
  return {
    calls,
    begin({ task = null, stage = null, attempt = null } = {}) {
      sequence += 1;
      const number = String(sequence).padStart(3, '0');
      const startedAt = now();
      const record = {
        number, task, stage, attempt, startedAt: new Date(startedAt).toISOString(),
        durationMs: null, costUsd: null, usage: null, workflowCalls: 0, model: null,
        outcome: 'running', errorCode: null,
      };
      let workflowCalls = 0;
      calls.push(record);
      return {
        record,
        async prompt(text) { await save(file(number, 'prompt.txt'), String(text ?? '')); },
        activity(event) { workflowCalls += workflowToolCalls(event); },
        async succeed(reply) {
          Object.assign(record, {
            durationMs: Math.max(0, now() - startedAt),
            providerDurationMs: Number.isFinite(reply?.durationMs) ? reply.durationMs : null,
            costUsd: typeof reply?.costUsd === 'number' && Number.isFinite(reply.costUsd) ? reply.costUsd : null,
            usage: reply?.usage && typeof reply.usage === 'object' ? reply.usage : null,
            workflowCalls, model: typeof reply?.model === 'string' ? reply.model : null, outcome: 'ok',
          });
          // Written after the reply; replay runs skip this write so their saved inputs stay intact.
          await save(file(number, 'response.txt'), String(reply?.text ?? ''));
          return write(record);
        },
        async fail(error) {
          Object.assign(record, {
            durationMs: Math.max(0, now() - startedAt),
            workflowCalls,
            errorCode: typeof error?.code === 'string' && error.code ? error.code : 'CALL_FAILED',
            outcome: 'failed',
          });
          // No response transcript for a failed attempt, but keep its private diagnostic.
          await save(file(number, 'error.txt'), `${record.errorCode}\n${String(error?.message ?? '').slice(0, 8000)}\n`);
          return write(record);
        },
      };
    },
  };
}

/** opts.ultracode is true only for an explicit harness --ultracode on. */
export function withUltracode(call, setting) {
  if (typeof call !== 'function') throw new TypeError('ULTRACODE_WRAPPER_NEEDS_CALL');
  const ultracode = setting === 'on';
  return (prompt, opts = {}) => call(prompt, { ...opts, ultracode });
}

/**
 * Wraps the transport's runStage so every Claude attempt is recorded. The
 * transport awaits each runStage call, so `currentCall()` names the handoff
 * that is running; each invocation of it is one attempt of that handoff.
 * `onActivity` is added (or chained) to observe Workflow tool launches.
 */
export function createMeasuredRunStage({ runStage, recorder, currentCall = () => null } = {}) {
  if (typeof runStage !== 'function' || !recorder || typeof recorder.begin !== 'function') {
    throw new TypeError('MEASURED_RUN_STAGE_NEEDS_RUN_STAGE_AND_RECORDER');
  }
  return async function measuredRunStage(args = {}) {
    const context = currentCall();
    const attempt = Number.isInteger(context?.attempts) ? context.attempts : 0;
    if (context && typeof context === 'object') context.attempts = attempt + 1;
    const call = recorder.begin({
      task: context?.task ?? null,
      stage: context?.stage ?? null,
      attempt: context && typeof context === 'object' ? attempt : null,
    });
    await call.prompt(args.text);
    let reply;
    try {
      reply = await runStage({
        ...args,
        onActivity: event => {
          call.activity(event);
          if (typeof args.onActivity === 'function') args.onActivity(event);
        },
      });
    } catch (error) {
      await call.fail(error);
      throw error;
    }
    await call.succeed(reply);
    return reply;
  };
}

/** The Tavily key never reaches a transcript, a report or console output. */
export function redactTavilyKey(value, key) {
  const text = String(value ?? '');
  const secret = String(key ?? '');
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]');
}

const redactedError = (error, key) => {
  const copy = new Error(redactTavilyKey(error?.message ?? '', key));
  if (typeof error?.code === 'string' && error.code) copy.code = error.code;
  return copy;
};

/**
 * Answers the one 'interview-brief-research' call with runClaudeSdkStage
 * directly (no CLI transport): the qa-research profile's model and effort, the
 * Tavily MCP tools, maxTurns 24, persistSession false and ultracode off. The
 * SDK reply is recorded like a transport attempt (duration, cost, usage and
 * Workflow/tool counts), then validated by the same responseValidator the
 * transport's call carried.
 */
export function createTavilyResearchCall({
  runClaudeSdkStage, readKey = readTavilyKey, profile, recorder = null,
  beginCall = () => ({ task: RESEARCH_TASK, stage: RESEARCH_STAGE, attempt: 0 }),
  maxTurns = TAVILY_RESEARCH_MAX_TURNS,
} = {}) {
  if (typeof runClaudeSdkStage !== 'function') throw new TypeError('TAVILY_RESEARCH_NEEDS_RUN_CLAUDE_SDK_STAGE');
  if (typeof readKey !== 'function') throw new TypeError('TAVILY_RESEARCH_NEEDS_READ_KEY');
  if (!profile || typeof profile.model !== 'string' || !profile.model
    || typeof profile.effort !== 'string' || !profile.effort) throw new TypeError('TAVILY_RESEARCH_NEEDS_QA_RESEARCH_PROFILE');
  return async function tavilyResearch(prompt, opts = {}) {
    let key = '';
    try { key = String((await readKey()) ?? '').trim(); } catch { key = ''; }
    if (!key) fail('TAVILY_KEY_MISSING');
    const call = recorder && typeof recorder.begin === 'function' ? recorder.begin(beginCall({
      task: typeof opts.task === 'string' && opts.task ? opts.task : RESEARCH_TASK, stage: RESEARCH_STAGE,
    })) : null;
    if (call) await call.prompt(String(prompt ?? ''));
    let reply;
    try {
      reply = await runClaudeSdkStage({
        text: String(prompt ?? ''),
        signal: opts.signal,
        model: profile.model,
        effort: profile.effort,
        tools: [...TAVILY_RESEARCH_TOOLS],
        mcpServers: tavilyMcpServers(key),
        maxTurns,
        persistSession: false,
        ultracode: false,
        onActivity: event => {
          call?.activity?.(event);
          if (typeof opts.onActivity === 'function') opts.onActivity(event);
        },
      });
    } catch (error) {
      const sanitized = redactedError(error, key);
      if (call) await call.fail(sanitized);
      throw sanitized;
    }
    const text = String(reply?.text ?? '');
    let rejected = null;
    try { if (typeof opts.responseValidator === 'function') opts.responseValidator(text); } catch (error) { rejected = redactedError(error, key); }
    if (rejected) {
      if (call?.record && typeof call.record === 'object') {
        // A rejected reply still spent money, and its model is worth knowing.
        Object.assign(call.record, {
          providerDurationMs: Number.isFinite(reply?.durationMs) ? reply.durationMs : null,
          costUsd: typeof reply?.costUsd === 'number' && Number.isFinite(reply.costUsd) ? reply.costUsd : null,
          usage: reply?.usage && typeof reply.usage === 'object' ? reply.usage : null,
          model: typeof reply?.model === 'string' ? reply.model : null,
        });
      }
      if (call) await call.fail(rejected);
      throw rejected;
    }
    if (call) await call.succeed({ ...reply, text });
    return text;
  };
}

/** Sends only the research task to the alternative path; every other handoff keeps the transport. */
export function createResearchRouter({ call, research = null } = {}) {
  if (typeof call !== 'function') throw new TypeError('RESEARCH_ROUTER_NEEDS_TRANSPORT_CALL');
  if (research !== null && typeof research !== 'function') throw new TypeError('RESEARCH_ROUTER_NEEDS_RESEARCH_CALL');
  return function routedCall(prompt, opts = {}) {
    return research && opts?.task === RESEARCH_TASK ? research(prompt, opts) : call(prompt, opts);
  };
}

/**
 * The merged research text: both source sets labelled in a fixed order. When
 * it would exceed the validator's maximum, each set loses the same fraction of
 * its length, so neither source's share of the evidence grows or shrinks.
 */
export function buildMergedResearchText({ builtIn = '', tavily = '', maxLength = RESEARCH_MAX_CHARS } = {}) {
  if (!Number.isInteger(maxLength) || maxLength <= 0) throw new TypeError('MERGED_RESEARCH_NEEDS_MAX_LENGTH');
  const a = String(builtIn ?? '');
  const b = String(tavily ?? '');
  const head = `${RESEARCH_SOURCE_LABELS.builtIn}:\n`;
  const separator = `\n\n${RESEARCH_SOURCE_LABELS.tavily}:\n`;
  const budget = Math.max(0, maxLength - (head.length + separator.length));
  const total = a.length + b.length;
  let keptA = a.length;
  let keptB = b.length;
  if (total > budget) {
    keptA = Math.min(a.length, Math.floor((budget * a.length) / total));
    keptB = Math.min(b.length, budget - keptA);
    // A capped set can leave budget behind; the other set then keeps it, so the text fits.
    keptA = Math.min(a.length, budget - keptB);
  }
  return {
    text: `${head}${a.slice(0, keptA)}${separator}${b.slice(0, keptB)}`,
    trimmed: keptA < a.length || keptB < b.length,
    maxLength,
    sets: [
      { source: 'built-in-web-search', label: RESEARCH_SOURCE_LABELS.builtIn, length: a.length, kept: keptA, dropped: a.length - keptA },
      { source: 'tavily', label: RESEARCH_SOURCE_LABELS.tavily, length: b.length, kept: keptB, dropped: b.length - keptB },
    ],
  };
}

/**
 * One merge source: an earlier harness output directory. Its accepted
 * 'interview-brief-research' attempt is the highest-numbered calls.jsonl line
 * with that task; the numbered response file beside it holds the text.
 */
export async function readResearchResponse({ directory, readFile = readPrivate } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('RESEARCH_SOURCE_NEEDS_DIRECTORY');
  if (typeof readFile !== 'function') throw new TypeError('RESEARCH_SOURCE_NEEDS_READ_FILE');
  const lines = String(await readFile(path.join(directory, 'calls.jsonl'))).split('\n').map(line => line.trim()).filter(Boolean);
  let found = null;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.task !== RESEARCH_TASK || record?.outcome !== 'ok' || !/^\d{3,}$/u.test(String(record?.number ?? ''))) continue;
    if (!found || Number(record.number) > Number(found.number)) found = record;
  }
  if (!found) fail('MERGE_RESEARCH_RESPONSE_MISSING');
  const text = String(await readFile(path.join(directory, `${found.number}.response.txt`)));
  return { directory, callNumber: found.number, stage: typeof found.stage === 'string' ? found.stage : null,
    model: typeof found.model === 'string' ? found.model : null, length: text.length, text };
}

/** Per-stage and overall totals from recorded attempts plus handoff calls. */
export function summarizeStageTotals({ calls = [], transportCalls = [] } = {}) {
  const empty = () => ({ calls: 0, attempts: 0, costUsd: 0, durationMs: 0, workflowCalls: 0, failures: 0 });
  const stages = {};
  const entry = stage => {
    const key = typeof stage === 'string' && stage ? stage : 'unknown';
    stages[key] ||= empty();
    return stages[key];
  };
  for (const call of transportCalls) entry(call?.stage).calls += 1;
  for (const record of calls) {
    const stage = entry(record?.stage);
    stage.attempts += 1;
    if (Number.isFinite(record?.costUsd)) stage.costUsd += record.costUsd;
    if (Number.isFinite(record?.durationMs)) stage.durationMs += record.durationMs;
    if (Number.isFinite(record?.workflowCalls)) stage.workflowCalls += record.workflowCalls;
    if (record?.errorCode) stage.failures += 1;
  }
  const totals = empty();
  for (const stage of Object.values(stages)) for (const key of Object.keys(totals)) totals[key] += stage[key];
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return { stages, totals };
}

export async function runHarness(args) {
  // Loaded dynamically so importing this module (tests) never needs Electron.
  const electronPkg = (await import('electron')).default;
  if (electronPkg?.app?.getVersion?.() !== '0.0.0-test') fail('NODE_TEST_STUBS_REQUIRED');
  const sourceUserData = await realDirectory(args['user-data']);
  const bundleDirectory = await realDirectory(args['bundle-dir']);
  const output = prospectiveRealPath(args.out);
  const mergeDirectories = [];
  for (const directory of args.mergeFrom ?? []) mergeDirectories.push(await realDirectory(directory));
  for (const source of [sourceUserData, bundleDirectory, ...mergeDirectories]) {
    if (inside(source, output) || inside(output, source)) fail('OUTPUT_OVERLAPS_INPUT');
  }
  // Refuse symlink output leaves, including a dangling symlink.
  try { if ((await fs.promises.lstat(args.out)).isSymbolicLink()) fail('UNSAFE_OUTPUT'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.promises.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(output, 0o700);
  const restoreGuard = installWriteGuard([output]);
  // A live run must start in a directory without transcripts, or a later
  // replay could mix one run's prompts with another run's responses.
  if (args.transport === 'claude') {
    const existing = (await fs.promises.readdir(output)).filter(name => /^\d{3,}\.response\.txt$/u.test(name));
    if (existing.length) fail('LIVE_OUTPUT_HAS_TRANSCRIPTS');
  }
  const writeText = async (name, value) => {
    const file = path.join(output, name);
    await fs.promises.writeFile(file, value, { mode: 0o600, flag: 'w' });
    await fs.promises.chmod(file, 0o600);
  };
  const json = (name, value) => writeText(name, `${JSON.stringify(value, null, 2)}\n`);
  // A replay directory already holds the numbered transcripts; never overwrite them.
  const saveTranscript = async (name, value) => {
    if (args.transport === 'replay' && name.endsWith('.response.txt')) return;
    await writeText(name, value);
  };
  const appendCall = async line => {
    const file = path.join(output, 'calls.jsonl');
    await fs.promises.appendFile(file, `${line}\n`, { mode: 0o600 });
    await fs.promises.chmod(file, 0o600);
  };
  let recorder = null;
  const transportCalls = [];
  // The research setup is reported, never the Tavily key (it only rides in the
  // MCP server URL handed to the SDK inside this process).
  const report = {
    version: 4, transport: args.transport, ultracode: args.ultracode, ultracodeOffTasks: args.ultracodeOffTasks,
    stopAfter: args['stop-after'], status: 'running',
    research: { mode: args.research, task: RESEARCH_TASK, stage: RESEARCH_STAGE, mergeFrom: mergeDirectories,
      maxLength: RESEARCH_MAX_CHARS, mergeSources: [], sets: [], trimmed: false },
    callsFile: 'calls.jsonl', calls: [], stageTotals: {}, totals: {}, transportStages: [],
    answerValidationRounds: [], timings: {},
  };
  const writeReport = async () => {
    const summary = summarizeStageTotals({ calls: recorder?.calls ?? [], transportCalls });
    report.stageTotals = summary.stages;
    report.totals = summary.totals;
    await json('report.json', report);
  };
  let claimedAnswerCalls = 0;
  const onValidationRound = async diagnostics => {
    // These are the host's complete card checks, after both mechanical and
    // semantic review. A transport's accepted draft is not a surviving card.
    const entry = structuredClone(diagnostics);
    report.answerValidationRounds.push(entry);
    const number = String(report.answerValidationRounds.length).padStart(3, '0');
    await json(`answer-round-${number}.validation.json`, entry);
    const calls = recorder?.calls ?? [];
    const answerCalls = calls.slice(claimedAnswerCalls).filter(record => record.task === 'interview-answer-bank');
    claimedAnswerCalls = calls.length;
    for (const record of answerCalls) {
      (record.answerValidationRounds ||= []).push(entry);
      await json(`${record.number}.validation.json`, record);
    }
    if (entry.phase === 'final') {
      report.survivingCardCount = entry.survivingCardCount;
      report.droppedCards = entry.droppedCards || [];
      await json('final-dropped-cards.json', report.droppedCards);
    }
    await writeReport();
  };
  const started = performance.now();
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('HARNESS_CANCELLED'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let restoreLogger = () => {};
  let stage = 'inputs';
  try {
    // Never leave a prior successful run's final artifacts beside a failed
    // current report. Numbered transcripts remain intact for replay.
    for (const name of ['final-brief.json', 'final-answer-bank.json', 'final-dropped-cards.json', 'failure.json',
      'calls.jsonl', 'report.json',
      ...(await fs.promises.readdir(output)).filter(name => /^answer-round-\d+\.validation\.json$/u.test(name))]) {
      await fs.promises.unlink(path.join(output, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const prep = await import('../electron/ipc/interviewPreparation.js');
    const helper = await import('../electron/ipc/interviewHelper.js');
    const career = await import('../electron/ipc/careerSnapshot.js');
    const transportModule = await import('../electron/ipc/interviewClaudeTransport.js');
    const runner = await import('../electron/ipc/claudeApplicationRunner.js');
    const { __runWithIpcRequestContextForTests: withContext } = await import('../electron/ipc/ipcUtils.js');
    const { logger } = await import('../electron/logger.js');
    const logMethods = { ...logger };
    for (const name of Object.keys(logMethods)) logger[name] = () => {};
    restoreLogger = () => Object.assign(logger, logMethods);
    const canonicalJobUrl = prep.normalizeInterviewPreparationJobUrl(args['job-url']);
    if (!canonicalJobUrl) fail('INVALID_JOB_URL');
    // Only this approved pin is ever read, through the production gate and
    // projection. Do not copy or enumerate unrelated userData/private records.
    const loadSnapshot = ({ snapshotId }) => helper.loadInterviewHelperCareerSnapshot({ snapshotId, userDataPath: sourceUserData,
      readSnapshot: (root, id) => career.readPinnedCareerSnapshot(root, id, { readOnly: true }) });
    const snapshot = await loadSnapshot({ snapshotId: args['snapshot-id'] });
    if (!snapshot) fail('PINNED_SNAPSHOT_UNAVAILABLE');
    // Production capture reads the real fixed bundle files; its artifact store
    // and every subsequent publication target the isolated output directory.
    const captured = await prep.captureInterviewPreparationBundle({ directory: bundleDirectory, userDataPath: output, signal: abort.signal });
    report.inputs = { snapshotId: args['snapshot-id'], bundleArtifactId: captured.artifactId,
      reads: [path.join(sourceUserData, 'career-snapshot-store', 'career-snapshots', `${args['snapshot-id']}.json`),
        ...INPUT_FILES.map(name => path.join(bundleDirectory, name))] };
    recorder = createCallRecorder({ save: saveTranscript, append: appendCall });
    report.calls = recorder.calls;
    // Replay answers one numbered response file per Claude attempt, in order.
    let replayIndex = 0;
    const replayRunStage = async () => {
      replayIndex += 1;
      const text = await readPrivate(path.join(output, `${String(replayIndex).padStart(3, '0')}.response.txt`));
      return { text, model: 'replay', durationMs: 0 };
    };
    let currentCall = null;
    const transport = transportModule.createInterviewClaudeTransport({
      // Claude-only: an offload route would confound an ultracode comparison.
      routeFor: () => null,
      shadow: { enabled: false, measure() {} },
      // Replay runs no process, so it must not require an installed Claude CLI.
      ...(args.transport === 'replay' ? { resolveBinary: () => path.join(output, 'claude-replay') } : {}),
      runStage: createMeasuredRunStage({
        runStage: args.transport === 'replay' ? replayRunStage : runner.runClaudeStage,
        recorder,
        currentCall: () => currentCall,
      }),
      onStage: event => {
        report.transportStages.push({ task: event?.task ?? null, stage: event?.stage ?? null, attempt: event?.attempt ?? null,
          model: event?.model ?? null, provider: event?.provider ?? null, durationMs: event?.durationMs ?? null });
      },
    });
    // Name the handoff before its first attempt, so each recorded attempt carries task and stage.
    const measured = call => (prompt, opts = {}) => {
      const task = typeof opts?.task === 'string' ? opts.task : null;
      currentCall = { task, stage: transportModule.interviewClaudeStage(task, opts?.claudeStage), attempts: 0 };
      transportCalls.push(currentCall);
      return withUltracode(call, args.ultracodeOffTasks.includes(task) ? 'off' : args.ultracode)(prompt, opts);
    };
    const { careerWritingStageProfile } = await import('../electron/ipc/careerWritingCore.js');
    const researchProfile = careerWritingStageProfile(RESEARCH_STAGE);
    if (!researchProfile?.model || !researchProfile?.effort) fail('RESEARCH_PROFILE_UNAVAILABLE');
    Object.assign(report.research, { model: researchProfile.model, effort: researchProfile.effort,
      callPath: args.research === 'native' ? 'transport' : args.research === 'tavily' ? 'runClaudeSdkStage' : 'merged' });
    const transportRaw = measured(transport.callRaw);
    let researchCall = null;
    if (args.research === 'tavily') {
      const sdkStage = await import('../electron/ipc/claudeApplicationSdkStage.js');
      researchCall = createTavilyResearchCall({
        runClaudeSdkStage: sdkStage.runClaudeSdkStage,
        readKey: readTavilyKey,
        profile: researchProfile,
        recorder,
        // Booked like a transport call, so stageTotals counts the research handoff.
        beginCall: ({ task, stage: researchStage }) => {
          currentCall = { task, stage: researchStage, attempts: 0 };
          transportCalls.push(currentCall);
          return { task, stage: researchStage, attempt: 0 };
        },
      });
      Object.assign(report.research, { tools: [...TAVILY_RESEARCH_TOOLS], mcpServer: 'tavily',
        maxTurns: TAVILY_RESEARCH_MAX_TURNS, persistSession: false, ultracode: false });
    } else if (args.research === 'merged') {
      // No research: both source sets come from two earlier runs' accepted research.
      const sources = [];
      for (const directory of mergeDirectories) sources.push(await readResearchResponse({ directory }));
      const merged = buildMergedResearchText({ builtIn: sources[0].text, tavily: sources[1].text, maxLength: RESEARCH_MAX_CHARS });
      report.research.mergeSources = sources.map(({ text, ...rest }) => ({ ...rest, textLength: text.length }));
      report.research.sets = merged.sets;
      report.research.trimmed = merged.trimmed;
      report.research.mergedLength = merged.text.length;
      // Same acceptance check the transport would run on this call's text.
      researchCall = async (prompt, opts = {}) => {
        if (typeof opts.responseValidator === 'function') opts.responseValidator(merged.text);
        return merged.text;
      };
    }
    const callRaw = createResearchRouter({ call: transportRaw, research: researchCall });
    const callText = measured(transport.callText);
    const common = { nodeId: 'interview-live-prepare-harness', snapshotId: args['snapshot-id'], canonicalJobUrl,
      bundleArtifactId: captured.artifactId, manualAiRunId: 'interview-live-prepare-harness', signal: abort.signal,
      userDataPath: output, callRaw, callText };
    const context = { nodeId: common.nodeId, channel: 'build-interview-brief', manualAiRunId: null };
    stage = 'brief';
    const briefStart = performance.now();
    const { brief } = await withContext(context, () => prep.buildInterviewBrief(common));
    const published = await prep.publishInterviewPreparedBrief({ brief, userDataPath: output, signal: abort.signal });
    report.timings.briefMs = performance.now() - briefStart;
    await json('final-brief.json', published.brief);
    if (args['stop-after'] === 'brief') {
      report.status = 'brief-only';
      return report;
    }
    stage = 'answer-bank';
    const answerStart = performance.now();
    const { bank } = await withContext(context, () => prep.buildInterviewPreparedAnswers({ ...common, brief: published.brief, loadSnapshot, onValidationRound }));
    await prep.publishInterviewPreparedAnswers({ bank, brief: published.brief, userDataPath: output, signal: abort.signal, loadSnapshot });
    const sealed = await prep.loadInterviewPreparedAnswerBank({ brief: published.brief, userDataPath: output, snapshot, loadSnapshot });
    if (!sealed) fail('SEALED_BANK_RELOAD_FAILED');
    await json('final-answer-bank.json', sealed);
    report.timings.answerBankMs = performance.now() - answerStart;
    report.status = 'accepted';
    return report;
  } catch (error) {
    report.status = 'failed'; report.failedStage = stage;
    // Private diagnostics stay in the private output, never in console logs.
    await json('failure.json', { stage, code: error.code || 'PREPARE_FAILED', message: error.message });
    throw Object.assign(new Error('Interview Prepare harness failed; inspect the private output diagnostics.'), { code: 'HARNESS_FAILED' });
  } finally {
    abort.abort(new Error('HARNESS_FINISHED'));
    report.timings.totalMs = performance.now() - started;
    try { await writeReport(); } finally {
      restoreLogger(); restoreGuard();
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Restrict file modes for everything this process and the Claude CLI create.
  process.umask(0o077);
  try {
    const report = await runHarness(parseHarnessArgs(process.argv.slice(2)));
    const totals = report.totals || {};
    const stages = Object.entries(report.stageTotals || {})
      .map(([name, stage]) => `${name} ${stage.attempts}/${stage.calls}`).join(', ') || 'none';
    process.stdout.write(`Interview Prepare harness: ${report.transport} transport, research ${report.research?.mode || 'native'}, ultracode ${report.ultracode}; `
      + `${totals.attempts || 0} Claude attempts (${totals.failures || 0} failed) over ${totals.calls || 0} calls in ${Math.round(totals.durationMs || 0)} ms `
      + `(attempts/calls by stage: ${stages}); ${Math.round(report.timings?.totalMs || 0)} ms wall clock. `
      + `${report.status === 'brief-only' ? 'Sealed brief saved; answer bank skipped.' : 'Sealed brief and answer bank saved.'}\n`);
  } catch (error) {
    const safeCodes = new Set(['INVALID_ARGUMENTS', 'MISSING_ARGUMENTS', 'ABSOLUTE_DIRECTORIES_REQUIRED', 'NODE_TEST_STUBS_REQUIRED', 'OUTPUT_OVERLAPS_INPUT', 'UNSAFE_DIRECTORY', 'UNSAFE_OUTPUT', 'LIVE_OUTPUT_HAS_TRANSCRIPTS', 'TAVILY_KEY_MISSING', 'MERGE_RESEARCH_RESPONSE_MISSING']);
    process.stderr.write(`Interview Prepare harness failed (${safeCodes.has(error.code) ? error.code : 'inspect private output diagnostics'}).\n`);
    process.exitCode = 1;
  }
}
