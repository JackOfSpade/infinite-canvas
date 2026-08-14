import {
  assert,
  __normaliseApplicationSyncWorkspaceForTests,
  buildResumeDocument,
  embedApplicationSyncConfig,
  createApplicationBundle,
  createZipBuffer,
  formatOriginalJobListingMarkdown,
  JSDOM,
  normaliseResumeDownloadBundle,
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
    name: 'application workspace: review gates résumé Sync but not cover printing or Sync',
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
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-review.local/' });
      const { document } = dom.window;
      const print = document.getElementById('ic-export-btn');
      const sync = document.getElementById('ic-sync-btn');
      assert(print.disabled && sync.disabled, 'unresolved résumé claim must gate résumé print and Sync');
      document.getElementById('ic-cover-tab').click();
      assert(!print.disabled && !sync.disabled, 'cover-letter printing and Sync stay available while résumé review is unresolved');
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
