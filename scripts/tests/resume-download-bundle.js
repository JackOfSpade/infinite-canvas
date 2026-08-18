import {
  assert,
  __normaliseApplicationSyncWorkspaceForTests,
  __withApplicationSyncWorkspaceLockForTests,
  buildResumeDocument,
  embedApplicationSyncConfig,
  createApplicationBundle,
  createZipBuffer,
  extractVariantAttrs,
  fs,
  formatOriginalJobListingMarkdown,
  inspectApplicationSyncRevision,
  isDualMode,
  JSDOM,
  normaliseResumeDownloadBundle,
  path,
  PDFLib,
  sanitizeApplicationBundlePart,
  zlib,
} from '../test-dependencies.js';

function readZipEntries(input) {
  const bytes = Buffer.from(input);
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const expectedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(compressed)
      : method === 8 ? zlib.inflateRawSync(compressed)
        : (() => { throw new Error(`Unexpected ZIP method ${method}`); })();
    assert(data.length === expectedSize, `${name} uncompressed size must match its ZIP header`);
    entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  assert(entries.size > 0, 'ZIP must contain local file records');
  assert(bytes.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'ZIP must contain an end-of-central-directory record');
  return entries;
}

export default [
  {
    name: 'application bundle: hardened names and pretty source-faithful job Markdown',
    run: () => {
      assert(sanitizeApplicationBundlePart('../CON. ', 'Company') === 'Company', 'traversal/reserved company name must fall back');
      assert(sanitizeApplicationBundlePart('  Café / North  ', 'Company') === 'Café North', 'portable Unicode company name must be retained');
      assert(normaliseResumeDownloadBundle({ company: 'NUL' }).company === 'Company', 'standalone and backend reserved-name policies must agree');

      const scraped = '<script>alert("x")</script>\nBuild `systems` and preserve ``` evidence.';
      const markdown = formatOriginalJobListingMarkdown({
        title: '# Platform Engineer', company: 'A * B', location: 'Toronto, ON',
        salary: '$120k-$140k', posted: '2 days ago', source: 'linkedin', language: 'en',
        url: 'javascript:alert(1)', snippet: scraped,
      });
      assert(markdown.includes('# \\# Platform Engineer'), 'title Markdown syntax must be escaped');
      assert(markdown.includes('**Source:** linkedin') && markdown.includes('**Language:** en'), 'scraper provenance must be printed');
      assert(!markdown.includes('Listing URL'), 'unsafe non-HTTP URL must not become a Markdown link');
      assert(markdown.includes(scraped), 'captured listing text must remain byte-for-byte present');
      assert(markdown.includes('````text'), 'description fence must exceed the longest backtick run in source text');
      return { markdownBytes: Buffer.byteLength(markdown) };
    },
  },
  {
    name: 'application workspace: bounded cover-letter audit persists through Sync configuration injection',
    run: () => {
      const overlong = `unsafe </script>\n${'x'.repeat(900)}`;
      const rawAudit = {
        version: 99,
        rankedNeeds: Array.from({ length: 20 }, () => ({ need: overlong, quote: overlong, source: 'untrusted', decisiveness: 101, kind: overlong })),
        finalPlan: {
          roleThesis: overlong,
          mappings: Array.from({ length: 8 }, () => ({ needIndex: 1001, need: overlong, evidence: overlong, evidenceRole: overlong, achievementIds: Array.from({ length: 20 }, () => overlong), resumeStatus: overlong, inference: overlong })),
          companyHook: { detail: overlong, source: overlong, whyItMattersToCandidate: overlong },
          logistics: overlong,
          droppedNeeds: Array.from({ length: 20 }, () => ({ needIndex: -1, reason: overlong })),
        },
        checks: Array.from({ length: 30 }, () => ({ id: overlong, passed: 'yes', detail: overlong })),
      };
      const normalized = normaliseResumeDownloadBundle({ company: 'Acme', coverLetterAudit: rawAudit });
      const audit = normalized.coverLetterAudit;
      assert(audit.version === 1 && audit.readiness === 'review-required'
        && audit.note.includes('not a persuasive-quality score'),
      'audit normalizer must own version/readiness/note rather than trust raw metadata');
      assert(audit.rankedNeeds.length === 12 && audit.finalPlan.mappings.length === 4
        && audit.finalPlan.droppedNeeds.length === 12 && audit.checks.length === 24,
      'audit arrays must remain bounded before HTML serialization');
      assert(audit.rankedNeeds[0].need.length === 320 && !/[\r\n]/.test(audit.rankedNeeds[0].need)
        && audit.rankedNeeds[0].source === '' && audit.finalPlan.mappings[0].needIndex === null
        && audit.rankedNeeds[0].decisiveness === null && audit.finalPlan.mappings[0].achievementIds.length === 12
        && audit.finalPlan.mappings[0].achievementIds[0].length === 120 && audit.checks[0].passed === false,
      'audit strings and enum/index/boolean fields must be safely normalized');
      const passedAudit = normaliseResumeDownloadBundle({
        coverLetterAudit: {
          rankedNeeds: [{ need: 'Run incident response', quote: 'Run incident response', source: 'posting', decisiveness: 92, kind: 'capability' }],
          finalPlan: { mappings: [{ needIndex: 0, achievementIds: ['receipt-1'] }] },
          checks: [{ id: 'plan-availability', passed: true, detail: 'available' }],
        },
      }).coverLetterAudit;
      assert(passedAudit.readiness === 'checks-passed' && passedAudit.rankedNeeds[0].decisiveness === 92
        && passedAudit.finalPlan.mappings[0].achievementIds[0] === 'receipt-1',
      'valid schema fields must survive normalization and all-passing final checks must be explicit');
      let doc = buildResumeDocument({
        docId: 'cover-audit-persistence',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya</h1></main>',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role', coverLetterAudit: rawAudit },
      });
      const embeddedBeforeSync = /<script id="ic-application-bundle-data" type="application\/json">([\s\S]*?)<\/script>/.exec(doc)?.[1] || '';
      assert(!embeddedBeforeSync.includes('</script>') && embeddedBeforeSync.includes('\\u003c/script\\u003e'),
        'inert audit JSON must escape a script terminator before embedding');
      doc = embedApplicationSyncConfig(doc, { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'd'.repeat(64) });
      const payload = JSON.parse(/<script id="ic-application-bundle-data" type="application\/json">([\s\S]*?)<\/script>/.exec(doc)?.[1] || '{}');
      assert(payload.coverLetterAudit?.version === 1
        && payload.coverLetterAudit?.finalPlan?.roleThesis === audit.finalPlan.roleThesis
        && payload.sync?.token === 'd'.repeat(64),
      'Sync config injection must update only its capability while preserving the bounded inert audit');
      return { needs: audit.rankedNeeds.length, checks: audit.checks.length, syncPreserved: true };
    },
  },
  {
    name: 'application bundle: real ZIP round-trip has one HTML plus byte-exact résumé and cover PDFs',
    run: () => {
      const applicationHtml = '<!doctype html><title>Application</title><main>Résumé</main><main>Cover letter</main>';
      const resumePdf = Buffer.from('%PDF-1.4\nresume-bytes');
      const coverLetterPdf = Buffer.from('%PDF-1.7\ncover-letter-bytes');
      const jobMarkdown = '# Role\n\n```text\nOriginal listing\n```\n';
      const bundle = createApplicationBundle({
        company: 'Café / North', candidateName: 'Zoë', applicationHtml, resumePdf, coverLetterPdf, jobListingMarkdown: jobMarkdown,
        modifiedAt: new Date('2026-08-14T12:00:00Z'),
      });
      assert(bundle.fileName === 'Café North.zip', `unexpected bundle name ${bundle.fileName}`);
      const entries = readZipEntries(bundle.buffer);
      const expected = [
        'Café North/Application.html',
        'Café North/Resume.pdf',
        'Café North/Cover Letter.pdf',
        'Café North/Original Job Listing.md',
      ];
      assert(JSON.stringify([...entries.keys()]) === JSON.stringify(expected), 'ZIP layout must be exact and UTF-8 safe');
      assert([...entries.keys()].filter(name => name.endsWith('.html')).length === 1, 'bundle must contain exactly one HTML workspace');
      assert(entries.get(expected[0]).toString('utf8') === applicationHtml, 'combined application HTML changed in ZIP');
      assert(entries.get(expected[1]).equals(resumePdf), 'résumé PDF bytes changed in ZIP');
      assert(entries.get(expected[2]).equals(coverLetterPdf), 'cover-letter PDF bytes changed in ZIP');
      assert(entries.get(expected[3]).toString('utf8') === jobMarkdown, 'job Markdown changed in ZIP');
      let missingCoverRejected = false;
      try { createApplicationBundle({ company: 'Acme', candidateName: 'Maya', applicationHtml, resumePdf, jobListingMarkdown: jobMarkdown }); } catch { missingCoverRejected = true; }
      assert(missingCoverRejected, 'a ZIP without Cover Letter.pdf must be rejected instead of silently creating a three-file bundle');
      let unsafeRejected = false;
      try { createZipBuffer([{ name: '../escape.txt', data: 'nope' }]); } catch { unsafeRejected = true; }
      assert(unsafeRejected, 'ZIP traversal entry must be rejected');
      return { entries: entries.size, zipBytes: bundle.buffer.length };
    },
  },
  {
    name: 'application workspace: Sync replaces download and submits only the selected document to its saved bridge',
    run: async () => {
      let doc = buildResumeDocument({
        docId: 'sync-interaction-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p id="resume-copy">Original résumé</p></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Original cover letter.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya Chen', jobMarkdown: '# Role' },
      });
      doc = embedApplicationSyncConfig(doc, { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'a'.repeat(64) });
      assert(!doc.includes('Download application bundle') && !doc.includes('storedZip'), 'saved workspace must not ship a browser ZIP downloader');
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'file:///tmp/Acme/Application.html' });
      const { document } = dom.window;
      const sync = document.getElementById('ic-sync-btn');
      const calls = [];
      dom.window.fetch = async (endpoint, options) => {
        calls.push({ endpoint, payload: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ success: true }) };
      };
      assert(!sync.disabled && sync.textContent.includes('résumé'), 'a configured saved HTML enables Sync without manually attaching a PDF');
      document.getElementById('ic-cover-tab').click();
      document.getElementById('ic-edit-toggle').click();
      const cover = document.getElementById('ic-cover-panel').querySelector('main');
      cover.querySelector('.letter-body p').textContent = 'Edited cover letter.';
      cover.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      sync.click();
      await new Promise(resolve => dom.window.setTimeout(resolve, 0));
      assert(calls.length === 1 && calls[0].endpoint === 'http://127.0.0.1:43192/application-sync', 'Sync must use the fixed local bridge endpoint');
      assert(calls[0].payload.token === 'a'.repeat(64) && calls[0].payload.document === 'cover', 'Sync must use its capability and selected document only');
      assert(calls[0].payload.html.includes('Edited cover letter.'), 'Sync must send the current editable HTML to Electron for rendering');
      assert(document.getElementById('ic-pdf-bundle-note').textContent.includes('Synced cover letter'), 'success should confirm the replaced sibling document');
      dom.window.close();
      return { selectedDocument: 'cover', capabilityScoped: true };
    },
  },
  {
    name: 'application workspace: review gates résumé Sync but not cover Sync',
    run: () => {
      const doc = buildResumeDocument({
        docId: 'bundle-review-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya</h1><dl class="skills"><dt>Core</dt><dd>Node.js</dd></dl></main>',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        skillInsights: {
          items: [{ id: 'skill-1', kind: 'verify', canonicalSkillName: 'Django', suggestedResumeText: 'Django ORM' }],
        },
        downloadBundle: {
          company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role',
          sync: { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'b'.repeat(64) },
        },
      });
      assert(!doc.includes('id="ic-export-btn"'), 'the removed print/export button must not be present in generated markup');
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-review.local/' });
      const { document } = dom.window;
      assert(!document.getElementById('ic-export-btn'), 'the removed print/export button must not be present in the rendered DOM');
      const sync = document.getElementById('ic-sync-btn');
      assert(sync.disabled, 'unresolved résumé claim must gate résumé Sync');
      document.getElementById('ic-cover-tab').click();
      assert(!sync.disabled, 'cover-letter Sync stays available while résumé review is unresolved');
      document.querySelector('[data-ic-skill-action="not_mine"]').click();
      document.getElementById('ic-resume-tab').click();
      assert(!sync.disabled, 'Not mine allows résumé Sync without a manually attached PDF');
      document.querySelector('[data-ic-skill-action="verified"]').click();
      assert(!sync.disabled, 'adding a verified skill is rendered fresh by Electron during Sync');
      dom.window.close();
      return { coverIndependent: true, renderOnSync: true };
    },
  },
  {
    // The AI-selected variant is intentionally not user-editable, but it must
    // not be invisible: a deliberate ink-only PDF otherwise looks like a
    // broken dual-mode render. The workspace explains both the visible result
    // and the recipient-profile rationale while leaving the canonical root
    // attribute untouched for Sync.
    name: 'application workspace: explains the read-only AI paper decision without changing the OCG gate',
    run: () => {
      const doc = buildResumeDocument({
        docId: 'bundle-variant-test',
        resumeMainHtml: '<main class="page" data-print="ink-only"><h1 class="name">Maya</h1></main>',
        variantAttrs: 'data-print="ink-only"',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        downloadBundle: {
          company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role',
          sync: { endpoint: 'http://127.0.0.1:43192/application-sync', token: 'c'.repeat(64) },
        },
      });
      assert(isDualMode(extractVariantAttrs(doc)) === false, 'an ink-only application must not be re-read as dual');
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-variant.local/' });
      const { document } = dom.window;
      assert(!document.getElementById('ic-print-variant'), 'the manual paper selector must not be present');
      const note = document.getElementById('ic-print-variant-note');
      assert(note && note.textContent.includes('AI paper decision: Flat white PDF'), 'ink-only must be named as the AI-selected flat-white PDF mode');
      assert(note.textContent.includes('white in viewers and print'), 'ink-only must make both resulting PDF states explicit');
      assert(note.textContent.includes('ATS-heavy, enterprise, regulated, or otherwise conservative'), 'ink-only must explain the inferred recipient-profile rationale');
      assert(document.documentElement.getAttribute('data-print') === 'ink-only', 'the read-only explanation must not rewrite the selected root variant');
      assert(isDualMode(extractVariantAttrs('<!doctype html>\n' + document.documentElement.outerHTML)) === false, 'the explained ink-only choice must still gate the OCG cream layer OFF');
      dom.window.close();

      const dualDoc = buildResumeDocument({
        docId: 'bundle-variant-dual-test',
        resumeMainHtml: '<main class="page" data-print="dual-pdf"><h1 class="name">Maya</h1></main>',
        variantAttrs: 'data-print="dual-pdf"',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
      });
      const dualDom = new JSDOM(dualDoc, { runScripts: 'dangerously', url: 'https://application-variant-dual.local/' });
      const dualNote = dualDom.window.document.getElementById('ic-print-variant-note');
      assert(dualNote && dualNote.textContent.includes('Dual-mode PDF — cream in viewers, white in print'), 'dual-pdf must explain its two visible states');
      assert(dualNote.textContent.includes('design-conscious, startup-oriented, or craft-focused'), 'dual-pdf must explain the inferred recipient-profile rationale');
      assert(isDualMode(extractVariantAttrs(dualDoc)) === true, 'the explained dual-pdf choice must still gate the OCG cream layer ON');
      dualDom.window.close();
      return { variantsExplained: 2, manualOverride: false };
    },
  },
  {
    name: 'application workspace: unsaved or legacy HTML clearly disables Sync',
    run: () => {
      const legacyResumePdf = Buffer.from('%PDF-1.4\nlegacy-resume');
      const migrated = normaliseResumeDownloadBundle({
        company: 'Acme', candidateName: 'Maya', jobMarkdown: '# Role', pdfBase64: legacyResumePdf.toString('base64'),
      });
      assert(migrated.resumePdfBase64 === legacyResumePdf.toString('base64'), 'legacy pdfBase64 must migrate to the résumé field');
      assert(migrated.coverLetterPdfBase64 === '', 'legacy résumé bytes must never be fabricated as a cover-letter PDF');
      const doc = buildResumeDocument({
        docId: 'bundle-legacy-payload-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya</h1></main>',
        coverLetter: { name: 'Maya', paragraphs: ['Cover copy.'] },
        downloadBundle: migrated,
      });
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-legacy.local/' });
      const sync = dom.window.document.getElementById('ic-sync-btn');
      const note = dom.window.document.getElementById('ic-pdf-bundle-note');
      assert(sync.disabled, 'legacy HTML without an Electron capability must not claim it can overwrite files');
      assert(note.textContent.includes('Save this application from Infinite Canvas'), 'legacy HTML must explain how to make Sync available');
      dom.window.close();
      return { legacyResumeRetained: true, syncRequiresSave: true };
    },
  },
  {
    name: 'application Sync readback verifies exact HTML, parsed PDF, and the retained capability',
    run: async () => {
      const dir = await fs.promises.mkdtemp('/tmp/infinite-canvas-sync-readback-');
      const applicationPath = path.join(dir, 'Application.html');
      const pdfPath = path.join(dir, 'Resume.pdf');
      const token = 'd'.repeat(64);
      const html = `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">Resume</main></section><section data-ic-document-panel="cover"><main class="page">Cover</main></section><script id="ic-application-bundle-data" type="application/json">{"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","token":"${token}"}}</script></body></html>`;
      const pdf = await PDFLib.PDFDocument.create();
      pdf.addPage([612, 792]);
      const pdfBytes = Buffer.from(await pdf.save());
      try {
        await Promise.all([
          fs.promises.writeFile(applicationPath, html),
          fs.promises.writeFile(pdfPath, pdfBytes),
        ]);
        const manifest = await inspectApplicationSyncRevision({ applicationPath, pdfPath, html, pdf: pdfBytes, token });
        assert(manifest.every(item => item.integrityVerified && item.matchesSource)
          && manifest.find(item => item.name === 'Resume.pdf')?.pdfParsed,
        'a Sync revision passes only after exact-byte readback and structural PDF parsing');

        const alteredHtml = html.replace(token, 'e'.repeat(64));
        await fs.promises.writeFile(applicationPath, alteredHtml);
        let wrongCapabilityRejected = false;
        try {
          await inspectApplicationSyncRevision({ applicationPath, pdfPath, html: alteredHtml, pdf: pdfBytes, token });
        } catch (error) {
          wrongCapabilityRejected = /readback failed/.test(error.message)
            && error.syncManifest?.some(item => item.name === 'Application.html' && item.syncConfigValid === false);
        }
        assert(wrongCapabilityRejected,
          'an incoming shell may not replace the capability that authorized this workspace');
        return { verified: manifest.length, wrongCapabilityRejected };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application Sync serializes edits within one workspace while allowing unrelated workspaces to proceed',
    run: async () => {
      const order = [];
      let releaseFirst;
      const firstGate = new Promise(resolve => { releaseFirst = resolve; });
      const first = __withApplicationSyncWorkspaceLockForTests('/tmp/company/application', async () => {
        order.push('first:start');
        await firstGate;
        order.push('first:end');
      });
      const second = __withApplicationSyncWorkspaceLockForTests('/tmp/company/application', async () => {
        order.push('second:start');
        order.push('second:end');
      });
      const unrelated = __withApplicationSyncWorkspaceLockForTests('/tmp/company/other-application', async () => {
        order.push('other:start');
        order.push('other:end');
      });
      await Promise.resolve();
      await Promise.resolve();
      assert(order.includes('first:start') && order.includes('other:start') && !order.includes('second:start'),
        'a same-workspace Sync waits behind the active edit while a different workspace is not globally blocked');
      releaseFirst();
      await Promise.all([first, second, unrelated]);
      assert(order.indexOf('first:end') < order.indexOf('second:start'),
        'same-workspace Sync operations must complete in FIFO order');
      return { order };
    },
  },
  {
    name: 'application Sync capabilities reconstruct only canonical sibling paths',
    run: () => {
      const workspace = __normaliseApplicationSyncWorkspaceForTests({
        token: 'c'.repeat(64), workspaceDir: '/tmp/company/application',
        applicationPath: '/tmp/attacker.html', resumePdfPath: '/tmp/attacker.pdf',
      });
      assert(workspace?.applicationPath === '/tmp/company/application/Application.html', 'persisted state must never select a caller-provided HTML path');
      assert(workspace?.resumePdfPath === '/tmp/company/application/Resume.pdf', 'resume destination must be a canonical sibling');
      assert(workspace?.coverLetterPdfPath === '/tmp/company/application/Cover Letter.pdf', 'cover destination must be a canonical sibling');
      assert(__normaliseApplicationSyncWorkspaceForTests({ token: 'not-a-token', workspaceDir: '/tmp/company/application' }) === null, 'invalid capabilities must be discarded before serving sync');
      return { fixedWorkspacePaths: true };
    },
  },
];
