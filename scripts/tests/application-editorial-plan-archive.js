import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEditorialPlan, saveEditorialPlan } from '../../electron/ipc/applicationEditorialPlanArchive.js';
import { EDITORIAL_PLAN_VERSION } from '../../electron/ipc/applicationEditorialPlan.js';

const IDS = ['host.career.achievement.freight-1.1', 'host.career.project.library-plan.1'];
const SOURCE_DIGEST = 'a'.repeat(64);
const WRITER_DIGEST = 'b'.repeat(64);
const PLAN_RUN_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PLAN = {
  thesis: 'Connect scheduling experience to reliable coordination.',
  paragraphs: [{ point: 'Show a concrete scheduling example.', jobNeed: 'Coordinate schedules.',
    evidenceIds: [IDS[0]], editorialNote: 'The example directly supports the proposed point.' }],
  omissions: [{ evidenceIds: [IDS[1]], editorialNote: 'The other example is less relevant to scheduling.' }],
  qualification: 'Keep the example within its approved scope.',
};

async function fixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'editorial-plan-archive-')));
  const args = { canvasFilePath: path.join(root, 'Synthetic Canvas.json'), jobId: 'synthetic-job', laneKey: 'main',
    contextKey: null, sourceDigest: SOURCE_DIGEST, allowedIds: IDS,
    writerPromptSha256: WRITER_DIGEST, plan: structuredClone(PLAN), planRunId: PLAN_RUN_ID,
    planSessionId: PLAN_SESSION_ID, model: 'claude-opus-synthetic', createdAt: '2026-10-20T12:00:00.000Z' };
  try { await run({ root, args }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function stored(record) {
  const { path: _path, relativePath: _relativePath, reference: _reference, ...payload } = record;
  return payload;
}

async function writeRecord(file, payload) {
  await fs.writeFile(file, typeof payload === 'string' ? payload : JSON.stringify(payload), { mode: 0o600 });
}

export default [
  {
    name: 'editorial plan archive: absence is read-only and canonical canvas parents are required',
    async run() {
      await fixture(async ({ root, args }) => {
        assert.equal(await loadEditorialPlan(args), null);
        assert.deepEqual(await fs.readdir(root), []);
        const alias = path.join(root, 'alias');
        await fs.symlink(root, alias, 'dir');
        const throughAlias = { ...args, canvasFilePath: path.join(alias, 'Canvas.json') };
        await assert.rejects(loadEditorialPlan(throughAlias), /regular directory|symbolic link/u);
        await assert.rejects(saveEditorialPlan(throughAlias), /regular directory|symbolic link/u);
        assert.equal(await fs.stat(path.join(root, '.local-ai')).catch(() => null), null);
      });
    },
  },
  {
    name: 'editorial plan archive: saves a bound validated plan privately with a canonical content hash',
    async run() {
      await fixture(async ({ root, args }) => {
        await fs.chmod(root, 0o755);
        const saved = await saveEditorialPlan(args);
        const key = crypto.createHash('sha256').update(JSON.stringify(['main', null, SOURCE_DIGEST])).digest('hex');
        assert.equal(saved.path, path.join(root, '.local-ai', 'editorial-plans', args.jobId, `${key}.json`));
        assert.equal(saved.relativePath, path.relative(root, saved.path));
        assert.equal(saved.reference, saved.relativePath);
        assert.equal(saved.version, 1);
        assert.equal(saved.schema, EDITORIAL_PLAN_VERSION);
        assert.equal(saved.planSha256, crypto.createHash('sha256').update(JSON.stringify(PLAN)).digest('hex'));
        assert.deepEqual(await loadEditorialPlan({ ...args, allowedIds: new Set(IDS) }), saved);
        assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
        for (const directory of ['.local-ai', '.local-ai/editorial-plans', `.local-ai/editorial-plans/${args.jobId}`]) {
          assert.equal((await fs.stat(path.join(root, directory))).mode & 0o777, 0o700);
        }
        assert.equal((await fs.stat(root)).mode & 0o777, 0o755, 'canvas parent permissions are preserved');
        assert.equal(JSON.parse(await fs.readFile(saved.path, 'utf8')).reference, undefined, 'paths are derived at read time');
      });
    },
  },
  {
    name: 'editorial plan archive: retained plans survive removal of working jobs and revalidate approved IDs',
    async run() {
      await fixture(async ({ root, args }) => {
        const saved = await saveEditorialPlan(args);
        const working = path.join(root, '.local-ai', 'jobs', args.jobId);
        await fs.mkdir(working, { recursive: true });
        await fs.writeFile(path.join(working, 'ephemeral.json'), '{}');
        await fs.rm(path.join(root, '.local-ai', 'jobs'), { recursive: true });
        assert.deepEqual(await loadEditorialPlan(args), saved);
        await assert.rejects(loadEditorialPlan({ ...args, allowedIds: [IDS[0]] }), /approved catalog IDs/u);
      });
    },
  },
  {
    name: 'editorial plan archive: retries are idempotent and differing completed records are never overwritten',
    async run() {
      await fixture(async ({ args }) => {
        const saved = await saveEditorialPlan(args);
        const original = await fs.readFile(saved.path, 'utf8');
        const reordered = { qualification: PLAN.qualification, omissions: PLAN.omissions,
          paragraphs: PLAN.paragraphs, thesis: PLAN.thesis };
        assert.deepEqual(await saveEditorialPlan({ ...args, plan: reordered }), saved);
        for (const changed of [
          { plan: { ...PLAN, thesis: 'A different proposed emphasis.' } },
          { planRunId: '33333333-3333-4333-8333-333333333333' },
          { writerPromptSha256: 'c'.repeat(64) },
        ]) {
          await assert.rejects(saveEditorialPlan({ ...args, ...changed }), /different completed record/u);
          assert.equal(await fs.readFile(saved.path, 'utf8'), original);
        }
      });
    },
  },
  {
    name: 'editorial plan archive: concurrent competing saves publish exactly one immutable record',
    async run() {
      await fixture(async ({ args }) => {
        const alternative = { ...args, plan: { ...PLAN, thesis: 'A competing editorial proposal.' } };
        const results = await Promise.allSettled([saveEditorialPlan(args), saveEditorialPlan(alternative)]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const rejection = results.find(result => result.status === 'rejected');
        assert.match(rejection.reason.message, /different completed record/u);
        const winner = results.find(result => result.status === 'fulfilled').value;
        assert.deepEqual(await loadEditorialPlan(args), winner);
        assert.deepEqual(await fs.readdir(path.dirname(winner.path)), [path.basename(winner.path)]);
      });
    },
  },
  {
    name: 'editorial plan archive: job lane context and source separate plans without ambiguous concatenation',
    async run() {
      await fixture(async ({ args }) => {
        const variants = [args, { ...args, jobId: 'other-job' }, { ...args, laneKey: 'parallel' },
          { ...args, contextKey: 'next-context' }, { ...args, sourceDigest: 'c'.repeat(64) },
          { ...args, laneKey: 'a', contextKey: 'bc' }, { ...args, laneKey: 'ab', contextKey: 'c' }];
        const saved = [];
        for (const variant of variants) saved.push(await saveEditorialPlan(variant));
        assert.equal(new Set(saved.map(record => record.path)).size, variants.length);
        for (const [index, variant] of variants.entries()) assert.deepEqual(await loadEditorialPlan(variant), saved[index]);
      });
    },
  },
  {
    name: 'editorial plan archive: tampered bindings schemas hashes and metadata stop loading and saving',
    async run() {
      await fixture(async ({ args }) => {
        const saved = await saveEditorialPlan(args);
        const original = stored(saved);
        const mutations = [
          { version: 2 }, { schema: 'wrong-schema' }, { jobId: 'other-job' }, { laneKey: 'parallel' },
          { contextKey: 'wrong-context' }, { sourceDigest: 'c'.repeat(64) }, { planSha256: 'd'.repeat(64) },
          { writerPromptSha256: 'bad-hash' }, { planRunId: 'bad-id' }, { planSessionId: 'bad-id' },
          { createdAt: 'yesterday' }, { model: '' }, { extra: 'unexpected' },
          { plan: { ...PLAN, thesis: 'Changed without updating its content hash.' } },
        ];
        for (const mutation of mutations) {
          await writeRecord(saved.path, { ...original, ...mutation });
          await assert.rejects(loadEditorialPlan(args), /editorial plan|Editorial plan/u);
          await assert.rejects(saveEditorialPlan(args), /editorial plan|Editorial plan/u);
          assert.deepEqual(JSON.parse(await fs.readFile(saved.path, 'utf8')), { ...original, ...mutation });
        }
      });
    },
  },
  {
    name: 'editorial plan archive: malformed unsafe and oversized records are visible failures',
    async run() {
      await fixture(async ({ args }) => {
        const saved = await saveEditorialPlan(args);
        for (const malformed of ['{', 'null', '[]', '{"__proto__":{}}']) {
          await writeRecord(saved.path, malformed);
          await assert.rejects(loadEditorialPlan(args), /invalid JSON|record schema/u);
        }
        await fs.truncate(saved.path, 100 * 1024);
        await assert.rejects(loadEditorialPlan(args), /size limit/u);
        await assert.rejects(saveEditorialPlan(args), /size limit/u);
      });
    },
  },
  {
    name: 'editorial plan archive: nonregular and symbolic-link records cannot redirect reads or writes',
    async run() {
      await fixture(async ({ root, args }) => {
        const saved = await saveEditorialPlan(args);
        const outside = path.join(root, 'outside.json');
        const original = await fs.readFile(saved.path, 'utf8');
        await fs.writeFile(outside, original, { mode: 0o600 });
        await fs.unlink(saved.path);
        await fs.symlink(outside, saved.path);
        await assert.rejects(loadEditorialPlan(args), /regular file/u);
        await assert.rejects(saveEditorialPlan(args), /regular file/u);
        assert.equal(await fs.readFile(outside, 'utf8'), original);
        await fs.unlink(saved.path);
        await fs.mkdir(saved.path);
        await assert.rejects(loadEditorialPlan(args), /regular file/u);
        await assert.rejects(saveEditorialPlan(args), /regular file/u);
      });
    },
  },
  {
    name: 'editorial plan archive: symbolic links at every private directory boundary are rejected before outside creation',
    async run() {
      for (const boundary of ['.local-ai', '.local-ai/editorial-plans', '.local-ai/editorial-plans/synthetic-job']) {
        await fixture(async ({ root, args }) => {
          const outside = path.join(root, 'outside');
          await fs.mkdir(outside, { mode: 0o700 });
          const link = path.join(root, boundary);
          await fs.mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
          await fs.symlink(outside, link, 'dir');
          await assert.rejects(loadEditorialPlan(args), /symbolic link/u);
          await assert.rejects(saveEditorialPlan(args), /symbolic link/u);
          assert.deepEqual(await fs.readdir(outside), []);
        });
      }
    },
  },
  {
    name: 'editorial plan archive: loading hardens older app directories and requires private record permissions',
    async run() {
      await fixture(async ({ root, args }) => {
        const directory = path.join(root, '.local-ai', 'editorial-plans', args.jobId);
        await fs.mkdir(directory, { recursive: true, mode: 0o755 });
        assert.equal(await loadEditorialPlan(args), null);
        assert.equal((await fs.stat(path.join(root, '.local-ai'))).mode & 0o777, 0o700);
        const saved = await saveEditorialPlan(args);
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        await fs.chmod(saved.path, 0o644);
        await assert.rejects(loadEditorialPlan(args), /private permissions/u);
        await assert.rejects(saveEditorialPlan(args), /private permissions/u);
        await fs.chmod(saved.path, 0o600);
        await fs.chmod(directory, 0o755);
        assert.deepEqual(await loadEditorialPlan(args), saved);
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        assert.deepEqual(await saveEditorialPlan(args), saved);
        assert.deepEqual(await loadEditorialPlan(args), saved);
      });
    },
  },
  {
    name: 'editorial plan archive: unsafe bindings and invalid proposals cannot create private artifacts',
    async run() {
      await fixture(async ({ root, args }) => {
        for (const changed of [{ jobId: '../escape' }, { laneKey: '' }, { contextKey: undefined },
          { sourceDigest: 'bad' }, { canvasFilePath: 'relative.json' }, { allowedIds: [] }]) {
          await assert.rejects(loadEditorialPlan({ ...args, ...changed }));
          await assert.rejects(saveEditorialPlan({ ...args, ...changed }));
        }
        await assert.rejects(saveEditorialPlan({ ...args, plan: { ...PLAN, paragraphs: [] } }), /paragraph rows/u);
        await assert.rejects(saveEditorialPlan({ ...args, plan: { ...PLAN, extra: 'not a plan field' } }), /exactly/u);
        assert.deepEqual(await fs.readdir(root), []);
      });
    },
  },
];
