#!/usr/bin/env node
/**
 * Plain-Node, private Interview Helper Prepare probe. Never starts Electron.
 *
 * node --import ./scripts/test-stubs/register.mjs scripts/interview-live-prepare-harness.mjs \
 *   --user-data "<dir>" --snapshot-id <id> --job-url <url> \
 *   --bundle-dir "<applied-job folder>" --out /tmp/interview-live-prep [--transport codex|replay]
 *
 * Replay consumes 001.response.txt, 002.response.txt, ... from --out. Saved
 * live responses are used verbatim. Synthetic fixtures alone may use the
 * {{HANDOFF_CODE}} token, replaced with the current transport-owned code.
 * Prompts/responses and sealed artifacts contain private evidence: --out is
 * private (0700 directories/0600 files). Console output is metadata only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPkg from 'electron';

const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const TASKS = new Set(['interview-brief-research', 'interview-brief-assessment', 'interview-answer-bank']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const INPUT_FILES = ['Application.html', 'Original Job Listing.md', 'Generation Audit.json', 'Resume.pdf', 'Cover Letter.pdf'];
const inside = (parent, child) => child === parent || (!path.relative(parent, child).startsWith(`..${path.sep}`)
  && path.relative(parent, child) !== '..' && !path.isAbsolute(path.relative(parent, child)));

function fail(code) { const error = new Error(code); error.code = code; throw error; }

export function parseHarnessArgs(argv) {
  const args = { transport: 'codex' };
  const allowed = new Set(['user-data', 'snapshot-id', 'job-url', 'bundle-dir', 'out', 'transport']);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2);
    if (!argv[index]?.startsWith('--') || !allowed.has(key) || seen.has(key)
      || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    seen.add(key); args[key] = argv[index + 1];
  }
  for (const key of ['user-data', 'snapshot-id', 'job-url', 'bundle-dir', 'out']) if (!args[key]) fail('MISSING_ARGUMENTS');
  if (!/^[a-f0-9]{64}$/u.test(args['snapshot-id']) || !['codex', 'replay'].includes(args.transport)) fail('INVALID_ARGUMENTS');
  for (const key of ['user-data', 'bundle-dir', 'out']) {
    if (!path.isAbsolute(args[key])) fail('ABSOLUTE_DIRECTORIES_REQUIRED');
    args[key] = path.resolve(args[key]);
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

/** Fail closed on filesystem mutations outside the two owned scratch roots.
 * Also check every existing output component for symlinks/hardlinks. This is
 * defense in depth around the production read-only readers, not an OS sandbox.
 * Like the production intake, this assumes no hostile concurrent same-user
 * replacement of the roots. Codex separately runs with its read-only sandbox.
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

function runChild(args, { cwd, input = '', timeoutMs = 20 * 60_000, outputLimit = MAX_RESPONSE_BYTES, signal } = {}) {
  return new Promise((resolve, reject) => {
    // Provider stdout/stderr may contain prompts, response text or credentials.
    // Capture privately; never inherit terminal streams or include them in errors.
    const child = spawn(CODEX, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let failureCode;
    let killTimer;
    const stop = code => {
      if (failureCode) return;
      failureCode = code; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    };
    const onAbort = () => stop('CODEX_CANCELLED');
    const timer = setTimeout(() => stop('CODEX_TIMEOUT'), timeoutMs);
    child.once('error', () => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('CODEX_UNAVAILABLE'), { code: 'CODEX_UNAVAILABLE' }));
    });
    child.stdin.on('error', () => { /* exit status below owns broken-pipe reporting */ });
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > outputLimit) { stop('CODEX_OUTPUT_TOO_LARGE'); return; }
      chunks[name].push(chunk);
    });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort);
      resolve({ code, failureCode, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdin.end(input);
  });
}

async function codexCapabilities(cwd) {
  const execHelp = await runChild(['exec', '--help'], { cwd, timeoutMs: 15_000 });
  const rootHelp = await runChild(['--help'], { cwd, timeoutMs: 15_000 });
  if (execHelp.code !== 0 || !execHelp.stdout.includes('--config')) fail('CODEX_EXEC_UNSUPPORTED');
  if (!execHelp.stdout.includes('--ignore-user-config')) fail('CODEX_SAFE_CONFIG_UNSUPPORTED');
  const search = /--search\b/u.test(execHelp.stdout) ? 'exec-flag' : /--search\b/u.test(rootHelp.stdout) ? 'global-flag' : null;
  // Do not guess that an older CLI honors a config key: unknown -c keys can
  // be ignored. The installed CLI advertises the live --search capability.
  if (!search) fail('CODEX_WEB_SEARCH_UNSUPPORTED');
  return { search, execHelp: execHelp.stdout, rootHelp: rootHelp.stdout };
}

export async function runHarness(args) {
  if (electronPkg.app?.getVersion?.() !== '0.0.0-test') fail('NODE_TEST_STUBS_REQUIRED');
  const sourceUserData = await realDirectory(args['user-data']);
  const bundleDirectory = await realDirectory(args['bundle-dir']);
  const output = prospectiveRealPath(args.out);
  for (const source of [sourceUserData, bundleDirectory]) {
    if (inside(source, output) || inside(output, source)) fail('OUTPUT_OVERLAPS_INPUT');
  }
  // Refuse symlink output leaves, including a dangling symlink.
  try { if ((await fs.promises.lstat(args.out)).isSymbolicLink()) fail('UNSAFE_OUTPUT'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.promises.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(output, 0o700);
  // Keep even temporary directory creation outside both protected trees (the
  // caller may have selected an ancestor of the platform temp directory).
  const scratch = await fs.promises.mkdtemp(path.join(output, '.worker-'));
  await fs.promises.chmod(scratch, 0o700);
  const restoreGuard = installWriteGuard([output, fs.realpathSync(scratch)]);
  const writeText = async (name, value) => {
    const file = path.join(output, name);
    await fs.promises.writeFile(file, value, { mode: 0o600, flag: 'w' });
    await fs.promises.chmod(file, 0o600);
  };
  const json = (name, value) => writeText(name, `${JSON.stringify(value, null, 2)}\n`);
  const report = { version: 2, transport: args.transport, status: 'running', steps: [], answerValidationRounds: [], timings: {} };
  let pendingAnswerSteps = [];
  const onValidationRound = async diagnostics => {
    // These are the host's complete card checks, after both mechanical and
    // semantic review. A transport's accepted draft is not a surviving card.
    await queue;
    const entry = structuredClone(diagnostics);
    report.answerValidationRounds.push(entry);
    const number = String(report.answerValidationRounds.length).padStart(3, '0');
    await json(`answer-round-${number}.validation.json`, entry);
    const steps = pendingAnswerSteps.length ? pendingAnswerSteps : report.steps.slice(-1).filter(step => step.task === 'interview-answer-bank');
    for (const step of steps) {
      (step.answerValidationRounds ||= []).push(entry);
      await json(`${step.number}.validation.json`, step);
    }
    pendingAnswerSteps = [];
    if (entry.phase === 'final') {
      report.survivingCardCount = entry.survivingCardCount;
      report.droppedCards = entry.droppedCards || [];
      await json('final-dropped-cards.json', report.droppedCards);
    }
    await json('report.json', report);
  };
  const started = performance.now();
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('HARNESS_CANCELLED'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let restoreLogger = () => {};
  let stage = 'inputs';
  let queue = Promise.resolve();
  let transportFailure;
  try {
    // Never leave a prior successful run's final artifacts beside a failed
    // current report. Numbered response recordings remain intact for replay.
    for (const name of ['final-brief.json', 'final-answer-bank.json', 'final-dropped-cards.json', 'failure.json',
      ...(await fs.promises.readdir(output)).filter(name => /^answer-round-\d+\.validation\.json$/u.test(name))]) {
      await fs.promises.unlink(path.join(output, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const prep = await import('../electron/ipc/interviewPreparation.js');
    const helper = await import('../electron/ipc/interviewHelper.js');
    const career = await import('../electron/ipc/careerSnapshot.js');
    const bridge = await import('../electron/ipc/nonApiAi.js');
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
    let capabilities;
    if (args.transport === 'codex') {
      const codexState = prospectiveRealPath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
      if ([sourceUserData, bundleDirectory].some(source => inside(source, codexState) || inside(codexState, source))) fail('CODEX_STATE_OVERLAPS_INPUT');
      if ((await fs.promises.readdir(output)).some(name => /^\d+\.response\.txt$/u.test(name))) fail('LIVE_OUTPUT_ALREADY_HAS_RESPONSES');
      capabilities = await codexCapabilities(scratch);
      await writeText('codex-exec-help.txt', capabilities.execHelp);
      await writeText('codex-help.txt', capabilities.rootHelp);
      report.codex = { executable: CODEX, model: 'gpt-6.1-sol', sandbox: 'read-only', webSearch: capabilities.search };
    }
    const sender = new EventEmitter();
    sender.id = 791901;
    sender.isDestroyed = () => false;
    let sequence = 0;
    const service = async payload => {
      const access = { requestId: payload.requestId, handoffCode: payload.handoffCode, allowTasks: TASKS, allowNodeIds: new Set(['interview-live-prepare-harness']) };
      const handoff = bridge.readBridgeableNonApiAiHandoff(access);
      if (!handoff.ok) fail('BRIDGE_HANDOFF_UNAVAILABLE');
      const number = String(++sequence).padStart(3, '0');
      const step = { number, task: handoff.task, attempt: handoff.attempt, isCorrection: handoff.isCorrection, accepted: false };
      report.steps.push(step);
      if (handoff.task === 'interview-answer-bank') pendingAnswerSteps.push(step);
      const before = performance.now();
      try {
        await writeText(`${number}.prompt.txt`, handoff.prompt);
        let response;
        if (args.transport === 'replay') {
          response = (await readPrivate(path.join(output, `${number}.response.txt`))).replaceAll('{{HANDOFF_CODE}}', handoff.handoffCode);
        } else {
          const responseFile = path.join(output, `${number}.response.txt`);
          const cliArgs = ['exec', '-m', 'gpt-6.1-sol', '-s', 'read-only', '--skip-git-repo-check'];
          if (capabilities.search === 'global-flag') cliArgs.unshift('--search');
          else if (capabilities.search === 'exec-flag') cliArgs.push('--search');
          for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules']) {
            if (capabilities.execHelp.includes(flag)) cliArgs.push(flag);
          }
          // No inherited user config, repo context, or writable shell paths.
          cliArgs.push('-o', responseFile, '-');
          step.command = [CODEX, ...cliArgs];
          if ((await fs.promises.readdir(scratch)).length) fail('WORKER_DIRECTORY_NOT_EMPTY');
          const child = await runChild(cliArgs, { cwd: scratch, input: handoff.prompt, signal: abort.signal });
          await writeText(`${number}.codex-stdout.txt`, child.stdout);
          await writeText(`${number}.codex-stderr.txt`, child.stderr);
          if (child.failureCode) fail(child.failureCode);
          if (child.code !== 0) fail('CODEX_EXEC_FAILED');
          // The CLI owns -o; verify that it produced a regular bounded response.
          response = await readPrivate(responseFile);
          await fs.promises.chmod(responseFile, 0o600);
        }
        step.transportMs = performance.now() - before;
        const validationStart = performance.now();
        const verdict = await bridge.submitNonApiAiResponseForBridge({ ...access, response });
        step.validationMs = performance.now() - validationStart;
        Object.assign(step, verdict);
        process.stdout.write(`Interview Prepare: ${handoff.task} ${verdict.outcome}.\n`);
        if (!['accepted', 'rejected'].includes(verdict.outcome)) fail('BRIDGE_SUBMISSION_STOPPED');
      } catch (error) {
        if (!step.outcome) { step.outcome = 'transport_failed'; step.failureCode = error.code || 'TRANSPORT_FAILED'; }
        throw error;
      } finally {
        step.elapsedMs = performance.now() - before;
        await json(`${number}.validation.json`, step);
        await json('report.json', report);
      }
    };
    sender.send = (channel, payload) => {
      if (channel !== 'non-api-ai-request') return;
      // sendRequest is synchronous. Service after it finishes registering the
      // request; rejection delivery is queued by the same production path.
      queue = queue.then(() => service(payload)).catch(error => {
        transportFailure ||= error; abort.abort(error);
      });
    };
    const common = { nodeId: 'interview-live-prepare-harness', snapshotId: args['snapshot-id'], canonicalJobUrl,
      bundleArtifactId: captured.artifactId, manualAiRunId: 'interview-live-prepare-harness', signal: abort.signal, userDataPath: output };
    const context = { sender, nodeId: common.nodeId, channel: 'build-interview-brief', manualAiRunId: null };
    stage = 'brief';
    const briefStart = performance.now();
    const { brief } = await withContext(context, () => prep.buildInterviewBrief(common));
    const published = await prep.publishInterviewPreparedBrief({ brief, userDataPath: output, signal: abort.signal });
    report.timings.briefMs = performance.now() - briefStart;
    await json('final-brief.json', published.brief);
    stage = 'answer-bank';
    const answerStart = performance.now();
    const { bank } = await withContext(context, () => prep.buildInterviewPreparedAnswers({ ...common, brief: published.brief, loadSnapshot, onValidationRound }));
    await prep.publishInterviewPreparedAnswers({ bank, brief: published.brief, userDataPath: output, signal: abort.signal, loadSnapshot });
    const sealed = await prep.loadInterviewPreparedAnswerBank({ brief: published.brief, userDataPath: output, snapshot, loadSnapshot });
    if (!sealed) fail('SEALED_BANK_RELOAD_FAILED');
    await json('final-answer-bank.json', sealed);
    report.timings.answerBankMs = performance.now() - answerStart;
    await queue;
    if (transportFailure) throw transportFailure;
    report.status = 'accepted';
    return report;
  } catch (error) {
    report.status = 'failed'; report.failedStage = stage;
    // Private diagnostics stay in the private output, never in console logs.
    await json('failure.json', { stage, code: transportFailure?.code || error.code || 'PREPARE_FAILED', message: (transportFailure || error).message });
    throw Object.assign(new Error('Interview Prepare harness failed; inspect the private output diagnostics.'), { code: 'HARNESS_FAILED' });
  } finally {
    abort.abort(new Error('HARNESS_FINISHED'));
    await queue;
    report.timings.totalMs = performance.now() - started;
    try { await json('report.json', report); } finally {
      restoreLogger(); restoreGuard();
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      await fs.promises.rm(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Restrict file modes for everything this process and Codex create.
  process.umask(0o077);
  try {
    await runHarness(parseHarnessArgs(process.argv.slice(2)));
    process.stdout.write('Interview Prepare harness: sealed brief and answer bank saved.\n');
  } catch (error) {
    const safeCodes = new Set(['INVALID_ARGUMENTS', 'MISSING_ARGUMENTS', 'ABSOLUTE_DIRECTORIES_REQUIRED', 'NODE_TEST_STUBS_REQUIRED', 'OUTPUT_OVERLAPS_INPUT', 'UNSAFE_DIRECTORY', 'UNSAFE_OUTPUT']);
    process.stderr.write(`Interview Prepare harness failed (${safeCodes.has(error.code) ? error.code : 'inspect private output diagnostics'}).\n`);
    process.exitCode = 1;
  }
}
