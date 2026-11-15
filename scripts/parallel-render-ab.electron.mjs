#!/usr/bin/env node
// Measures the app's hidden-browser page render against Parallel's page reader on the same
// official job-posting URLs, for rows the canvas already knows are closed and rows it has
// confirmed open. Runs in Electron's MAIN process, so the real render code is the one measured:
//   node_modules/.bin/electron scripts/parallel-render-ab.electron.mjs \
//     --canvas <canvas.json> --out <dir> [--closed 20] [--open 20] [--seed 1] [--dry-run]
// A throwaway userData is set before ready, the dock is hidden and no window is created here:
// one URL is rendered at a time by the app's own renderOfficialPostingPage, then the same URL is
// read live by Parallel /v1/extract. results.jsonl, pages/ and summary.json land under --out
// (0700/0600, outside the repo, journaled) and the process always leaves through app.exit.
// Console output is counts only: never page text, full URLs or the API key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { readParallelKey } from '../electron/ipc/parallelSearch.js';
import {
  GROUPS, READERS, appendRecord, buildRecord, errorCodeOf, formatSummary, loadCanvasRows, parseArgs,
  prepareOutDir, readParallelPage, renderRead, scriptArgs, selectRenderRows, startJournal, summarizeRenderAb,
  writePage, writeSummary,
} from './parallel-render-ab.lib.mjs';

// A browser visit the render code times itself; this only stops a wedged call from hanging the run.
const RENDER_TIMEOUT_MS = 180_000;
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-render-ab-userdata-'));

// Before ready, so the user's real app data is never opened.
app.setPath('userData', USER_DATA_DIR);
app.dock?.hide();

let journal = null;
let exiting = false;

/** The one way out: finish the journal, drop the throwaway userData, then app.exit. */
function finalExit(code) {
  if (exiting) return;
  exiting = true;
  try { journal?.finish(code === 0 ? 'finished' : 'failed'); } catch { /* the record cannot hold up the exit */ }
  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch { /* a temp folder may go on its own */ }
  app.exit(code);
}

const fatal = (error) => {
  console.error(`fatal: ${errorCodeOf(error)}`);
  finalExit(1);
};

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

/** One render of one URL, one page at a time, exactly as the app calls it. */
async function renderOne(renderOfficialPostingPage, url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    return renderRead(await renderOfficialPostingPage(url, { signal: controller.signal }), Date.now() - started);
  } catch (error) {
    return renderRead({ ok: false, reason: errorCodeOf(error) }, Date.now() - started);
  } finally {
    clearTimeout(timer);
  }
}

/** One Parallel live read; a thrown request fails this URL only, not the run. */
async function readParallelOne(url, apiKey) {
  const started = Date.now();
  try {
    return await readParallelPage(url, { apiKey });
  } catch (error) {
    return { ok: false, text: '', error: errorCodeOf(error), httpStatus: null, settled: false, notFound: false,
      acquiredAt: '', ms: Date.now() - started };
  }
}

async function measure() {
  const argv = scriptArgs(process.argv);
  const opts = parseArgs(argv);
  const rows = await loadCanvasRows(opts.canvas);
  const selected = selectRenderRows(rows, { closed: opts.closed, open: opts.open, seed: opts.seed });
  const selectedRows = [...selected.closed, ...selected.open];
  console.log(`canvas rows ${rows.length} · closed selected ${selected.closed.length}/${selected.eligible.closed}`
    + ` · open selected ${selected.open.length}/${selected.eligible.open}`);
  if (opts.dryRun) {
    console.log(`dry run: ${selectedRows.length} URLs would be rendered and read; no render and no network call was made`);
    return 0;
  }
  if (!selectedRows.length) {
    console.error('No closed or confirmed-open row has an https posting URL with a title and company; nothing to measure.');
    return 1;
  }
  const apiKey = String(await readParallelKey()).trim();
  if (!apiKey) {
    console.error('No Parallel API key in the Keychain item infinite-canvas-parallel-api-key; nothing was measured.');
    return 1;
  }
  journal = startJournal({ outDir: opts.out, command: argv.join(' '), opts });
  const { pagesDir, resultsPath } = prepareOutDir(opts.out);
  const { renderOfficialPostingPage } = await import('../electron/ipc/officialPostingRenderedPage.js');
  const records = [];
  for (let index = 0; index < selectedRows.length; index += 1) {
    const row = selectedRows[index];
    const rendered = await renderOne(renderOfficialPostingPage, row.url);
    const parallel = await readParallelOne(row.url, apiKey);
    for (const [reader, read] of [['render', rendered], ['parallel', parallel]]) {
      writePage(pagesDir, row.url, reader, read.text);
      const record = buildRecord({ url: row.url, group: row.group, reader, title: row.title, company: row.company, read });
      records.push(record);
      appendRecord(resultsPath, record);
    }
    if (records.length % 10 === 0 || index === selectedRows.length - 1) {
      console.log(`completed ${index + 1}/${selectedRows.length}`);
      journal.update({ facts: { completed: index + 1, total: selectedRows.length } });
    }
  }
  const summary = summarizeRenderAb(records, { groups: GROUPS, readers: READERS });
  const summaryPath = writeSummary(opts.out, summary, { seed: opts.seed, closed: opts.closed, open: opts.open,
    selected: { closed: selected.closed.length, open: selected.open.length } });
  for (const line of formatSummary(summary)) console.log(line);
  console.log(`written: ${summaryPath} (results.jsonl and pages/ beside it)`);
  journal.update({ rows: summary.table.map(cell => ({ arm: `${cell.group}/${cell.reader}`, n: cell.n, valid: cell.usable,
    failed: cell.n - cell.ok, notes: `closedDetected ${cell.closedDetected}; median ${cell.medianChars} chars / ${cell.medianMs} ms` })),
  facts: { selected: selectedRows.length, records: records.length } });
  return 0;
}

app.whenReady()
  .then(measure)
  .then(code => finalExit(code))
  .catch(fatal);
