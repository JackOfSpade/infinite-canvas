// Exercise the production PDF renderer, including the workspace's CSS zoom.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electron from 'electron';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-page-measurement-'));
await fs.mkdir('.test-artifacts', { recursive: true });
const bundleDir = await fs.mkdtemp(path.resolve('.test-artifacts/page-measurement-'));
try {
  const entry = `
    import { app } from 'electron';
    import assert from 'node:assert/strict';
    import { buildResumeDocument } from ${JSON.stringify(path.resolve('electron/ipc/resumeHtml.js'))};
    import { renderPdf } from ${JSON.stringify(path.resolve('electron/ipc/resumeRender.js'))};
    (async () => {
    app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
    app.on('window-all-closed', () => {});
    await app.whenReady();
    app.dock?.hide();
    try {
      const main = '<main class="page"><div class="resume-header"><h1 class="name">Synthetic Candidate</h1><p class="tagline">Software Engineer</p></div><section class="section"><div class="section-head"><h2>Experience</h2></div><article class="role"><div class="role-header"><p class="role-title-line">Engineer · Example Company</p></div><ul class="highlights">' + Array(8).fill('<li>Built reliable software and tested changes with the engineering team to improve service delivery.</li>').join('') + '</ul></article></section></main>';
      for (const attrs of ['', 'data-page="a4" data-density="compact"']) {
        const html = buildResumeDocument({ resumeMainHtml: main, variantAttrs: attrs });
        const scaled = await renderPdf(html);
        const full = await renderPdf(html.replace('</head>', '<style>.ic-page-stage { zoom: 1 !important; }</style></head>'));
        console.log('Measured scaled and full-size layouts', JSON.stringify({ scaled: scaled.layout, full: full.layout }));
        assert.equal(scaled.fontsLoaded, true);
        assert.equal(full.fontsLoaded, true);
        assert.equal(scaled.pageCount, 1);
        assert.equal(full.pageCount, 1);
        assert.equal(scaled.layout.horizontalOverflowCount, 0);
        assert.equal(full.layout.horizontalOverflowCount, 0);
        assert.ok(Math.abs(scaled.layout.contentHeightPx - full.layout.contentHeightPx) < 1);
        assert.ok(Math.abs(scaled.layout.lineHeightPx - full.layout.lineHeightPx) < 1);
        console.log('PASS zoom-independent PDF measurements', attrs || 'Letter default', JSON.stringify(scaled.layout));
      }
      const overflowing = buildResumeDocument({ resumeMainHtml: '<main class="page"><p class="role-dates">' + 'Unbreakable'.repeat(30) + '</p></main>' });
      const bad = await renderPdf(overflowing);
      assert.ok(bad.layout.horizontalOverflowCount > 0);
      assert.ok(bad.layout.maxHorizontalOverflowPx > 2);
      console.log('PASS real horizontal overflow remains detectable');
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    })().catch(error => { console.error(error); app.exit(1); });
  `;
  const outfile = path.join(bundleDir, 'main.cjs');
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'page-measurement-smoke.mjs' }, outfile,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [outfile], { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, IC_BACKGROUND_E2E: '1' } });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error('Page measurement smoke failed: ' + exitCode);
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(bundleDir, { recursive: true, force: true });
}
