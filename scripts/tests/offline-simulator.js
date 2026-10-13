// The offline application simulator (.test-artifacts/blackbox-run/offline-simulator.mjs):
// a development tool that lets a stand-in writer drive the REAL host stages of one
// application, in process, with no Electron app, no ChatGPT and no bridge.
//
// These tests drive the simulator the way a driver does, as a CLI in child
// processes (init / next / submit / status / docs / log / serve / autoplay), and
// check the plumbing rather than the writing. Only the stand-in writer is
// scripted; every verdict is the production host's. Each rule is proven by
// flipping one input in a temporary fixture and expecting the outcome to flip.
//
// What each test proves:
//   scripted run   init -> terminal through the CLI (a spawned next/submit prefix, the
//                  JSON-lines serve loop, and autoplay) for three unrelated synthetic
//                  careers; the handoff count per stage is a property of the flow, not
//                  of the career; docs and log report what happened
//   saved card     init from a saved job card + approved snapshot copies the snapshot
//                  byte for byte, reads both sources without changing them, and the
//                  first prompt carries THAT card (flip the card, the prompt flips)
//   isolation      init refuses a non-empty directory, a directory that overlaps a
//                  protected real location, and a second init; a failed init leaves
//                  nothing behind; the write guard blocks writes to protected places
//   bridge         junk / wrong-stage / wrong-job answers are refused by the bridge's
//                  own classifier before the host sees them; a schema-invalid answer is
//                  rejected by the host with check ids and the SAME handoff code; the
//                  corrected answer is accepted; a replayed code is a duplicate
//   claim          next is stable for a served handoff across processes; --reread claims
//                  a fresh match task and the old code is then refused
//   auto-ack       --auto-ack answers the acknowledgement-only repair pages (flip it and
//                  the page is served to the writer instead)
//   transports     the spool transport answers the same get_handoff JSON the CLI prints
//   robustness     usage errors, an uninitialized or moved directory, a stale lock
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assert } from './testHelpers.js';
import { currentAuthorityFlowKit as kit } from './local-ai-application.js';
import { APPLICATION_QUALITY_CRITERIA } from '../../electron/ipc/localAiApplication.js';
import { careerSnapshotStorageRoot } from '../../electron/ipc/careerSnapshot.js';
import {
  ACK_ONLY_STAGES, SYNTHETIC_SPECS, createScriptedWriter, sharedFieldsOfPrompt, writeSyntheticSnapshot,
} from '../../.test-artifacts/blackbox-run/offline-simulator.mjs';

const execFileP = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REGISTER = fileURLToPath(new URL('../test-stubs/register.mjs', import.meta.url));
const SIM = fileURLToPath(new URL('../../.test-artifacts/blackbox-run/offline-simulator.mjs', import.meta.url));
const cliArgs = args => ['--import', REGISTER, SIM, ...args];

async function cli(args, { env = {} } = {}) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, cliArgs(args), {
      cwd: REPO_ROOT, maxBuffer: 128 * 1024 * 1024, timeout: 100_000, env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '', killed: error.killed === true };
  }
}
const cliJson = async (args, options) => {
  const result = await cli([...args, '--json'], options);
  let parsed = null;
  try { parsed = JSON.parse(result.stdout.trim().split('\n').pop()); } catch { /* reported by the caller's assert */ }
  return { ...result, json: parsed };
};

const scratch = async name => fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), `offline-sim-${name}-`)));
const cleanup = dirs => Promise.all(dirs.map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
const listTree = root => {
  const rows = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) { rows[path.relative(root, target)] = 'dir'; walk(target); }
      else {
        const stat = fs.statSync(target);
        rows[path.relative(root, target)] = `${stat.size}:${stat.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return rows;
};

const envelope = (shared, fields) => JSON.stringify({ protocol: shared.protocol, jobId: shared.jobId, stage: shared.stage, handoffCode: shared.handoffCode, baseHashes: shared.baseHashes, ...fields });
const newWriter = (spec, options = {}) => createScriptedWriter({ spec, kit, criteria: APPLICATION_QUALITY_CRITERIA, ...options });

export default [

  {
    name: 'Offline simulator: init from a saved job card copies the approved snapshot byte for byte, never changes either source, and the first prompt carries that card (flip the card, the prompt flips)',
    async run() {
      const root = await scratch('card');
      try {
        const cards = [SYNTHETIC_SPECS[0], SYNTHETIC_SPECS[1], SYNTHETIC_SPECS[3]];
        for (const [index, spec] of cards.entries()) {
          const store = path.join(root, `store-${index}`);
          const userData = path.join(store, 'user-data');
          const jobFolder = path.join(store, 'job-folder');
          fs.mkdirSync(jobFolder, { recursive: true });
          const { snapshotId, texts } = await writeSyntheticSnapshot({ spec, snapshotRoot: careerSnapshotStorageRoot(userData) });
          const cardId = `fixture-card-${index}`;
          const writeCanvas = (title, company) => fs.writeFileSync(path.join(jobFolder, 'canvas.json'), JSON.stringify({
            schemaVersion: 3, edges: [], drawings: [],
            nodes: [{ id: 'unrelated-note', type: 'note', position: { x: 0, y: 0 }, data: { text: 'not a card' } },
              { id: cardId, type: 'jobcard', position: { x: 10, y: 10 }, data: { title, company, snippet: texts.listing, location: 'Remote', url: 'https://example.test/posting', source: 'fixture' } }],
          }));
          writeCanvas(spec.title, spec.employer);
          const sources = [`--real-canvas`, path.join(jobFolder, 'canvas.json'), '--real-user-data', userData, '--snapshot-id', snapshotId];
          const before = JSON.stringify([listTree(store)]);

          const dir = path.join(root, `run-${index}`);
          const init = await cliJson(['init', '--card', `node:${cardId}`, '--dir', dir, ...sources]);
          assert(init.code === 0 && init.json?.complete === true, `${spec.key}: init from a saved card succeeds (${init.stderr.slice(-400)})`);
          assert(JSON.stringify([listTree(store)]) === before, `${spec.key}: neither the saved canvas nor the snapshot store changed (sizes, mtimes, bytes)`);
          const copied = path.join(dir, 'userData', 'career-snapshot-store', 'career-snapshots', `${snapshotId}.json`);
          const original = path.join(userData, 'career-snapshot-store', 'career-snapshots', `${snapshotId}.json`);
          assert(fs.readFileSync(copied).equals(fs.readFileSync(original)), `${spec.key}: the snapshot is a byte copy`);
          const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'canvas', 'canvas.json'), 'utf8'));
          assert(fixture.nodes.length === 1 && fixture.nodes[0].id === cardId && fixture.nodes[0].data.localApplication?.id === init.json.jobId, `${spec.key}: the run canvas holds exactly the chosen card, pointed at the queued job`);
          assert(fs.existsSync(path.join(dir, 'canvas', '.local-ai', 'jobs', init.json.jobId)), `${spec.key}: the job lives under the run directory`);

          const served = await cliJson(['next', '--dir', dir]);
          assert(served.json?.stage === 'requirements', `${spec.key}: the first stage is the requirements stage`);
          assert(served.json.prompt.includes(spec.title) && served.json.prompt.includes(spec.employer) && served.json.prompt.includes(texts.listing), `${spec.key}: the prompt carries the chosen card's title, company and listing`);

          // Flip the card: a different posting in the same saved canvas changes the prompt.
          const flipped = SYNTHETIC_SPECS[(SYNTHETIC_SPECS.indexOf(spec) + 1) % SYNTHETIC_SPECS.length];
          writeCanvas(flipped.title, flipped.employer);
          const dirFlipped = path.join(root, `run-${index}-flipped`);
          assert((await cli(['init', '--card', `node:${cardId}`, '--dir', dirFlipped, ...sources])).code === 0, `${spec.key}: init from the flipped card succeeds`);
          const servedFlipped = await cliJson(['next', '--dir', dirFlipped]);
          assert(servedFlipped.json.prompt.includes(flipped.title) && !servedFlipped.json.prompt.includes(spec.title), `${spec.key}: the flipped card changes the prompt`);

          // A snapshot id the store does not hold fails closed and leaves the directory empty.
          const dirMissing = path.join(root, `run-${index}-missing`);
          fs.mkdirSync(dirMissing);
          const missing = await cli(['init', '--card', `node:${cardId}`, '--dir', dirMissing, '--real-canvas', path.join(jobFolder, 'canvas.json'), '--real-user-data', userData, '--snapshot-id', 'a'.repeat(64)]);
          assert(missing.code === 1 && fs.readdirSync(dirMissing).length === 0, `${spec.key}: an absent snapshot fails and leaves nothing behind (${missing.stderr.slice(-200)})`);
          const notCard = await cli(['init', '--card', 'node:unrelated-note', '--dir', path.join(root, `run-${index}-note`), ...sources]);
          assert(notCard.code === 1 && /not a saved job card/u.test(notCard.stderr), `${spec.key}: a node that is not a job card is refused (${notCard.stderr.slice(-200)})`);
        }
      } finally { await cleanup([root]); }
    },
  },
  {
    name: 'Offline simulator: init is for an empty directory only, refuses protected real locations, and a failed init leaves nothing behind; the write guard blocks writes to protected places',
    async run() {
      const root = await scratch('safety');
      try {
        const realData = path.join(root, 'real-user-data');
        const jobFolder = path.join(root, 'job-folder');
        fs.mkdirSync(realData, { recursive: true });
        fs.mkdirSync(jobFolder, { recursive: true });
        fs.writeFileSync(path.join(jobFolder, 'canvas.json'), JSON.stringify({ nodes: [] }));
        const guard = ['--real-user-data', realData, '--real-canvas', path.join(jobFolder, 'canvas.json')];
        const spec = `synthetic:${SYNTHETIC_SPECS[2].key}`;

        // Refused: overlapping protected roots, protected folder names, a parent of a protected root.
        const refused = [path.join(realData, 'run'), realData, path.join(jobFolder, 'run'), root, path.join(root, 'x', 'Applied Jobs', 'run'), path.join(root, 'x', '.local-ai', 'run')];
        for (const dir of refused) {
          const result = await cli(['init', '--card', spec, '--dir', dir, ...guard]);
          assert(result.code === 1 && /protected|Applied Jobs|\.local-ai/u.test(result.stderr), `${path.relative(root, dir) || '(root)'} is refused (${result.stderr.slice(-200)})`);
        }
        assert(!fs.existsSync(path.join(realData, 'run')) && !fs.existsSync(path.join(jobFolder, 'run')) && !fs.existsSync(path.join(root, 'x')), 'a refused init creates nothing');

        // Accepted once; a second init, and a non-empty directory, are refused without touching anything.
        const dir = path.join(root, 'ok-run');
        assert((await cli(['init', '--card', spec, '--dir', dir, ...guard])).code === 0, 'a scratch directory is accepted');
        const treeBefore = JSON.stringify(listTree(dir));
        const again = await cli(['init', '--card', spec, '--dir', dir, ...guard]);
        assert(again.code === 1 && /already holds an initialized simulator run/u.test(again.stderr), `a second init is refused (${again.stderr.slice(-200)})`);
        assert(JSON.stringify(listTree(dir)) === treeBefore, 'the refused second init changed nothing');
        const busy = path.join(root, 'busy');
        fs.mkdirSync(busy);
        fs.writeFileSync(path.join(busy, 'keep.txt'), 'mine');
        const busyResult = await cli(['init', '--card', spec, '--dir', busy, ...guard]);
        assert(busyResult.code === 1 && /not empty/u.test(busyResult.stderr) && fs.readFileSync(path.join(busy, 'keep.txt'), 'utf8') === 'mine' && fs.readdirSync(busy).length === 1, `a non-empty directory is refused untouched (${busyResult.stderr.slice(-200)})`);

        // A failure after the directory has been populated cleans up: absent dir stays absent, an empty dir stays empty.
        const failing = ['init', '--card', 'node:no-such-card', ...guard];
        const absent = path.join(root, 'absent-run');
        const failAbsent = await cli([...failing, '--dir', absent]);
        assert(failAbsent.code === 1 && !fs.existsSync(absent), `a failed init removes the directory it created (${failAbsent.stderr.slice(-200)})`);
        const empty = path.join(root, 'empty-run');
        fs.mkdirSync(empty);
        const failEmpty = await cli([...failing, '--dir', empty]);
        assert(failEmpty.code === 1 && fs.readdirSync(empty).length === 0, 'a failed init empties a directory that was empty before');
        const retried = await cli(['init', '--card', spec, '--dir', empty, ...guard]);
        assert(retried.code === 0, `the emptied directory can be initialized afterwards (${retried.stderr.slice(-200)})`);

        // The write guard (child process: it patches fs for the whole process).
        const script = `
          import fs from 'node:fs';
          import path from 'node:path';
          const [protectedDir, allowedDir, skip] = process.argv.slice(1);
          const sim = await import(${JSON.stringify(pathToFileURL(SIM).href)});
          if (skip !== 'skip') sim.installWriteGuard({ protectedRoots: [protectedDir], allowedRoots: [allowedDir] });
          const results = {};
          const attempt = async (name, fn) => { try { await fn(); results[name] = 'wrote'; } catch (error) { results[name] = error.code === 'write_guard' ? 'blocked' : 'error:' + error.code; } };
          results.readProtected = fs.readFileSync(path.join(protectedDir, 'existing.txt'), 'utf8');
          fs.writeFileSync(path.join(allowedDir, 'seed.txt'), 'seed');
          await attempt('writeFileSync', () => fs.writeFileSync(path.join(protectedDir, 'a.txt'), 'x'));
          await attempt('promises.writeFile', () => fs.promises.writeFile(path.join(protectedDir, 'b.txt'), 'x'));
          await attempt('mkdirSync', () => fs.mkdirSync(path.join(protectedDir, 'sub')));
          await attempt('renameSync into', () => fs.renameSync(path.join(allowedDir, 'seed.txt'), path.join(protectedDir, 'moved.txt')));
          await attempt('openSync write', () => fs.closeSync(fs.openSync(path.join(protectedDir, 'c.txt'), 'w')));
          await attempt('rmSync existing', () => fs.rmSync(path.join(protectedDir, 'existing.txt')));
          await attempt('applied jobs segment', () => { fs.mkdirSync(path.join(allowedDir, '..', 'elsewhere', 'Applied Jobs'), { recursive: true }); });
          await attempt('allowed write', () => fs.writeFileSync(path.join(allowedDir, 'ok.txt'), 'x'));
          console.log(JSON.stringify(results));`;
        const guardDir = path.join(root, 'g-protected');
        const allowedDir = path.join(root, 'g-allowed');
        fs.mkdirSync(guardDir); fs.mkdirSync(allowedDir);
        fs.writeFileSync(path.join(guardDir, 'existing.txt'), 'real');
        const runGuard = async skip => JSON.parse((await execFileP(process.execPath, ['--import', REGISTER, '--input-type=module', '-e', script, guardDir, allowedDir, skip], { cwd: REPO_ROOT })).stdout.trim().split('\n').pop());
        const guarded = await runGuard('guard');
        for (const name of ['writeFileSync', 'promises.writeFile', 'mkdirSync', 'renameSync into', 'openSync write', 'rmSync existing', 'applied jobs segment']) {
          assert(guarded[name] === 'blocked', `the guard blocks ${name} (${JSON.stringify(guarded)})`);
        }
        assert(guarded['allowed write'] === 'wrote' && guarded.readProtected === 'real', 'the guard allows the run directory and reads');
        fs.rmSync(path.join(root, 'elsewhere'), { recursive: true, force: true });
        const control = await runGuard('skip');
        assert(['writeFileSync', 'promises.writeFile', 'mkdirSync', 'openSync write'].every(name => control[name] === 'wrote'), `without the guard the same writes happen (${JSON.stringify(control)})`);
      } finally { await cleanup([root]); }
    },
  },
  {
    name: 'Offline simulator: the bridge refuses junk, a wrong stage and a wrong job before the host sees them; the host rejects a schema-invalid answer with check ids and the same code; the corrected answer is accepted; a replayed code is a duplicate',
    async run() {
      const root = await scratch('bridge');
      try {
        const spec = SYNTHETIC_SPECS[3];
        const dir = path.join(root, 'run');
        assert((await cli(['init', '--card', `synthetic:${spec.key}`, '--dir', dir])).code === 0, 'init succeeds');
        const served = (await cliJson(['next', '--dir', dir])).json;
        assert(served.status === 'served' && served.stage === 'requirements' && typeof served.instructions === 'string' && served.instructions.length > 50, 'next prints the bridge-shaped served body');
        const shared = sharedFieldsOfPrompt(served.prompt);
        const jobFolder = path.join(dir, 'canvas', '.local-ai', 'jobs', shared.jobId);
        const hostState = () => ({
          log: fs.readFileSync(path.join(jobFolder, 'Generation Log.jsonl'), 'utf8').split('\n').filter(Boolean).length,
          revision: JSON.parse(fs.readFileSync(path.join(jobFolder, 'manifest.json'), 'utf8')).paste.revision,
          rejectionRows: fs.existsSync(path.join(jobFolder, 'Paste Rejections.json')) ? JSON.parse(fs.readFileSync(path.join(jobFolder, 'Paste Rejections.json'), 'utf8')).length : 0,
        });
        const before = hostState();
        const send = async (name, content, extra = []) => {
          const file = path.join(root, `${name}.json`);
          fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
          return cliJson(['submit', '--dir', dir, '--file', file, ...extra]);
        };

        const junk = await send('junk', '{}');
        const wrongStage = await send('stage', { ...shared, stage: 'resume' });
        const wrongJob = await send('job', { ...shared, jobId: '00000000-0000-4000-8000-000000000000' });
        assert(junk.code === 3 && junk.json.status === 'junk', `{} is junk (${junk.stdout})`);
        assert(wrongStage.code === 3 && wrongStage.json.status === 'superseded' && /"resume" stage/u.test(wrongStage.json.note), `a wrong stage is superseded (${wrongStage.stdout})`);
        assert(wrongJob.code === 3 && wrongJob.json.status === 'misrouted', `a wrong job is misrouted (${wrongJob.stdout})`);
        assert(JSON.stringify(hostState()) === JSON.stringify(before), 'the host never saw the three refused answers (log and revision unchanged)');

        // A parseable but schema-invalid answer reaches the host and is rejected with named checks.
        const bad = await send('bad', { ...shared, storeDigest: 'x', complete: true, identity: { name: spec.name, contact: [] }, evidence: [], requirements: [] });
        assert(bad.code === 3 && bad.json.status === 'rejected' && bad.json.validationErrors.length >= 1 && typeof bad.json.correctionPrompt === 'string', `the host rejects it (${bad.stdout.slice(0, 300)})`);
        assert(bad.json.handoffCode === shared.handoffCode && bad.json.sim.rotated === false && bad.json.sim.checkIds.length >= 1, `the rejection keeps the code and names check ids (${JSON.stringify(bad.json.sim)})`);
        assert(hostState().rejectionRows === before.rejectionRows + 1, 'a host rejection is recorded by the host (one new rejection row)');
        const reserved = (await cliJson(['next', '--dir', dir])).json;
        assert(reserved.handoffCode === shared.handoffCode && reserved.attempt >= 2 && reserved.corrections.length === bad.json.validationErrors.length && typeof reserved.correctionPrompt === 'string',
          `the corrected handoff is served with its corrections (${JSON.stringify({ attempt: reserved.attempt, corrections: reserved.corrections?.length })})`);

        // Flip only the content: the scripted answer to the same handoff is accepted.
        const fields = await newWriter(spec).respond({ stage: 'requirements', prompt: served.prompt });
        const good = await send('good', envelope(shared, fields));
        assert(good.code === 0 && good.json.status === 'accepted' && good.json.next?.stage === 'requirements-audit', `the corrected answer is accepted (${good.stdout.slice(0, 300)})`);
        const replay = await send('replay', envelope(shared, fields), ['--code', shared.handoffCode]);
        assert(replay.code === 3 && replay.json.status === 'duplicate', `replaying an accepted code is a duplicate (${replay.stdout})`);
        const unknown = await send('unknown', envelope(shared, fields), ['--code', 'Zz-not-a-code-0000000000']);
        assert(unknown.code === 3 && unknown.json.status === 'unknown_handoff', `an unknown code is not recognised (${unknown.stdout})`);

        const log = (await cliJson(['log', '--dir', dir])).json;
        assert(log.totals.bridgeRefused === 5 && log.totals.rejected === 1 && log.totals.accepted === 1, `the log counts the five refusals, one rejection and one acceptance (${JSON.stringify(log.totals)})`);
        assert(log.rejections.length === 1 && log.rejections[0].stage === 'requirements' && log.rejections[0].checkIds.length >= 1 && log.rejections[0].rejectionStreak === 1, `the log carries the rejection with its check ids and streak (${JSON.stringify(log.rejections)})`);
      } finally { await cleanup([root]); }
    },
  },
  {
    name: 'Offline simulator: the spool transport answers the same get_handoff JSON the CLI prints, and submit_handoff through it advances the host',
    async run() {
      const root = await scratch('spool');
      try {
        const spec = SYNTHETIC_SPECS[3];
        const dir = path.join(root, 'run');
        assert((await cli(['init', '--card', `synthetic:${spec.key}`, '--dir', dir])).code === 0, 'init succeeds');
        const child = spawn(process.execPath, cliArgs(['serve', '--dir', dir, '--spool']), { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        const spool = path.join(dir, 'spool');
        const call = async (id, payload) => {
          for (let wait = 0; wait < 100 && !fs.existsSync(spool); wait += 1) await new Promise(resolve => setTimeout(resolve, 100));
          fs.writeFileSync(path.join(spool, `${id}.request.json`), JSON.stringify(payload));
          const response = path.join(spool, `${id}.response.json`);
          for (let wait = 0; wait < 400 && !fs.existsSync(response); wait += 1) await new Promise(resolve => setTimeout(resolve, 100));
          assert(fs.existsSync(response), `the spool answered ${id}`);
          return JSON.parse(fs.readFileSync(response, 'utf8'));
        };
        try {
          const got = await call('one', { tool: 'get_handoff' });
          const viaCli = (await cliJson(['next', '--dir', dir])).json;
          assert(got.ok && got.result.status === 'served' && got.result.handoffCode === viaCli.handoffCode && got.result.prompt === viaCli.prompt, 'the spool and the CLI serve the same handoff');
          const shared = sharedFieldsOfPrompt(got.result.prompt);
          const fields = await newWriter(spec).respond({ stage: got.result.stage, prompt: got.result.prompt });
          const sent = await call('two', { tool: 'submit_handoff', handoffCode: got.result.handoffCode, response: JSON.parse(envelope(shared, fields)) });
          assert(sent.ok && sent.result.status === 'accepted' && sent.result.next?.stage === 'requirements-audit', `submit_handoff through the spool is accepted (${JSON.stringify(sent).slice(0, 200)})`);
          const unknown = await call('three', { tool: 'no_such_tool' });
          assert(unknown.ok === false && /Unknown tool/u.test(unknown.error), 'an unknown tool is reported, not fatal');
        } finally {
          fs.writeFileSync(path.join(spool, 'STOP'), '');
          await once(child, 'exit');
        }
      } finally { await cleanup([root]); }
    },
  },
  {
    name: 'Offline simulator: usage errors, an uninitialized or moved directory, a stale lock and a held lock are reported clearly',
    async run() {
      const root = await scratch('robust');
      try {
        const unknownCommand = await cli(['frobnicate']);
        assert(unknownCommand.code === 2 && /Unknown command/u.test(unknownCommand.stderr), `an unknown command is a usage error (${unknownCommand.stderr})`);
        const unknownOption = await cli(['next', '--dir', root, '--bogus']);
        assert(unknownOption.code === 2 && /Unknown option --bogus/u.test(unknownOption.stderr), 'an unknown option is a usage error');
        const noCard = await cli(['init', '--dir', path.join(root, 'x')]);
        assert(noCard.code === 2 && /--card is required/u.test(noCard.stderr), 'init without --card is a usage error');
        const uninitialized = await cli(['next', '--dir', root]);
        assert(uninitialized.code === 1 && /not an initialized simulator run/u.test(uninitialized.stderr), `an uninitialized directory is named (${uninitialized.stderr})`);
        const help = await cli(['help']);
        assert(help.code === 0 && /init\s+--card/u.test(help.stdout), 'help documents init');

        const dir = path.join(root, 'run');
        assert((await cli(['init', '--card', `synthetic:${SYNTHETIC_SPECS[0].key}`, '--dir', dir])).code === 0, 'init succeeds');
        const noFile = await cli(['submit', '--dir', dir]);
        assert(noFile.code === 2 && /--file/u.test(noFile.stderr), 'submit without --file is a usage error');
        const missingFile = await cli(['submit', '--dir', dir, '--file', path.join(root, 'nope.json')]);
        assert(missingFile.code === 1 && /not found/u.test(missingFile.stderr), 'a missing response file is named');

        // A lock left by a dead process is taken over; a live holder is waited for, then reported.
        const lock = path.join(dir, '.simulator.lock');
        fs.writeFileSync(lock, '2147483000');
        const stale = await cli(['status', '--dir', dir]);
        assert(stale.code === 0 && !fs.existsSync(lock), `a stale lock is recovered (${stale.stderr.slice(-200)})`);
        fs.writeFileSync(lock, String(process.pid));
        const held = await cli(['status', '--dir', dir], { env: { OFFLINE_SIM_LOCK_TIMEOUT_MS: '600' } });
        assert(held.code === 1 && /held/u.test(held.stderr), `a live holder is reported (${held.stderr.slice(-200)})`);
        fs.rmSync(lock);

        const moved = path.join(root, 'moved');
        fs.renameSync(dir, moved);
        const movedResult = await cli(['status', '--dir', moved]);
        assert(movedResult.code === 1 && /moved/u.test(movedResult.stderr), `a moved run is detected (${movedResult.stderr.slice(-200)})`);
      } finally { await cleanup([root]); }
    },
  },
];
