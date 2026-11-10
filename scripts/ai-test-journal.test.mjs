// node --test scripts/ai-test-journal.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DURABLE_RUN_ROOT, assertDurableOutDir, createRunJournal, ephemeralReason, renderRunSection, takeEphemeralFlag, tallyRows, upsertRunSection,
} from './ai-test-journal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-test-journal-'));

test('session scratchpads and temp folders are not durable; the default run root is', () => {
  assert.match(ephemeralReason('/private/tmp/claude-501/-Users-x/abc/scratchpad/pick-ladder'), /scratchpad/u);
  assert.match(ephemeralReason('/private/tmp/claude-501/-Users-x/abc/out'), /session temp folder/u);
  assert.match(ephemeralReason(path.join(os.tmpdir(), 'ladder-out')), /temporary folder/u);
  assert.equal(ephemeralReason(path.join(DURABLE_RUN_ROOT, 'pick-2026-11-10')), null);
  assert.equal(ephemeralReason(path.join(HERE, '..', 'tmp', 'claude-e2e', 'runs', 'x')), null);
});

test('assertDurableOutDir refuses an ephemeral --out unless --ephemeral is passed', () => {
  const temp = path.join(os.tmpdir(), 'some-ladder');
  assert.throws(() => assertDurableOutDir(temp), /not durable.*ai-test-runs.*--ephemeral/su);
  assert.equal(assertDurableOutDir(temp, { allowEphemeral: true }), temp);
  const durable = path.join(DURABLE_RUN_ROOT, 'x');
  assert.equal(assertDurableOutDir(durable), durable);
  assert.deepEqual(takeEphemeralFlag(['run', '--ephemeral', '--out', 'x']), [['run', '--out', 'x'], true]);
  assert.deepEqual(takeEphemeralFlag(['run']), [['run'], false]);
});

test('upsertRunSection replaces only its own section and appends new ones', () => {
  const a = renderRunSection({ runId: 'A', tool: 't', task: 'pick', label: 'opus:low', startedAt: '2026-11-10T01:00:00.000Z', updatedAt: '2026-11-10T01:00:00.000Z', status: 'running', rows: [], notes: [] });
  const b = renderRunSection({ runId: 'B', tool: 't', task: 'convert', label: '', startedAt: '2026-11-10T02:00:00.000Z', updatedAt: '2026-11-10T02:00:00.000Z', status: 'running', rows: [], notes: [] });
  let doc = upsertRunSection('', 'A', a);
  doc = upsertRunSection(doc, 'B', b);
  assert.match(doc, /^# AI test run log/u);
  const a2 = a.replace('**running**', '**finished**');
  doc = upsertRunSection(doc, 'A', a2);
  assert.equal(doc.match(/ai-test-run:A -->/gu).length, 2, 'section A appears once (open and close markers)');
  assert.ok(doc.indexOf('ai-test-run:A') < doc.indexOf('ai-test-run:B'), 'sections keep their order');
  assert.match(doc, /ai-test-run:A -->[\s\S]*\*\*finished\*\*[\s\S]*\/ai-test-run:A/u);
  assert.match(doc, /ai-test-run:B -->[\s\S]*\*\*running\*\*[\s\S]*\/ai-test-run:B/u);
});

test('a journal records the run at start, throttles updates, forces milestones and closes on finish', () => {
  const dir = scratch();
  const docPath = path.join(dir, 'runs.md');
  const outDir = path.join(dir, 'out');
  let clock = Date.parse('2026-11-10T03:00:00.000Z');
  const journal = createRunJournal({ tool: 'claude-effort-ladder run', task: 'pick', label: 'opus:low', outDir, docPath, minIntervalMs: 60_000, now: () => clock, handleSignals: false });
  let doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /\*\*running\*\*/u);
  assert.match(doc, /No results yet/u);

  journal.update({ rows: [{ arm: 'pick opus:low', n: 1, valid: 1, failed: 0, costUsd: 0.2 }] });
  doc = fs.readFileSync(docPath, 'utf8');
  assert.doesNotMatch(doc, /pick opus:low \| 1/u, 'an update inside the interval only rewrites journal.json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'journal.json'), 'utf8')).rows[0].n, 1);

  clock += 61_000;
  journal.update({ rows: [{ arm: 'pick opus:low', n: 2, valid: 2, failed: 0, costUsd: 0.4 }] });
  assert.match(fs.readFileSync(docPath, 'utf8'), /\| pick opus:low \| 2 \| 2 \| 0 \| \$0\.400 \|/u);

  journal.update({ rows: [{ arm: 'pick opus:low', n: 3, valid: 2, failed: 1, costUsd: 0.6, notes: 'top-1 2/3' }] }, { force: true });
  assert.match(fs.readFileSync(docPath, 'utf8'), /\| pick opus:low \| 3 \| 2 \| 1 \| \$0\.600 \| top-1 2\/3 \|/u);

  journal.finish('finished');
  journal.update({ rows: [], status: 'running' }, { force: true });
  doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /\*\*finished\*\*/u, 'a late heartbeat does not reopen a finished run');
  assert.match(doc, /\| pick opus:low \| 3 \|/u);
});

test('a run killed with SIGTERM is marked interrupted with the rows it had', () => {
  const dir = scratch();
  const docPath = path.join(dir, 'runs.md');
  const moduleUrl = new URL('./ai-test-journal.mjs', import.meta.url).href;
  const child = `
    const { createRunJournal } = await import(${JSON.stringify(moduleUrl)});
    const j = createRunJournal({ tool: 'probe', task: 'convert', outDir: ${JSON.stringify(path.join(dir, 'out'))}, docPath: ${JSON.stringify(docPath)} });
    j.update({ rows: [{ arm: 'convert haiku:medium', n: 4, valid: 1, costUsd: 0.09 }] }, { force: true });
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => {}, 5000);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 143);
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /\*\*interrupted \(SIGTERM\)/u);
  assert.match(doc, /\| convert haiku:medium \| 4 \| 1 \|/u);
});

test('tallyRows groups by arm with validity, failures and cost', () => {
  const rows = [
    { config: 'a', valid: true, ok: true, costUsd: 0.1 },
    { config: 'a', valid: false, ok: false, costUsd: 0.2 },
    { config: 'b', valid: true, ok: true, costUsd: null },
  ];
  assert.deepEqual(tallyRows(rows, row => row.config), [
    { arm: 'a', n: 2, valid: 1, failed: 1, costUsd: 0.30000000000000004 },
    { arm: 'b', n: 1, valid: 1, failed: 0, costUsd: 0 },
  ]);
});

test('record writes a finished section for a hand-made result', async () => {
  const { recordResult, parseRecordRow } = await import('./ai-test-journal.mjs');
  assert.deepEqual(parseRecordRow('requirements haiku:medium|11|9||$0.24|judge preferred production on 2'),
    { arm: 'requirements haiku:medium', n: 11, valid: 9, failed: undefined, costUsd: 0.24, notes: 'judge preferred production on 2' });
  assert.throws(() => parseRecordRow('x|lots'), /n must be a number/u);
  const dir = scratch();
  const docPath = path.join(dir, 'runs.md');
  const runId = recordResult([
    '--tool', 'blind judge', '--task', 'requirements', '--label', 'haiku:medium vs production',
    '--row', 'haiku:medium|11|9|0|0.24|wins 4, ties 5, losses 2', '--fact', 'Judge=GPT via Offload', '--note', 'noise floor: production A vs B',
  ], { docPath });
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, new RegExp(`ai-test-run:${runId} -->`, 'u'));
  assert.match(doc, /blind judge · requirements · haiku:medium vs production/u);
  assert.match(doc, /\*\*finished\*\*/u);
  assert.match(doc, /\| haiku:medium \| 11 \| 9 \| 0 \| \$0\.240 \| wins 4, ties 5, losses 2 \|/u);
  assert.match(doc, /- Judge: GPT via Offload/u);
  assert.match(doc, /- Note: noise floor: production A vs B/u);
  assert.throws(() => recordResult(['--tool', 'x', '--row', 'a|1', '--out', path.join(os.tmpdir(), 'judge')], { docPath }), /not durable/u);
});
