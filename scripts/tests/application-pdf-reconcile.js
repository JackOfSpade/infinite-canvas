import {
  __applicationSyncStatePathForTests,
  __reconcileApplicationSyncWorkspaceForTests,
  __resetApplicationSyncWorkspacesForTests,
  __syncApplicationSyncWorkspaceForTests,
  applyDualPdf,
  applicationSyncConfig,
  assert,
  buildResumeDocument,
  embedApplicationSyncConfig,
  fs,
  inspectGeneratedApplicationPdf,
  JSDOM,
  path,
  PDFLib,
  registerApplicationSyncWorkspace,
} from '../test-dependencies.js';
import {
  extractPdfTextBlocks,
  normalizePdfText,
  reconcileApplicationHtmlFromPdf,
  reconcileApplicationHtmlFromPdfBlocks,
} from '../../electron/ipc/applicationPdfReconcile.js';

async function textPdf(lines) {
  const pdf = await PDFLib.PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
  for (const { text, y, x = 56 } of lines) page.drawText(text, { x, y, size: 11, font });
  return pdf.save();
}

function coverWorkspace(body) {
  return `<!doctype html><html><head><meta data-shell="preserve"></head><body><section data-ic-document-panel="cover"><main class="page"><header class="resume-header letter-letterhead"><h1 class="name">Maya Chen</h1><p class="tagline"><span class="subtitle-role">Engineer</span><span class="sep">·</span><span class="credential">B.S.</span></p><p class="contact">maya@example.test <span class="sep">·</span> 555-0100</p></header><div class="letter-meta"><p class="letter-date"><time datetime="2026-08">August 2026</time></p></div><div class="letter-body"><p class="salutation">Dear Hiring Team,</p><p>${body}</p></div><div class="letter-close"><p class="valediction">Sincerely,</p><p class="signature">Maya Chen</p></div></main></section><script data-shell="preserve">trusted()</script></body></html>`;
}

function combinedWorkspace(body) {
  return `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page"><h1 class="name">Maya Chen</h1><p>Resume baseline.</p></main></section><section data-ic-document-panel="cover"><main class="page"><header class="resume-header letter-letterhead"><h1 class="name">Maya Chen</h1><p class="tagline"><span class="subtitle-role">Engineer</span><span class="sep">·</span><span class="credential">B.S.</span></p><p class="contact">maya@example.test <span class="sep">·</span> 555-0100</p></header><div class="letter-meta"><p class="letter-date"><time datetime="2026-08">August 2026</time></p></div><div class="letter-body"><p class="salutation">Dear Hiring Team,</p><p>${body}</p></div><div class="letter-close"><p class="valediction">Sincerely,</p><p class="signature">Maya Chen</p></div></main></section><script id="ic-application-bundle-data" type="application/json">{}</script></body></html>`;
}

function resumeWorkspace(body) {
  return `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page"><h1 class="name">Maya Chen</h1><section class="section"><div class="section-head"><h2>Experience</h2></div><p class="role-summary">${body}</p></section><section class="section"><div class="section-head"><h2>Skills</h2></div><dl class="skills"><dt>Languages</dt><dd>Python<span class="sep">·</span>TypeScript</dd><dt>AI &amp; Data</dt><dd>MCP<span class="sep">·</span>ETL</dd></dl></section></main></section></body></html>`;
}

function formattingSensitiveResumeWorkspace(body) {
  return `<!doctype html>
<html data-shell='preserve'>
<head><meta data-shell='preserve'><script data-shell='preserve'>trusted()</script></head>
<body><!-- trusted outer-shell comment -->
<section data-ic-document-panel='resume'>
<main class='page'>
  <h1 class='name'>Maya Chen</h1>
  <section class='section'>
    <div class='section-head'><h2>Experience</h2></div>
    <p class='role-summary'>${body}</p>
  </section>
  <section class='section'>
    <div class='section-head'><h2>Skills</h2></div>
    <dl class='skills'><dt>Languages</dt><dd>Python<span class='sep'>·</span>TypeScript</dd><dt>AI &amp; Data</dt><dd>MCP<span class='sep'>·</span>ETL</dd></dl>
  </section>
</main>
</section>
<aside data-shell='preserve'>Outside &amp; untouched</aside></body></html>`;
}

function visualResumeLines(body) {
  return [
    { page: 1, x: 56, y: 700, text: 'Maya Chen' },
    { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
    { page: 1, x: 56, y: 640, text: `• ${body}` },
    { page: 1, x: 56, y: 600, text: 'S K I L L S' },
    { page: 1, x: 56, y: 570, text: 'Python · TypeScriptLanguages' },
    { page: 1, x: 56, y: 540, text: 'MCP · ETLAI & Data' },
  ];
}

function resumeBulletsWorkspace(bullets) {
  const items = bullets.map(bullet => `<li>${bullet}</li>`).join('');
  return `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page"><h1 class="name">Maya Chen</h1><section class="section"><div class="section-head"><h2>Experience</h2></div><ul class="highlights">${items}</ul></section></main></section></body></html>`;
}

function resumeBulletWorkspace(firstBullet) {
  return resumeBulletsWorkspace([firstBullet, 'Kept the release process stable.']);
}

function wrappedResumeBulletLines(firstLine, continuationLine) {
  return [
    { page: 1, x: 56, y: 700, text: 'Maya Chen' },
    { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
    { page: 1, x: 56, y: 640, text: `• ${firstLine}` },
    { page: 1, x: 72, y: 625, text: continuationLine },
    { page: 1, x: 56, y: 600, text: '• Kept the release process stable.' },
  ];
}

function wrappedCoverBodyLines(firstLine, continuationLine) {
  return [
    { page: 1, x: 56, y: 700, text: 'Maya Chen' },
    { page: 1, x: 56, y: 680, text: 'Engineer · B.S.' },
    { page: 1, x: 56, y: 660, text: 'maya@example.test · 555-0100' },
    { page: 1, x: 480, y: 620, text: 'August 2026' },
    { page: 1, x: 56, y: 590, text: 'Dear Hiring Team,' },
    { page: 1, x: 56, y: 550, text: firstLine },
    { page: 1, x: 56, y: 535, text: continuationLine },
    { page: 1, x: 56, y: 500, text: 'Sincerely,' },
    { page: 1, x: 56, y: 480, text: 'Maya Chen' },
  ];
}

export default [
  {
    name: 'Application PDF reconcile: wrapped hyphenated words preserve DOM token identity',
    run: () => {
      assert(normalizePdfText('full- scale adoption') === 'full-scale adoption',
        'a visual line wrap after an attached hyphen must not become a PDF-authored text edit');
      assert(normalizePdfText('word - next') === 'word - next',
        'a true spaced dash must not be collapsed into a hyphenated word');
      return { wrappedHyphenNormalized: true, spacedDashPreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: cross-line hyphens preserve compounds, spaced dashes, and suspended forms',
    run: () => {
      const fixtures = [
        {
          label: 'wrapped compound',
          bullet: 'Built reliable full-scale systems.',
          lines: ['Built reliable full-', 'scale systems.'],
        },
        {
          label: 'spaced dash',
          bullet: 'Kept the alpha - beta separator explicit.',
          lines: ['Kept the alpha -', 'beta separator explicit.'],
        },
        {
          label: 'suspended hyphen',
          bullet: 'Supported part- and full-time schedules.',
          lines: ['Supported part-', 'and full-time schedules.'],
        },
      ];
      const failures = [];
      for (const fixture of fixtures) {
        const source = resumeBulletWorkspace(fixture.bullet);
        const result = reconcileApplicationHtmlFromPdfBlocks({
          html: source,
          documentKind: 'resume',
          blocks: wrappedResumeBulletLines(...fixture.lines),
        });
        if (!(result.success && result.status === 'unchanged' && result.changed === false
          && result.exactTextMatch === true && result.html === source)) {
          failures.push(`${fixture.label}: ${JSON.stringify(result)}`);
        }
      }
      assert(failures.length === 0,
        `hyphens split across visual lines must remain exact and byte-identical:\n${failures.join('\n')}`);
      return { cases: fixtures.map(fixture => fixture.label) };
    },
  },
  {
    name: 'Application PDF reconcile: export inspection accepts compound and suspended-hyphen visual wraps',
    run: async () => {
      const source = resumeBulletWorkspace('Built reliable full-scale systems.')
        .replace('<html>', '<html data-print="ink-only">');
      const pdf = await textPdf(wrappedResumeBulletLines('Built reliable full-', 'scale systems.'));
      const inspection = await inspectGeneratedApplicationPdf({ html: source, pdf, documentKind: 'resume' });
      assert(inspection.valid && inspection.textMatches && inspection.variantMatches,
        `save-time PDF inspection must accept a visually wrapped compound, got ${JSON.stringify(inspection)}`);
      const suspendedSource = resumeBulletWorkspace('Supported part- and full-time schedules.')
        .replace('<html>', '<html data-print="ink-only">');
      const suspendedPdf = await textPdf(wrappedResumeBulletLines('Supported part-', 'and full-time schedules.'));
      const suspendedInspection = await inspectGeneratedApplicationPdf({
        html: suspendedSource,
        pdf: suspendedPdf,
        documentKind: 'resume',
      });
      assert(suspendedInspection.valid && suspendedInspection.textMatches && suspendedInspection.variantMatches,
        `save-time PDF inspection must preserve a visually wrapped suspended hyphen, got ${JSON.stringify(suspendedInspection)}`);
      return { valid: inspection.valid, compoundMatches: inspection.textMatches, suspendedMatches: suspendedInspection.textMatches };
    },
  },
  {
    name: 'Application PDF reconcile: a wrapped compound cannot conceal an adjacent deletion',
    run: () => {
      const source = resumeBulletWorkspace('Built full-scale reliable systems.');
      const deleted = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'resume',
        blocks: wrappedResumeBulletLines('Built full-', 'scale systems.'),
      });
      const rejectedSafely = !deleted.success && deleted.status === 'conflict' && deleted.html === source;
      const importedSafely = deleted.success && deleted.status === 'updated'
        && deleted.html.includes('Built full-scale systems.')
        && !deleted.html.includes('full- scale')
        && !deleted.html.includes('full-scalesystems');
      assert(rejectedSafely || importedSafely,
        `a visual split must never turn a deletion into malformed same-count substitutions, got ${JSON.stringify(deleted)}`);

      const edited = reconcileApplicationHtmlFromPdfBlocks({
        html: resumeBulletWorkspace('Built reliable full-scale systems.'),
        documentKind: 'resume',
        blocks: wrappedResumeBulletLines('Shipped reliable full-', 'scale systems.'),
      });
      assert(edited.success && edited.status === 'updated' && edited.changed
        && edited.html.includes('Shipped reliable full-scale systems.')
        && !edited.html.includes('full- scale'),
      `a one-for-one edit elsewhere must retain the known wrapped compound, got ${JSON.stringify(edited)}`);
      return { deletionHandledSafely: true, adjacentEditPreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: mixed wrapped compound and suspended hyphen remain byte-identical',
    run: () => {
      const source = resumeBulletsWorkspace([
        'Built reliable full-scale systems.',
        'Supported part- and full-time schedules.',
        'Kept the release process stable.',
      ]);
      const blocks = [
        { page: 1, x: 56, y: 700, text: 'Maya Chen' },
        { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
        { page: 1, x: 56, y: 640, text: '• Built reliable full-' },
        { page: 1, x: 72, y: 625, text: 'scale systems.' },
        { page: 1, x: 56, y: 600, text: '• Supported part-' },
        { page: 1, x: 72, y: 585, text: 'and full-time schedules.' },
        { page: 1, x: 56, y: 560, text: '• Kept the release process stable.' },
      ];
      const result = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(result.success && result.status === 'unchanged' && result.changed === false
        && result.exactTextMatch === true && result.html === source,
      `mixed line-ending hyphens must not cancel into a false edit, got ${JSON.stringify(result)}`);
      return { mixedBoundaries: true, htmlByteIdentical: result.html === source };
    },
  },
  {
    name: 'Application PDF reconcile: shifted suspended-hyphen insertions conflict instead of guessing',
    run: () => {
      const source = resumeBulletWorkspace('Supported part- and full-time schedules.');
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'resume',
        blocks: wrappedResumeBulletLines('Supported flexible part-', 'and full-time schedules.'),
      });
      assert(!result.success && result.status === 'conflict' && result.html === source
        && !result.html.includes('part-and'),
      `a token shift before an ambiguous boundary must preserve the source and conflict, got ${JSON.stringify(result)}`);
      return { conflict: true, sourcePreserved: result.html === source };
    },
  },
  {
    name: 'Application PDF reconcile: one leaf with suspended and lexical twins cannot cross-resolve',
    run: () => {
      const bullet = 'Compared full- scale options and built reliable full-scale systems.';
      const source = resumeBulletWorkspace(bullet);
      const blocks = [
        { page: 1, x: 56, y: 700, text: 'Maya Chen' },
        { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
        { page: 1, x: 56, y: 640, text: '• Compared full-' },
        { page: 1, x: 72, y: 625, text: 'scale options and built highly reliable full-' },
        { page: 1, x: 72, y: 610, text: 'scale systems.' },
        { page: 1, x: 56, y: 580, text: '• Kept the release process stable.' },
      ];
      const result = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(!result.success && result.status === 'conflict' && result.html === source
        && result.html.includes('reliable full-scale systems.')
        && !result.html.includes('reliable full- scale systems.'),
      `an unrelated suspended pair must not resolve a shifted lexical compound, got ${JSON.stringify(result)}`);
      return { conflict: true, lexicalCompoundPreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: lexical suspended-hyphen edits preserve spacing in resume and cover',
    run: () => {
      const resumeSource = resumeBulletWorkspace('Supported part- and full-time schedules.');
      const resumeResult = reconcileApplicationHtmlFromPdfBlocks({
        html: resumeSource,
        documentKind: 'resume',
        blocks: wrappedResumeBulletLines('Supported part-', 'or full-time schedules.'),
      });
      assert(resumeResult.success && resumeResult.status === 'updated'
        && resumeResult.html.includes('Supported part- or full-time schedules.')
        && !resumeResult.html.includes('part-or'),
      `a one-for-one résumé edit must retain the trusted suspended form, got ${JSON.stringify(resumeResult)}`);

      const coverSource = coverWorkspace('Maya supports part- and full-time schedules.');
      const coverResult = reconcileApplicationHtmlFromPdfBlocks({
        html: coverSource,
        documentKind: 'cover',
        blocks: wrappedCoverBodyLines('Maya supports part-', 'or full-time schedules.'),
      });
      assert(coverResult.success && coverResult.status === 'updated'
        && coverResult.html.includes('Maya supports part- or full-time schedules.')
        && !coverResult.html.includes('part-or'),
      `a one-for-one cover edit must retain the trusted suspended form, got ${JSON.stringify(coverResult)}`);
      return { resumeUpdated: true, coverUpdated: true, suspendedHyphenPreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: cover line wraps preserve known compounds during lexical edits',
    run: () => {
      const source = coverWorkspace('Maya builds reliable full-scale systems.');
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'cover',
        blocks: wrappedCoverBodyLines('Maya ships reliable full-', 'scale systems.'),
      });
      assert(result.success && result.status === 'updated'
        && result.html.includes('Maya ships reliable full-scale systems.')
        && !result.html.includes('full- scale'),
      `a cover edit elsewhere must preserve a known wrapped compound, got ${JSON.stringify(result)}`);
      return { coverUpdated: true, compoundPreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: Electron main keeps pdf.js as a native runtime import',
    run: () => {
      const source = fs.readFileSync(new URL('../../electron/ipc/applicationPdfReconcile.js', import.meta.url), 'utf8');
      assert(source.includes("const PDFJS_LEGACY_MODULE = 'pdfjs-dist/legacy/build/pdf.mjs'")
        && source.includes('import(/* @vite-ignore */ PDFJS_LEGACY_MODULE)')
        && !source.includes("from 'pdfjs-dist/legacy/build/pdf.mjs'"),
      'the Electron-main reconciler must defer pdf.js to Node at runtime instead of bundling its browser worker implementation');
      return { nativeRuntimeImport: true };
    },
  },
  {
    name: 'Application Sync: malformed capability tokens are forbidden without a timing-safe comparison error',
    run: async () => {
      const malformedTokens = ['short', 'a'.repeat(65), 'g'.repeat(64)];
      const operations = [
        __reconcileApplicationSyncWorkspaceForTests,
        __syncApplicationSyncWorkspaceForTests,
      ];
      for (const token of malformedTokens) {
        for (const operation of operations) {
          let statusCode = null;
          let message = '';
          try {
            await operation({ token });
          } catch (error) {
            statusCode = error?.statusCode;
            message = String(error?.message || '');
          }
          assert(statusCode === 403 && /not registered with Infinite Canvas/i.test(message),
            `malformed ${token.length}-character capability token must return 403, got ${statusCode}: ${message}`);
        }
      }
      return { malformedTokens: malformedTokens.length, operations: operations.length };
    },
  },
  {
    name: 'Application PDF reconcile: generated HTML checks sibling PDFs when opened',
    run: async () => {
      let source = buildResumeDocument({
        docId: 'open-reconcile-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p>Resume baseline.</p></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Cover baseline.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya Chen' },
      });
      source = embedApplicationSyncConfig(source, {
        endpoint: 'http://127.0.0.1:43192/application-sync', token: '8'.repeat(64), version: 2,
      });
      const calls = [];
      const dom = new JSDOM(source, {
        runScripts: 'dangerously', url: 'file:///tmp/Acme/Application.html',
        beforeParse(window) {
          window.fetch = async (endpoint, options) => {
            calls.push({ endpoint, payload: JSON.parse(options.body) });
            return { ok: true, json: async () => ({ success: true, importedDocuments: [], staleDocuments: [], conflicts: [] }) };
          };
        },
      });
      try {
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        assert(calls.length === 1 && calls[0].endpoint === 'http://127.0.0.1:43192/application-sync'
          && calls[0].payload.action === 'reconcile' && calls[0].payload.token === '8'.repeat(64),
        `opening saved HTML must request capability-scoped PDF reconciliation, got ${JSON.stringify(calls)}`);
        return { openCheck: calls[0].payload.action };
      } finally {
        dom.window.close();
      }
    },
  },
  {
    name: 'Application PDF reconcile: open-time stale and bridge failures are visible instead of silent',
    run: async () => {
      const build = (fetchImpl, docId) => {
        let source = buildResumeDocument({
          docId,
          resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p>Resume baseline.</p></main>',
          coverLetter: { name: 'Maya Chen', paragraphs: ['Cover baseline.'] },
          downloadBundle: { company: 'Acme', candidateName: 'Maya Chen' },
        });
        source = embedApplicationSyncConfig(source, {
          endpoint: 'http://127.0.0.1:43192/application-sync', token: '6'.repeat(64), version: 2,
        });
        return new JSDOM(source, {
          runScripts: 'dangerously', url: `file:///tmp/Acme/${docId}.html`,
          beforeParse(window) { window.fetch = fetchImpl; },
        });
      };
      const staleDom = build(async () => ({
        ok: true,
        json: async () => ({ success: true, importedDocuments: [], staleDocuments: ['resume'], conflicts: [] }),
      }), 'open-stale-visible');
      const failedDom = build(async () => { throw new TypeError('Failed to fetch'); }, 'open-bridge-visible');
      try {
        await new Promise(resolve => staleDom.window.setTimeout(resolve, 0));
        await new Promise(resolve => failedDom.window.setTimeout(resolve, 0));
        const staleNote = staleDom.window.document.getElementById('ic-pdf-bundle-note')?.textContent || '';
        const failedNote = failedDom.window.document.getElementById('ic-pdf-bundle-note')?.textContent || '';
        assert(/changed since its PDF was written/i.test(staleNote),
          `a stale response must update the active document notice immediately, got ${JSON.stringify(staleNote)}`);
        assert(/could not reach Infinite Canvas/i.test(failedNote),
          `a loopback bridge failure must be visible instead of swallowed, got ${JSON.stringify(failedNote)}`);
        return { staleVisible: true, bridgeFailureVisible: true };
      } finally {
        staleDom.window.close();
        failedDom.window.close();
      }
    },
  },
  {
    name: 'Application PDF reconcile: verified PDF revision wins over a same-generation browser-only cover draft',
    run: async () => {
      const docId = 'cover-pdf-authoritative-open';
      let source = buildResumeDocument({
        docId,
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p>Resume baseline.</p></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Cover PDF baseline.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya Chen' },
      });
      source = embedApplicationSyncConfig(source, {
        endpoint: 'http://127.0.0.1:43192/application-sync', token: '7'.repeat(64), version: 2,
      });
      const fingerprint = /var COVER_MARKUP_FINGERPRINT = "([^"]+)"/.exec(source)?.[1] || '';
      const sourceDom = new JSDOM(source);
      const baselineMarkup = sourceDom.window.document.querySelector('[data-ic-document-panel="cover"] main')?.innerHTML || '';
      sourceDom.window.close();
      const staleMarkup = baselineMarkup.replace('Cover PDF baseline.', 'Browser-only stale cover draft.');
      const storageKey = `ic-edit:${docId}:cover`;
      const dom = new JSDOM(source, {
        runScripts: 'dangerously', url: 'https://application-cover-authority.local/',
        beforeParse(window) {
          window.localStorage.setItem(storageKey, staleMarkup);
          window.localStorage.setItem(`${storageKey}:fingerprint`, fingerprint);
          window.fetch = async () => ({
            ok: true,
            json: async () => ({
              success: true,
              importedDocuments: [],
              staleDocuments: [],
              conflicts: [],
              variantMismatches: [],
            }),
          });
        },
      });
      try {
        assert(dom.window.document.querySelector('[data-ic-document-panel="cover"] main')?.textContent.includes('Browser-only stale cover draft.'),
          'the fixture must reproduce the stale localStorage cover that masks the saved PDF revision');
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        assert(dom.window.localStorage.getItem(storageKey) === null
          && dom.window.localStorage.getItem(`${storageKey}:fingerprint`) === null,
        'a verified current PDF/HTML pair must clear the active browser-only cover draft before reload');
        assert(dom.window.localStorage.getItem(`${storageKey}:superseded`) === staleMarkup,
          'the displaced browser-only cover draft must remain recoverable in the superseded slot');
        return { pdfRevisionAuthoritative: true, draftPreserved: true };
      } finally {
        dom.window.close();
      }
    },
  },
  {
    name: 'Application PDF reconcile: ordered geometry and cover update preserve the trusted shell',
    run: async () => {
      const pdfBytes = await textPdf([
        { text: 'Maya Chen', y: 700 },
        { text: 'Engineer · B.S.', y: 680 },
        { text: 'maya@example.test · 555-0100', y: 660 },
        { text: 'August 2026', y: 620, x: 480 },
        { text: 'Dear Hiring Team,', y: 590 },
        { text: 'Maya ships reliable systems.', y: 550 },
        { text: 'Sincerely,', y: 510 },
        { text: 'Maya Chen', y: 490 },
      ]);
      const blocks = await extractPdfTextBlocks(pdfBytes);
      assert(blocks.length === 8 && blocks[0].y > blocks[1].y && blocks[3].x > blocks[2].x,
        `PDF blocks must retain reading order and geometry, got ${JSON.stringify(blocks)}`);
      const source = coverWorkspace('Maya builds reliable systems.');
      const result = await reconcileApplicationHtmlFromPdf({ html: source, pdfBytes, documentKind: 'cover' });
      assert(result.success && result.changed && result.status === 'updated' && result.html.includes('Maya ships reliable systems.'),
        `cover PDF update should reconcile its body text, got ${JSON.stringify(result)}`);
      assert(result.html.replace('Maya ships reliable systems.', 'Maya builds reliable systems.') === source,
        'only the selected cover main may change; the trusted outer shell must remain byte-for-byte intact');
      return { blocks: blocks.length, changed: result.changed };
    },
  },
  {
    name: 'Application PDF reconcile: export validation rejects a cream-layer PDF beside ink-only HTML',
    run: async () => {
      const inkOnlyHtml = coverWorkspace('Maya builds reliable systems.')
        .replace('<html>', '<html data-print="ink-only">');
      const rawPdf = await textPdf([
        { text: 'Maya Chen', y: 700 }, { text: 'Engineer · B.S.', y: 680 },
        { text: 'maya@example.test · 555-0100', y: 660 }, { text: 'August 2026', y: 620, x: 480 },
        { text: 'Dear Hiring Team,', y: 590 }, { text: 'Maya builds reliable systems.', y: 550 },
        { text: 'Sincerely,', y: 510 }, { text: 'Maya Chen', y: 490 },
      ]);
      const valid = await inspectGeneratedApplicationPdf({ html: inkOnlyHtml, pdf: rawPdf, documentKind: 'cover' });
      const creamPdf = await applyDualPdf(rawPdf);
      const invalid = await inspectGeneratedApplicationPdf({ html: inkOnlyHtml, pdf: creamPdf, documentKind: 'cover' });
      assert(valid.valid && valid.textMatches && valid.variantMatches,
        `matching flat-white source pair should pass export validation, got ${JSON.stringify(valid)}`);
      assert(!invalid.valid && invalid.textMatches && !invalid.variantMatches
        && invalid.expectedVariant === 'ink-only' && invalid.actualVariant === 'dual-pdf',
      `a text-identical cream PDF must not be blessed beside ink-only HTML, got ${JSON.stringify(invalid)}`);
      return { valid: valid.valid, rejectedVariant: invalid.actualVariant };
    },
  },
  {
    name: 'Application PDF reconcile: résumé insertion returns a conflict without mutating HTML',
    run: async () => {
      const source = '<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page"><h1 class="name">Maya Chen</h1><p class="role-summary">Maya builds systems safely.</p></main></section></body></html>';
      const replacement = await textPdf([{ text: 'Maya builds durable systems safely.', y: 700 }]);
      const result = await reconcileApplicationHtmlFromPdf({ html: source, pdfBytes: replacement, documentKind: 'resume' });
      assert(!result.success && result.status === 'conflict' && result.html === source && /inserted or removed/i.test(result.error || ''),
        `insertions must refuse automatic résumé alignment, got ${JSON.stringify(result)}`);
      return { conflict: result.error };
    },
  },
  {
    name: 'Application PDF reconcile: printed résumé headings, bullets, and reversed skills normalize before conservative import',
    run: () => {
      const source = resumeWorkspace('Maya builds systems safely.');
      const unchanged = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: visualResumeLines('Maya builds systems safely.') });
      assert(unchanged.success && unchanged.status === 'unchanged' && !unchanged.changed,
        `generated PDF-only presentation text must normalize to an unchanged résumé, got ${JSON.stringify(unchanged)}`);
      const changed = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: visualResumeLines('Maya ships systems safely.') });
      assert(changed.success && changed.status === 'updated' && changed.changed && changed.html.includes('Maya ships systems safely.'),
        `one semantic token change should retain conservative importability, got ${JSON.stringify(changed)}`);
      return { headingsCollapsed: true, skillsReordered: true, changed: changed.changed };
    },
  },
  {
    name: 'Application PDF reconcile: source offsets preserve a differently serialized trusted shell',
    run: () => {
      const source = formattingSensitiveResumeWorkspace('Maya builds systems safely.');
      const sourceDom = new JSDOM(source, { includeNodeLocations: true });
      let sourceMain;
      let mainLocation;
      try {
        const main = sourceDom.window.document.querySelector('[data-ic-document-panel="resume"] main.page');
        mainLocation = sourceDom.nodeLocation(main);
        sourceMain = source.slice(mainLocation.startOffset, mainLocation.endOffset);
        assert(sourceMain !== main.outerHTML,
          'fixture must use source formatting that JSDOM does not reproduce via outerHTML');
      } finally {
        sourceDom.window.close();
      }
      const unchanged = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'resume',
        blocks: visualResumeLines('Maya builds systems safely.'),
      });
      assert(unchanged.success && unchanged.status === 'unchanged' && unchanged.html === source,
        `a formatting-sensitive but text-identical PDF must preserve the entire source, got ${JSON.stringify(unchanged)}`);
      const changed = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'resume',
        blocks: visualResumeLines('Maya ships systems safely.'),
      });
      assert(changed.success && changed.status === 'updated' && changed.html.includes('Maya ships systems safely.'),
        `a formatting-sensitive selected main must still reconcile, got ${JSON.stringify(changed)}`);
      assert(changed.html.slice(0, mainLocation.startOffset) === source.slice(0, mainLocation.startOffset)
        && changed.html.endsWith(source.slice(mainLocation.endOffset)),
      'only the selected main source slice may change; trusted shell bytes must remain intact');
      return { sourceOffsets: true, shellPreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: a geometry-bound plain-text bullet accepts a longer replacement without adding bullets',
    run: () => {
      const source = resumeBulletWorkspace('Built reliable systems.');
      const blocks = [
        { page: 1, x: 56, y: 700, text: 'Maya Chen' },
        { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
        { page: 1, x: 56, y: 640, text: '• Built reliable and observable production systems.' },
        { page: 1, x: 56, y: 620, text: '• Kept the release process stable.' },
      ];
      const result = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(result.success && result.status === 'updated' && result.changed
        && result.html.includes('Built reliable and observable production systems.'),
      `a longer edit inside one geometry-mapped list item should import safely, got ${JSON.stringify(result)}`);
      return { mappedLeaves: result.mappedLeaves };
    },
  },
  {
    name: 'Application PDF reconcile: registered workspace imports a one-sided PDF edit and advances both hashes',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp('/tmp/infinite-canvas-pdf-reconcile-'));
      const stateFile = __applicationSyncStatePathForTests();
      const token = '9'.repeat(64);
      const applicationPath = path.join(root, 'Application.html');
      const resumePath = path.join(root, 'Resume.pdf');
      const coverPath = path.join(root, 'Cover Letter.pdf');
      const resumePdf = await textPdf([{ text: 'Maya Chen Resume baseline.', y: 700 }]);
      const coverPdf = await textPdf([
        { text: 'Maya Chen', y: 700 }, { text: 'Engineer · B.S.', y: 680 },
        { text: 'maya@example.test · 555-0100', y: 660 }, { text: 'August 2026', y: 620, x: 480 },
        { text: 'Dear Hiring Team,', y: 590 }, { text: 'Maya builds reliable systems.', y: 550 },
        { text: 'Sincerely,', y: 510 }, { text: 'Maya Chen', y: 490 },
      ]);
      const changedCoverPdf = await textPdf([
        { text: 'Maya Chen', y: 700 }, { text: 'Engineer · B.S.', y: 680 },
        { text: 'maya@example.test · 555-0100', y: 660 }, { text: 'August 2026', y: 620, x: 480 },
        { text: 'Dear Hiring Team,', y: 590 }, { text: 'Maya ships reliable systems.', y: 550 },
        { text: 'Sincerely,', y: 510 }, { text: 'Maya Chen', y: 490 },
      ]);
      try {
        await __resetApplicationSyncWorkspacesForTests();
        const source = combinedWorkspace('Maya builds reliable systems.')
          .replace('<html>', '<html data-print="ink-only">')
          .replace('<body>', '<body><!-- Embedded documentation may mention <html data-print="ink-only">. -->');
        const config = applicationSyncConfig(token, { html: source, resumePdf, coverPdf });
        const saved = embedApplicationSyncConfig(source, config);
        await Promise.all([
          fs.promises.writeFile(applicationPath, saved),
          fs.promises.writeFile(resumePath, resumePdf),
          fs.promises.writeFile(coverPath, changedCoverPdf),
        ]);
        await registerApplicationSyncWorkspace(root, token);
        const result = await __reconcileApplicationSyncWorkspaceForTests({ token, action: 'reconcile' });
        const updated = await fs.promises.readFile(applicationPath, 'utf8');
        const bundle = JSON.parse(/<script id="ic-application-bundle-data" type="application\/json">([\s\S]*?)<\/script>/.exec(updated)?.[1] || '{}');
        assert(result.importedDocuments.length === 1 && result.importedDocuments[0] === 'cover'
          && updated.includes('Maya ships reliable systems.'),
        `one-sided cover PDF edit must be imported, got ${JSON.stringify(result)}`);
        assert(bundle.sync.version === 2 && /^[a-f0-9]{64}$/.test(bundle.sync.documents.cover.pdfSha256)
          && bundle.sync.documents.cover.pdfSha256 !== config.documents.cover.pdfSha256
          && /^[a-f0-9]{64}$/.test(bundle.sync.documents.cover.htmlSha256),
        'successful PDF import must advance the selected PDF and HTML revision hashes');
        return { imported: result.importedDocuments, hashVersion: bundle.sync.version };
      } finally {
        await __resetApplicationSyncWorkspacesForTests();
        await fs.promises.unlink(stateFile).catch(() => {});
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Application PDF reconcile: matching sibling PDFs import their shared paper variant into HTML',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp('/tmp/infinite-canvas-pdf-shared-variant-'));
      const stateFile = __applicationSyncStatePathForTests();
      const token = '5'.repeat(64);
      const applicationPath = path.join(root, 'Application.html');
      const resumePath = path.join(root, 'Resume.pdf');
      const coverPath = path.join(root, 'Cover Letter.pdf');
      const rawResumePdf = await textPdf([{ text: 'Maya Chen Resume baseline.', y: 700 }]);
      const rawCoverPdf = await textPdf([
        { text: 'Maya Chen', y: 700 }, { text: 'Engineer · B.S.', y: 680 },
        { text: 'maya@example.test · 555-0100', y: 660 }, { text: 'August 2026', y: 620, x: 480 },
        { text: 'Dear Hiring Team,', y: 590 }, { text: 'Maya builds reliable systems.', y: 550 },
        { text: 'Sincerely,', y: 510 }, { text: 'Maya Chen', y: 490 },
      ]);
      const resumePdf = await applyDualPdf(rawResumePdf);
      const coverPdf = await applyDualPdf(rawCoverPdf);
      try {
        await __resetApplicationSyncWorkspacesForTests();
        const source = combinedWorkspace('Maya builds reliable systems.')
          .replace('<html>', '<html data-print="ink-only">');
        const config = applicationSyncConfig(token, { html: source, resumePdf, coverPdf });
        const saved = embedApplicationSyncConfig(source, config);
        await Promise.all([
          fs.promises.writeFile(applicationPath, saved),
          fs.promises.writeFile(resumePath, resumePdf),
          fs.promises.writeFile(coverPath, coverPdf),
        ]);
        await registerApplicationSyncWorkspace(root, token);
        const result = await __reconcileApplicationSyncWorkspaceForTests({ token, action: 'reconcile' });
        const updated = await fs.promises.readFile(applicationPath, 'utf8');
        assert(result.importedDocuments.join(',') === 'resume,cover'
          && result.staleDocuments.length === 0
          && result.variantMismatches.length === 0
          && result.reloadRequired
          && /<html\b[^>]*\bdata-print="dual-pdf"/i.test(updated),
        `matching cream PDFs must update the shared HTML preview and request a reload, got ${JSON.stringify(result)}`);
        return { imported: result.importedDocuments, displayVariant: 'dual-pdf' };
      } finally {
        await __resetApplicationSyncWorkspacesForTests();
        await fs.promises.unlink(stateFile).catch(() => {});
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Application PDF reconcile: registered workspace reports a hashed paper-variant mismatch as stale',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp('/tmp/infinite-canvas-pdf-variant-'));
      const stateFile = __applicationSyncStatePathForTests();
      const token = '7'.repeat(64);
      const applicationPath = path.join(root, 'Application.html');
      const resumePath = path.join(root, 'Resume.pdf');
      const coverPath = path.join(root, 'Cover Letter.pdf');
      const resumePdf = await textPdf([{ text: 'Maya Chen Resume baseline.', y: 700 }]);
      const rawCoverPdf = await textPdf([
        { text: 'Maya Chen', y: 700 }, { text: 'Engineer · B.S.', y: 680 },
        { text: 'maya@example.test · 555-0100', y: 660 }, { text: 'August 2026', y: 620, x: 480 },
        { text: 'Dear Hiring Team,', y: 590 }, { text: 'Maya builds reliable systems.', y: 550 },
        { text: 'Sincerely,', y: 510 }, { text: 'Maya Chen', y: 490 },
      ]);
      const creamCoverPdf = await applyDualPdf(rawCoverPdf);
      try {
        await __resetApplicationSyncWorkspacesForTests();
        const source = combinedWorkspace('Maya builds reliable systems.')
          .replace('<html>', '<html data-print="ink-only">');
        const config = applicationSyncConfig(token, { html: source, resumePdf, coverPdf: creamCoverPdf });
        const saved = embedApplicationSyncConfig(source, config);
        await Promise.all([
          fs.promises.writeFile(applicationPath, saved),
          fs.promises.writeFile(resumePath, resumePdf),
          fs.promises.writeFile(coverPath, creamCoverPdf),
        ]);
        await registerApplicationSyncWorkspace(root, token);
        const result = await __reconcileApplicationSyncWorkspaceForTests({ token, action: 'reconcile' });
        assert(result.importedDocuments.length === 0 && result.staleDocuments.includes('cover')
          && result.variantMismatches.length === 1
          && result.variantMismatches[0].expected === 'ink-only'
          && result.variantMismatches[0].actual === 'dual-pdf',
        `a hash-equal but visually incompatible PDF must be surfaced as stale, got ${JSON.stringify(result)}`);
        return { stale: result.staleDocuments, mismatch: result.variantMismatches[0] };
      } finally {
        await __resetApplicationSyncWorkspacesForTests();
        await fs.promises.unlink(stateFile).catch(() => {});
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
];
