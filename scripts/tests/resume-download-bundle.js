import {
  assert,
  buildResumeDocument,
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

function readBrowserBlob(window, blob) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read browser Blob'));
    reader.onload = () => resolve(Buffer.from(reader.result));
    reader.readAsArrayBuffer(blob);
  });
}

async function attachPdf(dom, bytes, filename) {
  const attachment = dom.window.document.getElementById('ic-pdf-attachment');
  const file = new dom.window.File([bytes], filename, { type: 'application/pdf' });
  Object.defineProperty(attachment, 'files', { configurable: true, value: [file] });
  attachment.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(resolve => dom.window.setTimeout(resolve, 20));
}

function captureBundleDownload(dom) {
  let downloadedBlob = null;
  dom.window.URL.createObjectURL = (blob) => { downloadedBlob = blob; return 'blob:application-bundle'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {};
  dom.window.document.getElementById('ic-download-btn').click();
  return downloadedBlob;
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
    name: 'application workspace: one HTML independently refreshes résumé and cover PDFs, then rebundles offline',
    run: async () => {
      const initialResumePdf = Buffer.from('%PDF-1.4\ninitial-resume');
      const initialCoverPdf = Buffer.from('%PDF-1.4\ninitial-cover');
      const bundle = normaliseResumeDownloadBundle({
        company: '../Acme: Canada/', candidateName: 'Maya Chen',
        jobMarkdown: '# Platform Engineer\n\nOriginal listing.',
        resumePdfBase64: initialResumePdf.toString('base64'),
        coverLetterPdfBase64: initialCoverPdf.toString('base64'),
      });
      const doc = buildResumeDocument({
        docId: 'bundle-interaction-test',
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p id="resume-copy">Original résumé</p></main>',
        coverLetter: {
          name: 'Maya Chen', tagline: 'Platform engineer', date: 'August 14, 2026',
          recipient: 'Hiring Team\nAcme Canada', salutation: 'Dear Hiring Team,',
          paragraphs: ['Original cover letter.'], closing: 'Sincerely,', signatureTitle: 'Platform Engineer · candidate', contact: [],
        },
        downloadBundle: bundle,
      });
      assert(doc.includes('Download application bundle') && doc.includes('Cover letter'), 'combined workspace controls must be present');

      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application.local/' });
      const { document } = dom.window;
      const download = document.getElementById('ic-download-btn');
      const edit = document.getElementById('ic-edit-toggle');
      const resumePanel = document.getElementById('ic-resume-panel');
      const coverPanel = document.getElementById('ic-cover-panel');
      assert(!download.disabled, 'fresh embedded PDFs for both documents should enable a no-review bundle');

      document.getElementById('ic-cover-tab').click();
      assert(resumePanel.hidden && !coverPanel.hidden, 'cover tab must show only the cover letter');
      edit.click();
      const coverMain = coverPanel.querySelector('main');
      assert(coverMain.getAttribute('contenteditable') === 'true', 'Edit must target the selected cover letter');
      coverMain.querySelector('.letter-body p').textContent = 'Edited cover letter.';
      coverMain.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      assert(download.disabled, 'cover-only edits must stale Cover Letter.pdf and block the complete bundle');

      const currentCoverPdf = Buffer.from('%PDF-1.7\ncurrent-edited-cover');
      await attachPdf(dom, currentCoverPdf, 'Maya Chen - Cover Letter.pdf');
      assert(!download.disabled, 'attaching only the refreshed cover PDF must preserve the current résumé PDF and re-enable the bundle');

      document.getElementById('ic-resume-tab').click();
      edit.click();
      const resumeMain = resumePanel.querySelector('main');
      resumeMain.querySelector('#resume-copy').textContent = 'Edited résumé';
      resumeMain.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      assert(download.disabled, 'résumé edits must stale only Resume.pdf and block the complete bundle');

      const currentResumePdf = Buffer.from('%PDF-1.7\ncurrent-edited-resume');
      await attachPdf(dom, currentResumePdf, 'Maya Chen - Resume.pdf');
      assert(!download.disabled, 'attaching the current résumé PDF must re-enable the bundle without replacing Cover Letter.pdf');

      const downloadedBlob = captureBundleDownload(dom);
      assert(downloadedBlob, 'bundle click must create a ZIP Blob');
      const entries = readZipEntries(await readBrowserBlob(dom.window, downloadedBlob));
      const expectedNames = [
        'Acme Canada/Application.html',
        'Acme Canada/Resume.pdf',
        'Acme Canada/Cover Letter.pdf',
        'Acme Canada/Original Job Listing.md',
      ];
      assert(JSON.stringify([...entries.keys()]) === JSON.stringify(expectedNames), 'browser bundle must have exactly one HTML and both PDFs');
      const appHtml = entries.get('Acme Canada/Application.html')?.toString('utf8') || '';
      assert(appHtml.includes('Edited résumé') && appHtml.includes('Edited cover letter.'), 'downloaded single HTML must contain both current edits');
      assert(entries.get('Acme Canada/Resume.pdf')?.equals(currentResumePdf), 'downloaded bundle must use the attached current résumé PDF');
      assert(entries.get('Acme Canada/Cover Letter.pdf')?.equals(currentCoverPdf), 'downloaded bundle must use the attached current cover-letter PDF');
      assert(appHtml.includes(currentResumePdf.toString('base64')) && appHtml.includes(currentCoverPdf.toString('base64')), 'both refreshed PDFs must persist inside HTML for a future offline rebundle');
      assert(entries.get('Acme Canada/Original Job Listing.md')?.toString('utf8').includes('Original listing.'), 'job listing must survive browser rebundle');

      const reopened = new JSDOM(appHtml, { runScripts: 'dangerously', url: 'https://application-reopened.local/' });
      assert(!reopened.window.document.getElementById('ic-download-btn').disabled, 'reopened downloaded HTML must retain both current PDF attachments');
      const redownloadedBlob = captureBundleDownload(reopened);
      const redownloaded = readZipEntries(await readBrowserBlob(reopened.window, redownloadedBlob));
      assert(redownloaded.get('Acme Canada/Resume.pdf')?.equals(currentResumePdf), 'reopened HTML must re-download the persisted résumé PDF');
      assert(redownloaded.get('Acme Canada/Cover Letter.pdf')?.equals(currentCoverPdf), 'reopened HTML must re-download the persisted cover-letter PDF');
      reopened.window.close();
      dom.window.close();
      return { entries: entries.size, oneHtml: true };
    },
  },
  {
    name: 'application workspace: review gates résumé/bundle but not cover printing, and only résumé-changing decisions stale PDF',
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
          resumePdfBase64: Buffer.from('%PDF-1.4\nresume-baseline').toString('base64'),
          coverLetterPdfBase64: Buffer.from('%PDF-1.4\ncover-baseline').toString('base64'),
        },
      });
      const dom = new JSDOM(doc, { runScripts: 'dangerously', url: 'https://application-review.local/' });
      const { document } = dom.window;
      const print = document.getElementById('ic-export-btn');
      const download = document.getElementById('ic-download-btn');
      assert(print.disabled && download.disabled, 'unresolved résumé claim must gate résumé print and bundle');
      document.getElementById('ic-cover-tab').click();
      assert(!print.disabled && download.disabled, 'cover-letter printing must stay available while bundle review is unresolved');
      document.querySelector('[data-ic-skill-action="not_mine"]').click();
      assert(!download.disabled, 'Not mine from the untouched baseline must not stale the résumé PDF');
      document.querySelector('[data-ic-skill-action="verified"]').click();
      assert(download.disabled, 'adding a verified skill to the résumé must require a current PDF attachment');
      dom.window.close();
      return { coverIndependent: true, staleOnlyOnResumeChange: true };
    },
  },
  {
    name: 'application workspace: legacy single PDF payload migrates to résumé only and requires a cover PDF',
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
      const download = dom.window.document.getElementById('ic-download-btn');
      const note = dom.window.document.getElementById('ic-pdf-bundle-note');
      assert(download.disabled, 'legacy HTML must block the four-file ZIP until a real Cover Letter.pdf is attached');
      assert(note.textContent.includes('cover-letter') || note.textContent.includes('both documents'), 'legacy HTML must explain that the cover PDF is missing');
      dom.window.close();
      return { legacyResumeRetained: true, coverRequired: true };
    },
  },
];
