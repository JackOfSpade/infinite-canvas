import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInlineElectronEntry } from './lib/electron-smoke.mjs';
import { applicationRendererSourceDigest } from '../electron/ipc/applicationV2RendererVersion.js';

// Synthetic production-render workload in a separate, disposable Electron profile.
// Does not load electron/main.js, rebuild the app, use providers, or read a live canvas.
const privateRoot = path.join(os.homedir(), 'Library/Application Support/infinite-canvas');
const live = await fs.readFile(path.join(privateRoot, 'non-api-ai-handoffs.json'), 'utf8').then(JSON.parse, error => {
  if (error?.code === 'ENOENT') return {};
  throw error;
});
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert(!Object.keys(live.runs || {}).some(key => key.startsWith('official-posting:')), 'Wait for the live official-posting refresh before this isolated benchmark.');
await fs.mkdir(path.join(repoRoot, 'tmp'), { recursive: true });
const root = await fs.mkdtemp(path.join(repoRoot, 'tmp/application-render-cache-'));
try {
  const output = path.join(root, 'result.json');
  const entry = `
    import { app } from 'electron';
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { performance } from 'node:perf_hooks';
    (async () => {
      app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
      app.on('window-all-closed', () => {});
      await app.whenReady();
      app.dock?.hide();
      const { __writeVerifyRenderPhaseForTests: renderPhase, __resetApplicationV2RenderCacheForTests: clear,
        __applicationV2RenderCacheStatsForTests: stats } = await import('./electron/ipc/localAiApplication.js');
      const { applicationV2PagePng } = await import('./electron/ipc/applicationV2PageImages.js');
      const pairs = Array.from({ length: 5 }, (_, i) => ({
        html: '<main class="page"><header class="resume-header"><h1 class="name">Synthetic Candidate ' + i + '</h1><p class="tagline">Software Engineer</p></header><section class="section"><div class="section-head"><h2>Experience</h2></div><article class="role"><div class="role-header"><p class="role-title-line">Engineer at Example Company</p></div><ul class="highlights"><li>Built reliable reporting services and tested releases with the engineering team.</li><li>Improved internal tools so colleagues could complete daily tasks consistently.</li></ul></article></section></main>',
        letter: { name: 'Synthetic Candidate ' + i, contact: [], salutation: 'Dear Hiring Team,',
          paragraphs: ['I am applying to build dependable software for your team.', 'At Example Company I built reporting services and tested releases with colleagues. This work helped internal users complete daily tasks consistently.'], closing: 'Sincerely,' },
        input: { job: { title: 'Engineer', company: 'Example Company' }, sourceRoles: [] },
        renderState: { selectedRoleIds: [] },
      }));
      const verify = phase => {
        assert.equal(phase.kind, 'ok');
        for (const fit of [phase.resumeFit, phase.letterFit]) {
          assert.equal(fit.pageCount, 1); assert.equal(fit.fontsLoaded, true); assert(fit.bytes.length > 0);
        }
      };
      // Warm Chromium/font setup outside both measured paths.
      verify(await renderPhase(pairs[0])); clear();
      const results = [];
      for (const mode of ['baseline', 'cached', 'cached', 'baseline']) {
        clear(); let pdfRenders = 0; let pngConversions = 0; let hits = 0;
        const started = performance.now();
        // A normal bundle accepts each draft, builds pick, then historically rebuilt pick on read.
        // The optimized driver reuses the returned pick handoff, so that last pass is absent.
        for (const stage of mode === 'baseline' ? ['accept', 'pick', 'duplicate-pick'] : ['accept', 'pick']) {
          for (const pair of pairs) {
            if (mode === 'baseline') clear();
            const phase = await renderPhase(pair); verify(phase);
            if (phase.cacheHit) hits += 1;
            else {
              assert.equal(phase.hostRenders, 1); assert.equal(phase.resumeFit.attempts.length, 1);
              pdfRenders += 2;
            }
            if (stage !== 'accept') {
              for (const fit of [phase.resumeFit, phase.letterFit]) {
                const png = await applicationV2PagePng(fit.bytes); assert(png.length > 0); pngConversions += 1;
              }
            }
          }
        }
        const result = { mode, wallMs: Math.round(performance.now() - started), pdfRenders, pngConversions, hits, cache: stats() };
        assert.equal(pdfRenders, mode === 'baseline' ? 30 : 10);
        assert.equal(pngConversions, mode === 'baseline' ? 20 : 10);
        if (mode === 'cached') assert.equal(hits, 5);
        results.push(result); console.log('BENCHMARK', JSON.stringify(result));
      }
      await fs.writeFile(${JSON.stringify(output)}, JSON.stringify(results));
      app.exit(0);
    })().catch(error => { console.error(error); app.exit(1); });
  `;
  await runInlineElectronEntry({
    source: entry, sourcefile: 'application-render-cache-benchmark.mjs', resolveDir: process.cwd(),
    outfile: path.join(root, 'main.cjs'), timeoutMs: 300_000, echo: true, failureLabel: 'Isolated render benchmark',
    define: { __APPLICATION_RENDERER_SOURCE_SHA256__: JSON.stringify(applicationRendererSourceDigest()) },
  });
  const results = JSON.parse(await fs.readFile(output, 'utf8'));
  const mean = mode => results.filter(row => row.mode === mode).reduce((sum, row) => sum + row.wallMs, 0) / 2;
  const baselineMs = mean('baseline'); const cachedMs = mean('cached');
  const summary = { syntheticCandidates: 5, runs: results, baselineMs, cachedMs,
    savedMsPerBundle: baselineMs - cachedMs, savedPercent: (baselineMs - cachedMs) / baselineMs * 100 };
  if (process.argv[2]) await fs.writeFile(path.resolve(process.argv[2]), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
