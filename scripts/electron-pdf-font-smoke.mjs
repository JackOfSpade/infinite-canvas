import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electronPath from 'electron';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Exercise the production renderer with synthetic copy in a disposable profile.
// No provider calls, real application drafts, or live canvas state are touched.
const repo = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(path.join(repo, 'tmp'), { recursive: true });
const root = await fs.mkdtemp(path.join(repo, 'tmp', 'pdf-font-smoke-'));
try {
  const entry = path.join(root, 'main.cjs');
  await build({ stdin: { resolveDir: repo, contents: `
    import { app } from 'electron';
    import fs from 'node:fs/promises';
    import { buildCoverLetterDocument, buildResumeDocument } from './electron/ipc/resumeHtml.js';
    import { renderPdf } from './electron/ipc/resumeRender.js';
    (async () => {
      app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
      app.on('window-all-closed', () => {});
      await app.whenReady();
      try {
        const results = [];
        for (const [id, emoji] of [['plain', ''], ['emoji', '🤫'], ['sequences', '👩🏽‍💻 🇨🇦 1️⃣']]) {
          const paragraph = 'I am applying to Example ' + emoji + ' to build reliable software. My experience includes design, testing and delivery.';
          const letter = { name: 'Sample Candidate', paragraphs: [paragraph] };
          for (const combined of [false, true]) {
            const html = combined ? buildResumeDocument({
              resumeMainHtml: '<main class="page"><header class="resume-header"><h1 class="name">Sample Candidate</h1></header><p>Software engineering and delivery</p></main>',
              coverLetter: letter,
            }) : buildCoverLetterDocument({ letter });
            const options = combined ? { document: 'cover' } : {};
            const rendered = await renderPdf(html, options);
            if (!rendered.fontsLoaded || rendered.pageCount !== 1 || !rendered.layout) throw new Error('Invalid render measurements');
            const file = ${JSON.stringify(root)} + '/' + id + (combined ? '-workspace' : '') + '.pdf';
            await fs.writeFile(file, rendered.bytes);
            results.push({ file, paragraph });
          }
        }
        await fs.writeFile(${JSON.stringify(path.join(root, 'results.json'))}, JSON.stringify(results));
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { app.quit(); }
    })();
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: entry });
  const env = { ...process.env, INFINITE_CANVAS_E2E_BACKGROUND: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [entry], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`PDF smoke Electron exited ${code}: ${output}`));
    });
  });
  const results = JSON.parse(await fs.readFile(path.join(root, 'results.json'), 'utf8'));
  for (const result of results) {
    const task = getDocument({ data: new Uint8Array(await fs.readFile(result.file)), useSystemFonts: true });
    const pdf = await task.promise;
    try {
      assert.equal(pdf.numPages, 1);
      const content = await (await pdf.getPage(1)).getTextContent();
      const text = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ');
      assert(text.includes(result.paragraph.replace(/\s+/g, ' ')), 'PDF text preserves the full prose and emoji sequence');
    } finally { await task.destroy(); }
  }
  console.log(`PASS: ${results.length} production cover renders preserve prose and emoji text, standalone and in Application.html.`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
