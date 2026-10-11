import crypto from 'node:crypto';
import {
  __applicationSyncStatePathForTests,
  __reconcileApplicationSyncWorkspaceForTests,
  __resetApplicationSyncWorkspacesForTests,
  __syncApplicationSyncWorkspaceForTests,
  __withSyncedGenerationAuditSavedArtifactsForTests,
  applyDualPdf,
  applicationSyncConfig,
  assert,
  buildResumeDocument,
  embedApplicationSyncConfig,
  formatOriginalJobListingMarkdown,
  fs,
  inspectApplicationExport,
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
import { captureInterviewPreparationBundle } from '../../electron/ipc/interviewPreparation.js';
import { logger } from '../../electron/logger.js';

async function textPdf(lines) {
  return textPdfPages([lines]);
}

async function textPdfPages(pages) {
  const pdf = await PDFLib.PDFDocument.create();
  const font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
  for (const entry of pages) {
    const lines = Array.isArray(entry) ? entry : entry.lines;
    const page = pdf.addPage(Array.isArray(entry) ? [612, 792] : entry.size);
    if (!Array.isArray(entry) && entry.media) {
      page.setMediaBox(entry.media.x, entry.media.y, entry.media.width, entry.media.height);
    }
    if (!Array.isArray(entry) && entry.crop) {
      page.setCropBox(entry.crop.x, entry.crop.y, entry.crop.width, entry.crop.height);
    }
    for (const { text, y, x = 56 } of lines) page.drawText(text, { x, y, size: 11, font });
  }
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

function wrappedSkillLabelResumeWorkspace() {
  return `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page"><h1 class="name">Maya Chen</h1><section class="section"><div class="section-head"><h2>Skills</h2></div><dl class="skills"><dt>Web Development</dt><dd>React<span class="sep">·</span>TypeScript<span class="sep">·</span>Django</dd><dt>Infrastructure &amp; Integration</dt><dd>Docker Compose<span class="sep">·</span>Kubernetes<span class="sep">·</span>MCP</dd></dl></section><section class="section"><div class="section-head"><h2>Experience</h2></div><p class="role-summary">Shipped stable systems.</p></section></main></section></body></html>`;
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

// `.skills` is a two-column grid: the `dt` label occupies the left column and
// its `dd` value the right one, so a row's label and the first line of its
// value share one visual line and read label-first. A long value then wraps
// underneath both. These are assembled lines, the shape
// `orderedTextBlocksFromItems` produces; the item-level ordering that produces
// it has its own test below.
function visualResumeLines(body) {
  return [
    { page: 1, x: 56, y: 700, text: 'Maya Chen' },
    { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
    { page: 1, x: 56, y: 640, text: `• ${body}` },
    { page: 1, x: 56, y: 600, text: 'S K I L L S' },
    { page: 1, x: 56, y: 570, text: 'Languages Python · TypeScript' },
    { page: 1, x: 56, y: 540, text: 'AI & Data MCP · ETL' },
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

// Mirrors the letterhead shape that broke export on 2026-09-23: a candidate
// whose contact row carries a short eligibility note and a full availability
// sentence alongside the email and phone. `.contact` is `display: flex; flex-wrap:
// wrap`, so that row occupies two visual PDF lines while remaining one leaf.
const WRAPPED_CONTACT_ITEMS = [
  'Email: maya@example.test',
  'Phone: (555) 010-0100',
  'Eligible to work in the US',
  'Open to relocation. Remote or hybrid roles preferred.',
];

function wrappedContactCoverWorkspace(paragraphs, { signatureTitle = '' } = {}) {
  const contact = WRAPPED_CONTACT_ITEMS.join('<span class="sep" aria-hidden="true">·</span>');
  const body = paragraphs.map(paragraph => `<p>${paragraph}</p>`).join('');
  const title = signatureTitle ? `<p class="signature-title">${signatureTitle}</p>` : '';
  return `<!doctype html><html><head><meta data-shell="preserve"></head><body><section data-ic-document-panel="cover"><main class="page">`
    + `<header class="resume-header letter-letterhead"><h1 class="name">Maya Chen</h1>`
    + `<p class="tagline"><span class="subtitle-role">Engineer</span><span class="sep" aria-hidden="true">·</span><span class="credential">B.S. Computer Science, Halden University</span></p>`
    + `<p class="contact" role="group" aria-label="Contact">${contact}</p></header>`
    + `<div class="letter-meta"><p class="letter-date"><time datetime="2026-09">September 2026</time></p></div>`
    + `<div class="letter-body"><p class="salutation">Dear Brindlewood Logistics Hiring Team,</p>${body}</div>`
    + `<div class="letter-close"><p class="valediction">Sincerely,</p><p class="signature">Maya Chen</p>${title}</div>`
    + `</main></section><script data-shell="preserve">trusted()</script></body></html>`;
}

// Geometry copied from the PDF that failed export three times: the name/tagline
// gap (20.25pt) is larger than the gap inside the wrapped contact row
// (15.75pt), but both straddle the same page-wide leading estimate, so only the
// trusted DOM can say where the contact row ends.
function wrappedContactCoverLines(paragraphs, { signatureTitleLines = [] } = {}) {
  const lines = [
    { page: 1, x: 45.4, y: 778.2, height: 28, text: 'Maya Chen' },
    { page: 1, x: 45.4, y: 757.9, height: 11, text: 'Engineer · B.S. Computer Science, Halden University' },
    { page: 1, x: 45.4, y: 732.4, height: 9, text: 'Email: maya@example.test · Phone: (555) 010-0100 · Eligible to work in the US ·' },
    { page: 1, x: 45.4, y: 716.7, height: 9, text: 'Open to relocation. Remote or hybrid roles preferred.' },
    { page: 1, x: 484.2, y: 678.4, height: 9, text: 'September 2026' },
    { page: 1, x: 45.4, y: 652.2, height: 10, text: 'Dear Brindlewood Logistics Hiring Team,' },
  ];
  let y = 623.7;
  for (const paragraph of paragraphs) {
    for (const visualLine of paragraph) {
      lines.push({ page: 1, x: 45.4, y, height: 10, text: visualLine });
      y -= 15;
    }
    y -= 12.75;
  }
  lines.push({ page: 1, x: 45.4, y: y - 6.75, height: 10, text: 'Sincerely,' });
  lines.push({ page: 1, x: 45.4, y: y - 36.75, height: 15, text: 'Maya Chen' });
  let titleY = y - 66.75;
  for (const visualLine of signatureTitleLines) {
    lines.push({ page: 1, x: 45.4, y: titleY, height: 9, text: visualLine });
    titleY -= 12;
  }
  return lines;
}

const WRAPPED_CONTACT_PARAGRAPHS = [
  ['At Brindlewood Logistics, Dockline pairs end-to-end booking experiences with integration work', 'that reduces complexity for carriers.'],
  ['Depot scheduling provides another example of the same coordination', 'practice across partner depots.'],
  ['Earlier, my reporting work handled intake and controlled sharing through scheduled', 'exports from a local ledger.'],
];

function wrappedContactParagraphText(paragraph) {
  return paragraph.join(' ');
}

// ---- Generation Audit re-binding during the open-time reconcile ----------------
// The saved page POSTs action:'reconcile' on every open. When that rewrites
// Application.html (a PDF edited outside Sync, or a shared paper-variant import)
// the durable receipt that fingerprints the bundle must follow in the same
// transaction, exactly as Sync does; otherwise the Interview Helper reads the
// bundle as hash-mismatch and drops the audit identity.
const auditDigest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)).digest('hex');

const AUDIT_RESUME_LINES = text => [{ text, y: 700 }];

function auditCoverLines(body) {
  return [
    { text: 'Maya Chen', y: 700 }, { text: 'Engineer · B.S.', y: 680 },
    { text: 'maya@example.test · 555-0100', y: 660 }, { text: 'August 2026', y: 620, x: 480 },
    { text: 'Dear Hiring Team,', y: 590 }, { text: body, y: 550 },
    { text: 'Sincerely,', y: 510 }, { text: 'Maya Chen', y: 490 },
  ];
}

// Builds a complete saved bundle with a REAL Generation Audit.json receipt whose
// savedArtifacts bind the exact files on disk, registers it with Sync, and
// returns helpers that read the verdict from the real Interview Preparation
// verifier. auditText: 'valid' (default), '' (legacy bundle with no receipt) or
// raw receipt text written verbatim.
async function auditedReconcileBundle({ dual = false, auditText = 'valid', tokenDigit = '3' } = {}) {
  await __resetApplicationSyncWorkspacesForTests();
  const root = await fs.promises.realpath(await fs.promises.mkdtemp('/tmp/infinite-canvas-pdf-audit-'));
  const userDataPath = await fs.promises.mkdtemp('/tmp/infinite-canvas-pdf-audit-ud-');
  const token = tokenDigit.repeat(64);
  let resumePdf = await textPdf(AUDIT_RESUME_LINES('Maya Chen Resume baseline.'));
  let coverPdf = await textPdf(auditCoverLines('Maya builds reliable systems.'));
  if (dual) {
    resumePdf = await applyDualPdf(resumePdf);
    coverPdf = await applyDualPdf(coverPdf);
  }
  const source = combinedWorkspace('Maya builds reliable systems.').replace('<html>', '<html data-print="ink-only">');
  const saved = embedApplicationSyncConfig(source, applicationSyncConfig(token, { html: source, resumePdf, coverPdf }));
  const listing = formatOriginalJobListingMarkdown({
    title: 'Systems Engineer', company: 'Acme Robotics', location: 'Remote (US)', description: 'Build robots.',
  });
  const audit = {
    version: 1,
    schema: 'infinite-canvas-generation-audit',
    jobId: 'job-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    job: { title: 'Systems Engineer', company: 'Acme Robotics', location: 'Remote (US)' },
    finalArtifacts: {
      resultSha256: 'a'.repeat(64),
      resumeContentSha256: 'b'.repeat(64),
      coverLetterContentSha256: 'c'.repeat(64),
      stagedApplicationHtmlSha256: auditDigest(source),
      resumePdfSha256: auditDigest(resumePdf),
      coverLetterPdfSha256: auditDigest(coverPdf),
      originalJobListingSha256: auditDigest(listing),
    },
    savedArtifacts: {
      applicationHtmlSha256: auditDigest(saved),
      resumePdfSha256: auditDigest(resumePdf),
      coverLetterPdfSha256: auditDigest(coverPdf),
      originalJobListingSha256: auditDigest(listing),
    },
  };
  const files = {
    'Application.html': saved,
    'Resume.pdf': resumePdf,
    'Cover Letter.pdf': coverPdf,
    'Original Job Listing.md': listing,
  };
  if (auditText === 'valid') files['Generation Audit.json'] = `${JSON.stringify(audit, null, 2)}\n`;
  else if (auditText) files['Generation Audit.json'] = auditText;
  await Promise.all(Object.entries(files).map(([name, data]) => fs.promises.writeFile(path.join(root, name), data)));
  await registerApplicationSyncWorkspace(root, token);
  return {
    root,
    token,
    audit,
    resumePdf,
    coverPdf,
    read: name => fs.promises.readFile(path.join(root, name), 'utf8'),
    write: (name, data) => fs.promises.writeFile(path.join(root, name), data),
    readAudit: async () => JSON.parse(await fs.promises.readFile(path.join(root, 'Generation Audit.json'), 'utf8')),
    status: async () => (await captureInterviewPreparationBundle({ directory: root, userDataPath })).verification.status,
    reconcile: () => __reconcileApplicationSyncWorkspaceForTests({ token, action: 'reconcile' }),
    cleanup: async () => {
      await __resetApplicationSyncWorkspacesForTests();
      await fs.promises.unlink(__applicationSyncStatePathForTests()).catch(() => {});
      await fs.promises.rm(root, { recursive: true, force: true });
      await fs.promises.rm(userDataPath, { recursive: true, force: true });
    },
  };
}

// Runs fn while recording the logger.warn lines it emits (and keeping the test
// output quiet). The reconcile logs, rather than swallows, a skipped refresh.
async function withCapturedWarnings(fn) {
  const original = logger.warn;
  const warnings = [];
  logger.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    return { result: await fn(), warnings };
  } finally {
    logger.warn = original;
  }
}

export default [
  {
    name: 'Application PDF reconcile: a wrapped letterhead contact row keeps every envelope leaf on its own text',
    run: () => {
      const source = wrappedContactCoverWorkspace(WRAPPED_CONTACT_PARAGRAPHS.map(wrappedContactParagraphText));
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'cover',
        blocks: wrappedContactCoverLines(WRAPPED_CONTACT_PARAGRAPHS),
      });
      // The regression: the contact's second visual line used to be mapped onto
      // `.letter-date`, pushing the salutation into the body, where it counted
      // as a fourth paragraph and blocked the bundle save outright.
      assert(!/geometry-separated body block/.test(result.reason || ''),
        `a wrapped contact row must not be counted as an extra body paragraph, got ${JSON.stringify(result)}`);
      assert(result.success && result.status === 'unchanged' && result.exactTextMatch,
        `an unedited generated cover letter must reconcile unchanged, got ${JSON.stringify(result)}`);
      return { mappedLeaves: result.mappedLeaves, wrappedEnvelopeLeafMapped: true };
    },
  },
  {
    name: 'Application PDF reconcile: a body edit imports while a wrapped contact row stays intact',
    run: () => {
      const source = wrappedContactCoverWorkspace(WRAPPED_CONTACT_PARAGRAPHS.map(wrappedContactParagraphText));
      const edited = WRAPPED_CONTACT_PARAGRAPHS.map((paragraph, index) => (index === 1
        ? [paragraph[0], 'practice across audited partner depots.']
        : paragraph));
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'cover',
        blocks: wrappedContactCoverLines(edited),
      });
      assert(result.success && result.status === 'updated'
        && result.html.includes('practice across audited partner depots.'),
      `a body edit must still import when the letterhead wraps, got ${JSON.stringify(result)}`);
      assert(result.html.includes('Open to relocation. Remote or hybrid roles preferred.')
        && result.html.includes('<time datetime="2026-09">September 2026</time>')
        && result.html.includes('Dear Brindlewood Logistics Hiring Team,'),
      'the wrapped contact row, the date, and the salutation must keep their own trusted text');
      return { coverUpdated: true, envelopePreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: a wrapped closing signature title maps from the end of the letter',
    run: () => {
      const signatureTitle = 'Software Engineer · Lakeview, Ontario · Available on four weeks notice';
      const source = wrappedContactCoverWorkspace(WRAPPED_CONTACT_PARAGRAPHS.map(wrappedContactParagraphText), { signatureTitle });
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'cover',
        blocks: wrappedContactCoverLines(WRAPPED_CONTACT_PARAGRAPHS, {
          signatureTitleLines: ['Software Engineer · Lakeview, Ontario ·', 'Available on four weeks notice'],
        }),
      });
      assert(result.success && result.status === 'unchanged' && result.exactTextMatch,
        `a wrapped signature title must be mapped to its own leaf, got ${JSON.stringify(result)}`);
      return { suffixLeafWrapMapped: true };
    },
  },
  {
    name: 'Application PDF reconcile: a genuinely extra cover paragraph is still a conflict',
    run: () => {
      const source = wrappedContactCoverWorkspace(WRAPPED_CONTACT_PARAGRAPHS.map(wrappedContactParagraphText));
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'cover',
        blocks: wrappedContactCoverLines([...WRAPPED_CONTACT_PARAGRAPHS, ['A fourth paragraph the panel never had.']]),
      });
      assert(!result.success && result.status === 'conflict'
        && /4 geometry-separated body block\(s\), but the cover letter has 3 paragraph\(s\)/.test(result.reason)
        && result.html === source,
      `an added PDF paragraph must remain an unmapped conflict, got ${JSON.stringify(result)}`);
      return { extraParagraphConflict: true };
    },
  },
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
    name: 'Application PDF reconcile: terminal inspection rejects an unexpected blank extra page',
    run: async () => {
      const source = resumeBulletWorkspace('Built reliable full-scale systems.')
        .replace('<html>', '<html data-print="ink-only">');
      const pdf = await textPdfPages([
        wrappedResumeBulletLines('Built reliable full-', 'scale systems.'),
        [],
      ]);
      const inspection = await inspectGeneratedApplicationPdf({
        html: source, pdf, documentKind: 'resume', expectedPageCount: 1,
      });
      assert(!inspection.valid && !inspection.paginationMatches && inspection.pageCount === 2
        && inspection.expectedPageCount === 1 && /expected 1/i.test(inspection.reason),
      `an extra blank page must be rejected even when page-one text matches, got ${JSON.stringify(inspection)}`);
      return { pageCount: inspection.pageCount, expected: inspection.expectedPageCount };
    },
  },
  {
    name: 'Application PDF reconcile: whitespace-only pages remain blank',
    run: async () => {
      const source = resumeBulletWorkspace('Built reliable full-scale systems.')
        .replace('<html>', '<html data-print="ink-only">');
      const pdf = await textPdfPages([
        wrappedResumeBulletLines('Built reliable full-', 'scale systems.'),
        [{ text: '   ', y: 700 }],
      ]);
      const inspection = await inspectGeneratedApplicationPdf({
        html: source, pdf, documentKind: 'resume', expectedPageCount: 2,
      });
      assert(!inspection.valid && !inspection.paginationMatches
        && JSON.stringify(inspection.blankPages) === JSON.stringify([2])
        && /no extractable document text on page\(s\) 2/i.test(inspection.reason),
      `whitespace text objects must not make a blank PDF page acceptable, got ${JSON.stringify(inspection)}`);
      return { blankPages: inspection.blankPages };
    },
  },
  {
    name: 'Application PDF reconcile: terminal inspection rejects an orphaned resume heading',
    run: async () => {
      const source = resumeBulletsWorkspace(['Built reliable systems.', 'Kept the release process stable.'])
        .replace('<html>', '<html data-print="ink-only">');
      const pdf = await textPdfPages([
        [
          { text: 'Maya Chen', y: 700 },
          { text: 'Experience', y: 80 },
        ],
        [
          { text: '• Built reliable systems.', y: 700 },
          { text: '• Kept the release process stable.', y: 670 },
          { text: '2 / 2', y: 25, x: 520 },
        ],
      ]);
      const inspection = await inspectGeneratedApplicationPdf({
        html: source, pdf, documentKind: 'resume', expectedPageCount: 2,
      });
      assert(!inspection.valid && inspection.textMatches && !inspection.paginationMatches
        && inspection.orphanHeadingCount === 1 && /orphaned/i.test(inspection.reason),
      `a heading at a page foot must not pass merely because its text extracts, got ${JSON.stringify(inspection)}`);
      return { orphanHeadingCount: inspection.orphanHeadingCount };
    },
  },
  {
    name: 'Application PDF reconcile: later-page folios preserve a valid multi-page resume',
    run: async () => {
      const source = resumeBulletsWorkspace(['Built reliable systems.', 'Kept the release process stable.'])
        .replace('<html>', '<html data-print="ink-only">');
      const pdf = await textPdfPages([
        [
          { text: 'Maya Chen', y: 700 },
          { text: 'Experience', y: 670 },
          { text: '• Built reliable systems.', y: 640 },
        ],
        [
          { text: '• Kept the release process stable.', y: 700 },
          { text: '2 / 2', y: 25, x: 520 },
        ],
      ]);
      const inspection = await inspectGeneratedApplicationPdf({
        html: source, pdf, documentKind: 'resume', expectedPageCount: 2,
      });
      assert(inspection.valid && inspection.textMatches && inspection.paginationMatches
        && inspection.orphanHeadingCount === 0,
      `standalone page folios must not become extra résumé text, got ${JSON.stringify(inspection)}`);
      return { pageCount: inspection.pageCount, textMatches: inspection.textMatches };
    },
  },
  {
    name: 'Application PDF reconcile: body ratios are not mistaken for repeated page folios',
    run: () => {
      const source = '<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">'
        + '<h1 class="name">Maya Chen</h1><section class="section"><div class="section-head"><h2>Experience</h2></div>'
        + '<p>1 / 2</p><p>Continued evidence.</p><p>2 / 2</p></section>'
        + '</main></section></body></html>';
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'resume',
        blocks: [
          { page: 1, x: 56, y: 700, text: 'Maya Chen' },
          { page: 1, x: 56, y: 670, text: 'Experience' },
          { page: 1, x: 56, y: 640, text: '1 / 2' },
          { page: 2, x: 56, y: 700, text: 'Continued evidence.' },
          { page: 2, x: 56, y: 670, text: '2 / 2' },
        ],
      });
      assert(result.success && result.changed === false && result.pagination?.textPages?.join(',') === '1,2',
        `body ratios must remain reconciliation text instead of becoming fake chrome, got ${JSON.stringify(result)}`);
      return { textPages: result.pagination.textPages };
    },
  },
  {
    name: 'Application PDF reconcile: terminal inspection rejects inconsistent page media or crop geometry',
    run: async () => {
      const source = resumeBulletsWorkspace(['Built reliable systems.', 'Kept the release process stable.'])
        .replace('<html>', '<html data-print="ink-only">');
      const pdf = await textPdfPages([
        [
          { text: 'Maya Chen', y: 700 },
          { text: 'Experience', y: 670 },
        ],
        { size: [600, 800], lines: [
          { text: '• Built reliable systems.', y: 700 },
          { text: '• Kept the release process stable.', y: 670 },
        ] },
      ]);
      const inspection = await inspectGeneratedApplicationPdf({
        html: source, pdf, documentKind: 'resume', expectedPageCount: 2,
      });
      assert(!inspection.valid && inspection.textMatches && !inspection.paginationMatches
        && /size does not match|crop bounds/i.test(inspection.reason),
      `a malformed second page must not pass based on page one, got ${JSON.stringify(inspection)}`);
      return { pageCount: inspection.pageCount, rejected: inspection.reason };
    },
  },
  {
    name: 'Application PDF reconcile: terminal inspection rejects uniformly inset CropBoxes',
    run: async () => {
      const source = resumeBulletWorkspace('Built reliable full-scale systems.')
        .replace('<html>', '<html data-print="ink-only">');
      const pdf = await textPdfPages([{
        size: [612, 792], crop: { x: 12, y: 12, width: 588, height: 768 },
        lines: wrappedResumeBulletLines('Built reliable full-', 'scale systems.'),
      }]);
      const inspection = await inspectGeneratedApplicationPdf({ html: source, pdf, documentKind: 'resume', expectedPageCount: 1 });
      assert(!inspection.valid && inspection.textMatches && !inspection.paginationMatches
        && /crop bounds do not match/i.test(inspection.reason),
      `matching inset CropBoxes on every page are clipping, not consistent geometry, got ${JSON.stringify(inspection)}`);
      return { rejected: inspection.reason };
    },
  },
  {
    name: 'Application PDF reconcile: atomic export readback rejects uniformly inset CropBoxes',
    run: async () => {
      const directory = await fs.promises.mkdtemp('/tmp/application-pdf-crop-');
      const pdfPath = path.join(directory, 'Resume.pdf');
      try {
        const pdf = await textPdfPages([{
          size: [612, 792], crop: { x: 12, y: 12, width: 588, height: 768 },
          lines: wrappedResumeBulletLines('Built reliable full-', 'scale systems.'),
        }]);
        await fs.promises.writeFile(pdfPath, pdf);
        const error = await inspectApplicationExport([{
          path: pdfPath, kind: 'pdf', expectedData: pdf, expectedPageCount: 1,
          expectedPaper: { x: 0, y: 0, width: 612, height: 792 },
        }]).then(() => null, failure => failure);
        assert(/Application export readback failed.*Resume\.pdf/i.test(String(error?.message || error)),
          `atomic readback must reject a uniformly inset CropBox, got ${String(error)}`);
        return { rejected: true };
      } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Application PDF reconcile: translated Letter and A4 boxes pass preflight and atomic readback',
    run: async () => {
      const directory = await fs.promises.mkdtemp('/tmp/application-pdf-translated-');
      try {
        const papers = [
          { name: 'Letter', attrs: 'data-print="ink-only"', width: 612, height: 792 },
          { name: 'A4', attrs: 'data-page="a4" data-print="ink-only"', width: 595.28, height: 841.89 },
        ];
        const results = [];
        for (const paper of papers) {
          const source = resumeBulletWorkspace('Built reliable full-scale systems.')
            .replace('<html>', `<html ${paper.attrs}>`);
          const translated = { x: 18, y: -24, width: paper.width, height: paper.height };
          const pdf = await textPdfPages([{
            size: [paper.width, paper.height], media: translated, crop: translated,
            lines: wrappedResumeBulletLines('Built reliable full-', 'scale systems.'),
          }]);
          const preflight = await inspectGeneratedApplicationPdf({ html: source, pdf, documentKind: 'resume', expectedPageCount: 1 });
          const pdfPath = path.join(directory, `${paper.name}.pdf`);
          await fs.promises.writeFile(pdfPath, pdf);
          const readback = await inspectApplicationExport([{
            path: pdfPath, kind: 'pdf', expectedData: pdf, expectedPageCount: 1,
            expectedPaper: { x: 0, y: 0, width: paper.width, height: paper.height },
          }]);
          assert(preflight.valid && readback[0]?.integrityVerified === true
            && readback[0]?.pdfPageGeometryValid === true,
          `translated ${paper.name} boxes must retain their legal origin while passing dimension checks, got ${JSON.stringify({ preflight, readback })}`);
          results.push({ paper: paper.name, preflight: preflight.valid, readback: readback[0].pdfPageGeometryValid });
        }
        return results;
      } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Application PDF reconcile: later-page three-page folios cannot mask an orphaned heading',
    run: () => {
      const source = resumeBulletsWorkspace(['Built reliable systems.', 'Kept the release process stable.']);
      const result = reconcileApplicationHtmlFromPdfBlocks({
        html: source,
        documentKind: 'resume',
        blocks: [
          { page: 1, x: 56, y: 700, text: 'Maya Chen' },
          { page: 2, x: 56, y: 80, text: 'Experience' },
          { page: 2, x: 520, y: 25, text: '2 / 3' },
          { page: 3, x: 56, y: 700, text: '• Built reliable systems.' },
          { page: 3, x: 56, y: 670, text: '• Kept the release process stable.' },
          { page: 3, x: 520, y: 25, text: '3 / 3' },
        ],
      });
      assert(result.pagination?.orphanHeadingCount === 1,
        `a repeated page folio must not be treated as heading content, got ${JSON.stringify(result.pagination)}`);
      return { orphanHeadingCount: result.pagination.orphanHeadingCount };
    },
  },
  {
    name: 'Application PDF reconcile: PDF-only separators cannot offset a later wrapped compound',
    run: () => {
      const source = '<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">'
        + '<h1>Riley Okafor</h1>'
        + '<p>Software Engineer <span class="sep" aria-hidden="true">·</span> B.S. Computer Science</p>'
        + '<p>Email <span class="sep" aria-hidden="true">·</span> Phone</p>'
        + '<p>Software Engineer <span class="sep" aria-hidden="true">·</span> Maple Ridge School District '
        + '<span class="sep" aria-hidden="true">·</span> Brookfield, OH</p>'
        + '<ul><li>Migrated work-order and bus-routing records to hosted products, with imports, '
        + 'record-matching workflows, automation, validation, and reporting.</li></ul>'
        + '</main></section></body></html>';
      const blocks = [
        { page: 1, x: 56, y: 700, text: 'Riley Okafor' },
        { page: 1, x: 56, y: 680, text: 'Software Engineer · B.S. Computer Science' },
        { page: 1, x: 56, y: 660, text: 'Email · Phone' },
        { page: 1, x: 56, y: 640, text: 'Software Engineer · Maple Ridge School District · Brookfield, OH' },
        { page: 1, x: 56, y: 620, text: '• Migrated work-order and bus-routing records to hosted products, with imports, record-' },
        { page: 1, x: 72, y: 605, text: 'matching workflows, automation, validation, and reporting.' },
      ];
      const result = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(result.success && result.status === 'unchanged' && result.changed === false
        && result.exactTextMatch === true && result.html === source,
      `aria-hidden PDF-only separators must not make a later wrapped compound ambiguous, got ${JSON.stringify(result)}`);
      return { pdfOnlySeparators: 4, wrappedCompoundPreserved: true };
    },
  },
  {
    name: 'Application PDF reconcile: PDF-only separators do not hide a shifted suspended hyphen',
    run: () => {
      const source = '<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">'
        + '<h1>Riley Okafor</h1><p>Engineer <span aria-hidden="true">·</span> B.S.</p>'
        + '<ul><li>Supported part- and full-time schedules.</li></ul>'
        + '</main></section></body></html>';
      const blocks = [
        { page: 1, x: 56, y: 700, text: 'Riley Okafor' },
        { page: 1, x: 56, y: 680, text: 'Engineer · B.S.' },
        { page: 1, x: 56, y: 640, text: '• Supported flexible part-' },
        { page: 1, x: 72, y: 625, text: 'and full-time schedules.' },
      ];
      const result = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(!result.success && result.status === 'conflict' && result.html === source
        && !result.html.includes('part-and'),
      `ignoring visual separators must not weaken shifted suspended-hyphen protection, got ${JSON.stringify(result)}`);
      return { conflict: true, sourcePreserved: result.html === source };
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
    name: 'Application Sync: a stale same-generation autosave cannot mask a newer saved panel and remains recoverable offline',
    run: async () => {
      const docId = 'same-generation-stale-autosave';
      const token = 'a'.repeat(64);
      let source = buildResumeDocument({
        docId,
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p>Saved Application revision.</p></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Cover baseline.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya Chen' },
      });
      const config = applicationSyncConfig(token, { html: source });
      source = embedApplicationSyncConfig(source, config);
      const fingerprint = /var RESUME_MARKUP_FINGERPRINT = "([^"]+)"/.exec(source)?.[1] || '';
      const storageKey = `ic-edit:${docId}`;
      const staleMarkup = '<h1 class="name">Maya Chen</h1><p>Older browser-only revision.</p>';
      const dom = new JSDOM(source, {
        runScripts: 'dangerously', url: 'https://same-generation-stale.local/',
        beforeParse(window) {
          window.localStorage.setItem(storageKey, staleMarkup);
          window.localStorage.setItem(`${storageKey}:fingerprint`, fingerprint);
          // Same generator run, but typed over the earlier on-disk panel.
          window.localStorage.setItem(`${storageKey}:base-html-sha256`, 'b'.repeat(64));
          window.fetch = async () => { throw new TypeError('Failed to fetch'); };
        },
      });
      try {
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        const mainText = dom.window.document.querySelector('[data-ic-document-panel="resume"] main')?.textContent || '';
        const note = dom.window.document.getElementById('ic-pdf-bundle-note')?.textContent || '';
        assert(mainText.includes('Saved Application revision.') && !mainText.includes('Older browser-only revision.'),
          'a same-generation draft stamped against an older saved panel must not replace newer Application.html content');
        assert(dom.window.localStorage.getItem(storageKey) === null
          && dom.window.localStorage.getItem(`${storageKey}:fingerprint`) === null
          && dom.window.localStorage.getItem(`${storageKey}:base-html-sha256`) === null
          && dom.window.localStorage.getItem(`${storageKey}:superseded`) === staleMarkup,
        'a displaced stale draft must be removed from the active autosave slot and retained for recovery');
        assert(/could not reach Infinite Canvas/i.test(note),
          'the stale-revision guard must still protect the saved file when opening offline');
        return { staleAutosaveQuarantined: true, offlineVisible: true };
      } finally {
        dom.window.close();
      }
    },
  },
  {
    name: 'Application Sync: an offline open preserves a revision-matched browser draft',
    run: async () => {
      const docId = 'offline-current-autosave';
      const token = 'c'.repeat(64);
      let source = buildResumeDocument({
        docId,
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p>Saved baseline.</p></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Cover baseline.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya Chen' },
      });
      const config = applicationSyncConfig(token, { html: source });
      source = embedApplicationSyncConfig(source, config);
      const fingerprint = /var RESUME_MARKUP_FINGERPRINT = "([^"]+)"/.exec(source)?.[1] || '';
      const storageKey = `ic-edit:${docId}`;
      const draftMarkup = '<h1 class="name">Maya Chen</h1><p>Unsynced but current browser draft.</p>';
      const dom = new JSDOM(source, {
        runScripts: 'dangerously', url: 'https://offline-current.local/',
        beforeParse(window) {
          window.localStorage.setItem(storageKey, draftMarkup);
          window.localStorage.setItem(`${storageKey}:fingerprint`, fingerprint);
          window.localStorage.setItem(`${storageKey}:base-html-sha256`, config.documents.resume.htmlSha256);
          window.fetch = async () => { throw new TypeError('Failed to fetch'); };
        },
      });
      try {
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        const mainText = dom.window.document.querySelector('[data-ic-document-panel="resume"] main')?.textContent || '';
        assert(mainText.includes('Unsynced but current browser draft.')
          && dom.window.localStorage.getItem(storageKey) === draftMarkup
          && dom.window.localStorage.getItem(`${storageKey}:superseded`) === null,
        'an offline open must retain an autosave that is stamped against the current saved panel');
        return { matchedDraftRestoredOffline: true };
      } finally {
        dom.window.close();
      }
    },
  },
  {
    name: 'Application Sync: an edit during Sync and later same-session autosaves retain the returned panel revision',
    run: async () => {
      const docId = 'sync-in-flight-autosave';
      const token = 'd'.repeat(64);
      const syncedRevision = 'e'.repeat(64);
      let source = buildResumeDocument({
        docId,
        resumeMainHtml: '<main class="page"><h1 class="name">Maya Chen</h1><p>Saved baseline.</p></main>',
        coverLetter: { name: 'Maya Chen', paragraphs: ['Cover baseline.'] },
        downloadBundle: { company: 'Acme', candidateName: 'Maya Chen' },
      });
      const config = applicationSyncConfig(token, { html: source });
      source = embedApplicationSyncConfig(source, config);
      let resolveSync;
      const dom = new JSDOM(source, {
        runScripts: 'dangerously', url: 'https://sync-in-flight.local/',
        beforeParse(window) {
          window.fetch = async (_endpoint, options) => {
            const payload = JSON.parse(options.body);
            if (payload.action === 'reconcile') {
              return { ok: true, json: async () => ({ success: true, importedDocuments: [], staleDocuments: [], conflicts: [], variantMismatches: [] }) };
            }
            return new Promise(resolve => {
              resolveSync = () => resolve({ ok: true, json: async () => ({ success: true, htmlSha256: syncedRevision }) });
            });
          };
        },
      });
      try {
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        const main = dom.window.document.querySelector('[data-ic-document-panel="resume"] main');
        const syncButton = dom.window.document.getElementById('ic-sync-btn');
        assert(main && syncButton, 'fixture requires the résumé editor and Sync control');
        main.innerHTML = '<h1 class="name">Maya Chen</h1><p>Snapshot submitted to Sync.</p>';
        main.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        syncButton.click();
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        assert(typeof resolveSync === 'function', 'Sync click must issue a pending Sync request');
        main.innerHTML = '<h1 class="name">Maya Chen</h1><p>Edit made while Sync was rendering.</p>';
        main.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        dom.window.document.getElementById('ic-cover-tab').click();
        await new Promise(resolve => dom.window.setTimeout(resolve, 550));
        resolveSync();
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        await new Promise(resolve => dom.window.setTimeout(resolve, 0));
        const storageKey = `ic-edit:${docId}`;
        const inFlightSaved = dom.window.localStorage.getItem(storageKey) || '';
        const note = dom.window.document.getElementById('ic-pdf-bundle-note')?.textContent || '';
        assert(inFlightSaved.includes('Edit made while Sync was rendering.')
          && dom.window.localStorage.getItem(`${storageKey}:base-html-sha256`) === syncedRevision
          && /Newer edits still need Sync/i.test(note),
        'a Sync response must not overwrite an edit made while it was rendering or after a tab switch, and must re-stamp that edit against the returned revision');
        main.innerHTML = '<h1 class="name">Maya Chen</h1><p>Later same-session autosave.</p>';
        main.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        await new Promise(resolve => dom.window.setTimeout(resolve, 550));
        assert((dom.window.localStorage.getItem(storageKey) || '').includes('Later same-session autosave.')
          && dom.window.localStorage.getItem(`${storageKey}:base-html-sha256`) === syncedRevision,
        'an autosave after a successful Sync must continue using the returned saved-panel revision');
        return { inFlightEditPreserved: true, postSyncAutosaveContinuous: true };
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
    name: 'Application PDF reconcile: printed résumé headings, bullets, and two-column skills normalize before conservative import',
    run: () => {
      const source = resumeWorkspace('Maya builds systems safely.');
      const unchanged = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: visualResumeLines('Maya builds systems safely.') });
      assert(unchanged.success && unchanged.status === 'unchanged' && !unchanged.changed,
        `generated PDF-only presentation text must normalize to an unchanged résumé, got ${JSON.stringify(unchanged)}`);
      const untrackedUppercase = visualResumeLines('Maya builds systems safely.').map(line => ({
        ...line,
        text: line.text === 'E X P E R I E N C E' ? 'EXPERIENCE'
          : (line.text === 'S K I L L S' ? 'SKILLS' : line.text),
      }));
      const uppercase = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: untrackedUppercase });
      assert(uppercase.success && uppercase.status === 'unchanged' && !uppercase.changed,
        `CSS-uppercased heading labels must match their trusted DOM text, got ${JSON.stringify(uppercase)}`);
      const changed = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: visualResumeLines('Maya ships systems safely.') });
      assert(changed.success && changed.status === 'updated' && changed.changed && changed.html.includes('Maya ships systems safely.'),
        `one semantic token change should retain conservative importability, got ${JSON.stringify(changed)}`);
      return { headingsCollapsed: true, skillRowsSplit: true, changed: changed.changed };
    },
  },
  {
    // The two grid cells of one `.skills` row do not share a baseline: `dd`
    // carries `line-height: var(--lh-snug)` and its `dt` does not, so the
    // value sits fractionally above the label that introduces it. Line
    // grouping tolerates that, but composing the grouped line in the
    // page-wide y-descending order emitted the right-hand value BEFORE the
    // left-hand label — on 2026-09-23 that produced
    // `... Docker Compose · MCP ·technologies` from a correct PDF and failed
    // the generated-bundle save with an unresolvable token alignment. Only an
    // item-level test covers this; the assembled-line fixtures above start
    // after the ordering decision has already been made.
    name: 'Application PDF reconcile: a grid row whose columns differ in baseline still reads left to right',
    run: async () => {
      const source = resumeWorkspace('Maya builds systems safely.');
      const pdfBytes = await textPdf([
        { text: 'Maya Chen', y: 700 },
        { text: 'E X P E R I E N C E', y: 670 },
        { text: '• Maya builds systems safely.', y: 640 },
        { text: 'S K I L L S', y: 600 },
        // Right column drawn fractionally higher than its own left-column
        // label, exactly as the rendered résumé does.
        { text: 'Python · TypeScript', x: 180, y: 570.75 },
        { text: 'Languages', x: 56, y: 570 },
        { text: 'MCP · ETL', x: 180, y: 540.75 },
        { text: 'AI & Data', x: 56, y: 540 },
      ]);
      const blocks = await extractPdfTextBlocks(pdfBytes);
      const skillLines = blocks.filter(block => /Languages|AI & Data/.test(block.text)).map(block => block.text);
      assert(skillLines.length === 2
        && skillLines[0] === 'Languages Python · TypeScript'
        && skillLines[1] === 'AI & Data MCP · ETL',
      `each grid row must compose in x order, got ${JSON.stringify(skillLines)}`);
      const unchanged = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(unchanged.success && unchanged.status === 'unchanged' && !unchanged.changed,
        `a faithfully rendered résumé PDF must reconcile unchanged, got ${JSON.stringify(unchanged)}`);
      return { skillLines, status: unchanged.status };
    },
  },
  {
    name: 'Application PDF reconcile: wrapped Skills label case edits remain conflicts',
    run: async () => {
      const source = wrappedSkillLabelResumeWorkspace();
      const blocks = await extractPdfTextBlocks(await textPdf([
        { text: 'Maya Chen', y: 700 },
        { text: 'S K I L L S', y: 660 },
        { text: 'Web Development', x: 56, y: 630 },
        { text: 'React · TypeScript · Django', x: 180, y: 630.75 },
        { text: 'infrastructure &', x: 56, y: 595 },
        { text: 'Docker Compose · Kubernetes · MCP', x: 180, y: 595.75 },
        { text: 'Integration', x: 56, y: 580 },
        { text: 'E X P E R I E N C E', y: 540 },
        { text: '• Shipped stable systems.', y: 510 },
      ]));
      const conflict = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(!conflict.success && conflict.status === 'conflict' && conflict.html === source,
        `a case-only wrapped Skills label edit must not be masked by DOM reconstruction, got ${JSON.stringify(conflict)}`);
      return { status: conflict.status };
    },
  },
  {
    // The failing export placed a wrapped second-row <dt> around its <dd> in
    // PDF reading order: "Infrastructure & Docker Compose … MCP", then
    // "Integration". The DOM's label remains one semantic unit. Include a
    // later section too, so Skills parsing cannot consume the rest of a résumé.
    name: 'Application PDF reconcile: wrapped Skills labels restore DOM order without consuming the next section',
    run: async () => {
      const source = wrappedSkillLabelResumeWorkspace();
      const pdfBytes = await textPdf([
        { text: 'Maya Chen', y: 700 },
        { text: 'S K I L L S', y: 660 },
        { text: 'Web Development', x: 56, y: 630 },
        { text: 'React · TypeScript · Django', x: 180, y: 630.75 },
        { text: 'Infrastructure &', x: 56, y: 595 },
        { text: 'Docker Compose · Kubernetes · MCP', x: 180, y: 595.75 },
        { text: 'Integration', x: 56, y: 580 },
        { text: 'E X P E R I E N C E', y: 540 },
        { text: '• Shipped stable systems.', y: 510 },
      ]);
      const blocks = await extractPdfTextBlocks(pdfBytes);
      const skillLines = blocks
        .filter(block => /Web Development|Infrastructure|Integration/.test(block.text))
        .map(block => block.text);
      assert(skillLines.length === 3
        && skillLines[1] === 'Infrastructure & Docker Compose · Kubernetes · MCP'
        && skillLines[2] === 'Integration',
      `fixture must retain the real wrapped-label extraction order, got ${JSON.stringify(skillLines)}`);
      const unchanged = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(unchanged.success && unchanged.status === 'unchanged' && !unchanged.changed,
        `a faithfully rendered wrapped Skills label must reconcile unchanged, got ${JSON.stringify(unchanged)}`);
      return { skillLines, status: unchanged.status };
    },
  },
  {
    // When the baseline gap exceeds the visual-line tolerance, pdf.js emits a
    // right-column value block before its own left-column <dt>. This is not a
    // user edit, but it cannot be repaired by the normal row-line parser.
    name: 'Application PDF reconcile: separated Skills cells restore only an exact token match',
    run: async () => {
      const source = resumeWorkspace('Maya builds systems safely.');
      const lines = [
        { text: 'Maya Chen', y: 700 },
        { text: 'E X P E R I E N C E', y: 670 },
        { text: '• Maya builds systems safely.', y: 640 },
        { text: 'S K I L L S', y: 600 },
        // The 5pt baseline separation is deliberately greater than the
        // grouping tolerance, leaving each cell as its own PDF text block.
        { text: 'Python · TypeScript', x: 180, y: 575 },
        { text: 'Languages', x: 56, y: 570 },
        { text: 'MCP · ETL', x: 180, y: 545 },
        { text: 'AI & Data', x: 56, y: 540 },
      ];
      const blocks = await extractPdfTextBlocks(await textPdf(lines));
      const separated = blocks.filter(block => /Languages|Python|AI & Data|MCP/.test(block.text)).map(block => block.text);
      assert(separated[0] === 'Python · TypeScript' && separated[1] === 'Languages',
        `fixture must keep the inverted column order, got ${JSON.stringify(separated)}`);
      const unchanged = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks });
      assert(unchanged.success && unchanged.status === 'unchanged' && !unchanged.changed,
        `an exact separated-cell PDF must reconcile unchanged, got ${JSON.stringify(unchanged)}`);

      const missingBlocks = await extractPdfTextBlocks(await textPdf(lines.map(line => (
        line.text === 'MCP · ETL' ? { ...line, text: 'ETL' } : line
      ))));
      const missing = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: missingBlocks });
      assert(!missing.success && missing.status === 'conflict' && missing.html === source,
        `a separated-cell PDF missing one token must remain a conflict, got ${JSON.stringify(missing)}`);

      const caseChangedBlocks = await extractPdfTextBlocks(await textPdf(lines.map(line => (
        line.text === 'Python · TypeScript' ? { ...line, text: 'python · TypeScript' } : line
      ))));
      const caseChanged = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: caseChangedBlocks });
      assert(!caseChanged.success && caseChanged.status === 'conflict' && caseChanged.html === source,
        `a separated-cell PDF with a case-only edit must remain a conflict, got ${JSON.stringify(caseChanged)}`);

      const reorderedBlocks = await extractPdfTextBlocks(await textPdf(lines.map(line => (
        line.text === 'Python · TypeScript' ? { ...line, text: 'TypeScript · Python' } : line
      ))));
      const reordered = reconcileApplicationHtmlFromPdfBlocks({ html: source, documentKind: 'resume', blocks: reorderedBlocks });
      assert(!reordered.success && reordered.status === 'conflict' && reordered.html === source,
        `a separated-cell PDF with a same-token reorder must remain a conflict, got ${JSON.stringify(reordered)}`);
      return {
        separated,
        unchanged: unchanged.status,
        missing: missing.status,
        caseChanged: caseChanged.status,
        reordered: reordered.status,
      };
    },
  },
  {
    name: 'Application PDF reconcile: wrapped left role header restores exact two-column reading order',
    run: () => {
      const html = '<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page"><h1 class="name">Maya Chen</h1><section class="section"><div class="section-head"><h2>Experience</h2></div><div class="role-header meta-row"><p class="role-title-line"><span class="title">Engineer</span><span class="sep">·</span><span class="company">North Valley Research Cooperative</span></p><p class="role-dates">2021 – 2023<span class="sep">·</span>Ottawa</p></div><ul><li>Built reliable tools.</li></ul></section></main></section></body></html>';
      const head = [
        { page: 1, x: 56, y: 700, text: 'Maya Chen' },
        { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
      ];
      const first = {
        page: 1, x: 56, y: 640, height: 11,
        items: [
          { x: 56, width: 44, text: 'Engineer' },
          { x: 104, width: 4, text: '·' },
          { x: 112, width: 103, text: 'North Valley Research' },
          { x: 350, width: 100, text: '2021 – 2023 · Ottawa' },
        ],
        text: 'Engineer · North Valley Research 2021 – 2023 · Ottawa',
      };
      const continuation = { page: 1, x: 56, y: 624, height: 11, items: [{ x: 56, width: 65, text: 'Cooperative' }], text: 'Cooperative' };
      const blocks = [...head, first, continuation, { page: 1, x: 56, y: 595, text: '• Built reliable tools.' }];
      const unchanged = reconcileApplicationHtmlFromPdfBlocks({ html, documentKind: 'resume', blocks });
      assert(unchanged.success && unchanged.status === 'unchanged',
        `an exact wrapped role header must reconcile unchanged, got ${JSON.stringify(unchanged)}`);
      for (const changed of [
        { ...continuation, text: 'Foundation', items: [{ x: 56, width: 65, text: 'Foundation' }] },
        { ...continuation, text: 'Cooperative', x: 350, items: [{ x: 350, width: 65, text: 'Cooperative' }] },
      ]) {
        const mismatch = reconcileApplicationHtmlFromPdfBlocks({ html, documentKind: 'resume', blocks: [...head, first, changed, blocks.at(-1)] });
        assert(!mismatch.success && mismatch.status === 'conflict' && mismatch.html === html,
          `altered or wrong-column company continuation must conflict, got ${JSON.stringify(mismatch)}`);
      }
      return { unchanged: unchanged.status, sabotage: 2 };
    },
  },
  {
    // The 2026-09-23 save failure reported only "inserted or removed text",
    // which named neither where the alignment broke nor which of the two very
    // different causes it was. Text the PDF genuinely gained or lost is a
    // document problem; the same words in a different order is an extraction
    // reading-order problem. They have opposite repairs.
    name: 'Application PDF reconcile: an alignment conflict names its location and distinguishes lost text from lost order',
    run: () => {
      const html = '<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page"><h1 class="name">Maya Chen</h1><section class="section"><div class="section-head"><h2>Experience</h2></div><p class="role-summary">Maya builds systems safely.</p></section></main></section></body></html>';
      const head = [
        { page: 1, x: 56, y: 700, text: 'Maya Chen' },
        { page: 1, x: 56, y: 670, text: 'E X P E R I E N C E' },
      ];
      const inserted = reconcileApplicationHtmlFromPdfBlocks({
        html,
        documentKind: 'resume',
        blocks: [...head, { page: 1, x: 56, y: 640, text: 'Maya builds durable resilient systems safely.' }],
      });
      assert(inserted.status === 'conflict'
        && /first divergence is in the Experience section, <p class="role-summary">/.test(inserted.error)
        && /PDF holds 9 token\(s\) against the document's 7/.test(inserted.error),
      `a genuine insertion must report its location and both token counts, got ${JSON.stringify(inserted.error)}`);
      const reordered = reconcileApplicationHtmlFromPdfBlocks({
        html,
        documentKind: 'resume',
        blocks: [...head, { page: 1, x: 56, y: 640, text: 'systems builds Maya safely.' }],
      });
      assert(reordered.status === 'conflict'
        && /first divergence is in the Experience section/.test(reordered.error)
        && /same words in a different order/.test(reordered.error),
      `an order-only divergence must be named as one, got ${JSON.stringify(reordered.error)}`);
      // The reason reaches the responding model through fit-feedback.json, so
      // it must not quote the résumé's own words back at it.
      assert(!/durable|resilient|builds/.test(inserted.error) && !/builds|systems/.test(reordered.error),
        `a conflict reason must not quote document text, got ${JSON.stringify([inserted.error, reordered.error])}`);
      return { insertion: inserted.error, reorder: reordered.error };
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
  {
    name: 'Application PDF reconcile: an imported cover edit re-binds Generation Audit.json in the same transaction',
    run: async () => {
      const bundle = await auditedReconcileBundle({ tokenDigit: '1' });
      try {
        assert(await bundle.status() === 'verified', 'precondition: the freshly saved bundle verifies');
        const changedCover = await textPdf(auditCoverLines('Maya ships reliable systems.'));
        await bundle.write('Cover Letter.pdf', changedCover);
        const { result, warnings } = await withCapturedWarnings(() => bundle.reconcile());
        assert(result.importedDocuments.join() === 'cover', `the cover edit must import, got ${JSON.stringify(result)}`);
        assert(warnings.length === 0, `a supported receipt must refresh silently, got ${JSON.stringify(warnings)}`);
        const html = await bundle.read('Application.html');
        assert(html.includes('Maya ships reliable systems.'), 'the cover text must be imported into Application.html');
        const audit = await bundle.readAudit();
        assert(audit.savedArtifacts.applicationHtmlSha256 === auditDigest(html),
          'savedArtifacts.applicationHtmlSha256 must follow the rewritten Application.html');
        assert(audit.savedArtifacts.coverLetterPdfSha256 === auditDigest(changedCover),
          'savedArtifacts.coverLetterPdfSha256 must follow the adopted cover PDF');
        assert(audit.savedArtifacts.resumePdfSha256 === auditDigest(bundle.resumePdf)
          && audit.savedArtifacts.originalJobListingSha256 === bundle.audit.savedArtifacts.originalJobListingSha256,
        'the untouched resume PDF and listing fingerprints must not move');
        assert(JSON.stringify(audit.finalArtifacts) === JSON.stringify(bundle.audit.finalArtifacts)
          && audit.jobId === bundle.audit.jobId && audit.createdAt === bundle.audit.createdAt,
        'producer provenance (finalArtifacts, jobId, createdAt) must never be rewritten by a reconcile');
        assert(await bundle.status() === 'verified', 'the reconciled bundle must still verify against its receipt');

        const auditBytes = await bundle.read('Generation Audit.json');
        const htmlBytes = await bundle.read('Application.html');
        const again = await bundle.reconcile();
        assert(again.importedDocuments.length === 0
          && await bundle.read('Generation Audit.json') === auditBytes
          && await bundle.read('Application.html') === htmlBytes,
        'a second open must be a byte-for-byte no-op');
        return { verified: true };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: importing both edited PDFs re-binds every adopted document in one audit write',
    run: async () => {
      const bundle = await auditedReconcileBundle({ tokenDigit: '2' });
      try {
        const changedResume = await textPdf(AUDIT_RESUME_LINES('Maya Chen Resume refreshed.'));
        const changedCover = await textPdf(auditCoverLines('Maya ships reliable systems.'));
        await bundle.write('Resume.pdf', changedResume);
        await bundle.write('Cover Letter.pdf', changedCover);
        const result = await bundle.reconcile();
        assert(result.importedDocuments.join() === 'resume,cover' && result.conflicts.length === 0,
          `both edited PDFs must import, got ${JSON.stringify(result)}`);
        const audit = await bundle.readAudit();
        assert(audit.savedArtifacts.applicationHtmlSha256 === auditDigest(await bundle.read('Application.html'))
          && audit.savedArtifacts.resumePdfSha256 === auditDigest(changedResume)
          && audit.savedArtifacts.coverLetterPdfSha256 === auditDigest(changedCover),
        `the html, resume and cover fingerprints must all follow the import, got ${JSON.stringify(audit.savedArtifacts)}`);
        assert(await bundle.status() === 'verified', 'a bundle with both documents adopted must verify');
        return { verified: true };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: a shared paper-variant import re-binds only the HTML fingerprint',
    run: async () => {
      const bundle = await auditedReconcileBundle({ dual: true, tokenDigit: '4' });
      try {
        assert(await bundle.status() === 'verified', 'precondition: the freshly saved bundle verifies');
        const result = await bundle.reconcile();
        assert(result.importedDocuments.join() === 'resume,cover', `the shared variant must import, got ${JSON.stringify(result)}`);
        const audit = await bundle.readAudit();
        assert(audit.savedArtifacts.applicationHtmlSha256 === auditDigest(await bundle.read('Application.html')),
          'a variant-only rewrite must refresh applicationHtmlSha256');
        assert(audit.savedArtifacts.resumePdfSha256 === auditDigest(bundle.resumePdf)
          && audit.savedArtifacts.coverLetterPdfSha256 === auditDigest(bundle.coverPdf),
        'the PDFs were not rewritten, so their fingerprints must be untouched');
        assert(await bundle.status() === 'verified', 'the variant import must keep the bundle verified');
        return { verified: true };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: a variant-mismatched PDF is never re-bound into the audit',
    run: async () => {
      const bundle = await auditedReconcileBundle({ tokenDigit: '5' });
      try {
        const changedResume = await textPdf(AUDIT_RESUME_LINES('Maya Chen Resume refreshed.'));
        const dualCover = await applyDualPdf(await textPdf(auditCoverLines('Maya ships reliable systems.')));
        await bundle.write('Resume.pdf', changedResume);
        await bundle.write('Cover Letter.pdf', dualCover);
        const result = await bundle.reconcile();
        assert(result.importedDocuments.includes('resume') && result.variantMismatches.length === 1
          && result.variantMismatches[0].document === 'cover',
        `the cover must be reported as a paper-variant mismatch, got ${JSON.stringify(result)}`);
        const audit = await bundle.readAudit();
        assert(audit.savedArtifacts.resumePdfSha256 === auditDigest(changedResume),
          'the certified resume pair must be re-bound');
        assert(audit.savedArtifacts.coverLetterPdfSha256 === bundle.audit.savedArtifacts.coverLetterPdfSha256
          && audit.savedArtifacts.coverLetterPdfSha256 !== auditDigest(dualCover),
        'a cover PDF whose paper variant disagrees with the HTML was not certified and must not be blessed');
        assert(audit.savedArtifacts.applicationHtmlSha256 === auditDigest(await bundle.read('Application.html')),
          'the rewritten Application.html is still re-bound');
        assert(await bundle.status() === 'hash-mismatch',
          'the uncertified cover PDF must keep the bundle honestly unverified');
        return { uncertified: 'cover' };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: a held conflict leaves Generation Audit.json untouched',
    run: async () => {
      const bundle = await auditedReconcileBundle({ tokenDigit: '6' });
      try {
        await bundle.write('Cover Letter.pdf', await textPdf(auditCoverLines('Maya ships reliable systems.')));
        const edited = (await bundle.read('Application.html')).replace('Maya builds reliable systems.', 'Maya builds robust systems.');
        await bundle.write('Application.html', edited);
        const auditBefore = await bundle.read('Generation Audit.json');
        const result = await bundle.reconcile();
        assert(result.conflicts.length === 1 && result.importedDocuments.length === 0,
          `both-sides-changed must be held as a conflict, got ${JSON.stringify(result)}`);
        assert(await bundle.read('Application.html') === edited, 'a held conflict must not rewrite Application.html');
        assert(await bundle.read('Generation Audit.json') === auditBefore, 'a held conflict must leave the receipt byte-identical');
        assert(await bundle.status() === 'hash-mismatch', 'the bundle stays honestly unverified');
        return { held: true };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: an unsupported receipt is skipped with a warning and the PDF text still imports',
    run: async () => {
      const unsupported = [
        '{not json',
        JSON.stringify({ version: 1, schema: 'infinite-canvas-generation-audit', jobId: 'job-1', savedArtifacts: {}, finalArtifacts: {} }),
      ];
      for (const [index, auditText] of unsupported.entries()) {
        const bundle = await auditedReconcileBundle({ auditText, tokenDigit: String(7 + index) });
        try {
          await bundle.write('Cover Letter.pdf', await textPdf(auditCoverLines('Maya ships reliable systems.')));
          const { result, warnings } = await withCapturedWarnings(() => bundle.reconcile());
          assert(result.importedDocuments.join() === 'cover'
            && (await bundle.read('Application.html')).includes('Maya ships reliable systems.'),
          `the PDF text must still import past an unsupported receipt, got ${JSON.stringify(result)}`);
          assert(await bundle.read('Generation Audit.json') === auditText,
            'an unsupported receipt must be left byte-for-byte untouched');
          assert(warnings.some(line => line.includes('Generation Audit.json left unchanged during PDF reconciliation')),
            `the skipped refresh must be logged, got ${JSON.stringify(warnings)}`);
        } finally { await bundle.cleanup(); }
      }
      return { skipped: unsupported.length };
    },
  },
  {
    name: 'Application PDF reconcile: a receipt that no longer matches the stored HTML is not re-bound',
    run: async () => {
      const bundle = await auditedReconcileBundle({ tokenDigit: 'a' });
      try {
        // A hand edit outside every document panel: no panel fingerprint moves, so
        // the open-time reconcile still treats the cover PDF edit as importable.
        const handEdited = (await bundle.read('Application.html')).replace('</body>', '<!-- hand edit --></body>');
        assert(handEdited !== await bundle.read('Application.html'), 'test setup: the hand edit must change the file');
        await bundle.write('Application.html', handEdited);
        assert(await bundle.status() === 'hash-mismatch', 'precondition: the receipt already disagrees with the HTML');
        await bundle.write('Cover Letter.pdf', await textPdf(auditCoverLines('Maya ships reliable systems.')));
        const auditBefore = await bundle.read('Generation Audit.json');
        const { result, warnings } = await withCapturedWarnings(() => bundle.reconcile());
        const html = await bundle.read('Application.html');
        assert(result.importedDocuments.join() === 'cover' && html.includes('Maya ships reliable systems.')
          && html.includes('<!-- hand edit -->'),
        `the PDF text still imports and the hand edit survives, got ${JSON.stringify(result)}`);
        assert(await bundle.read('Generation Audit.json') === auditBefore,
          'the reconcile must not bless an Application.html that was never reviewed against the receipt');
        assert(await bundle.status() === 'hash-mismatch', 'the honest hash-mismatch must remain');
        assert(warnings.some(line => line.includes('does not match the stored Application.html')),
          `the preserved mismatch must be logged, got ${JSON.stringify(warnings)}`);
        return { preserved: true };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: a legacy bundle without a Generation Audit still imports and invents no receipt',
    run: async () => {
      const bundle = await auditedReconcileBundle({ auditText: '', tokenDigit: 'b' });
      try {
        await bundle.write('Cover Letter.pdf', await textPdf(auditCoverLines('Maya ships reliable systems.')));
        const result = await bundle.reconcile();
        assert(result.importedDocuments.join() === 'cover', `the legacy import must still work, got ${JSON.stringify(result)}`);
        assert(!fs.existsSync(path.join(bundle.root, 'Generation Audit.json')), 'a reconcile must never invent a receipt');
        assert(await bundle.status() === 'legacy-unverified', 'the legacy bundle stays legacy-unverified');
        return { legacy: true };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: an unreadable Generation Audit.json fails closed before anything is written',
    run: async () => {
      const bundle = await auditedReconcileBundle({ tokenDigit: 'c' });
      try {
        // A receipt that is a symlink is not a safe regular file; Sync refuses it
        // with a 409 and so must the reconcile rather than treat it as absent.
        await fs.promises.rename(path.join(bundle.root, 'Generation Audit.json'), path.join(bundle.root, 'real-audit.json'));
        await fs.promises.symlink('real-audit.json', path.join(bundle.root, 'Generation Audit.json'));
        await bundle.write('Cover Letter.pdf', await textPdf(auditCoverLines('Maya ships reliable systems.')));
        const htmlBefore = await bundle.read('Application.html');
        const failure = await bundle.reconcile().then(() => null, error => error);
        assert(failure && failure.statusCode === 409 && /Generation Audit\.json could not be read/.test(failure.message),
          `an unreadable receipt must fail closed with a 409, got ${failure && `${failure.statusCode} ${failure.message}`}`);
        assert(await bundle.read('Application.html') === htmlBefore, 'a refused reconcile must not rewrite Application.html');
        return { failedClosed: true };
      } finally { await bundle.cleanup(); }
    },
  },
  {
    name: 'Application PDF reconcile: the audit refresh helper binds exactly the named PDFs and keeps the single-PDF form',
    run: () => {
      const hash = fill => fill.repeat(64);
      const receipt = `${JSON.stringify({
        version: 1,
        schema: 'infinite-canvas-generation-audit',
        jobId: 'job-1',
        finalArtifacts: {
          resultSha256: hash('a'), resumeContentSha256: hash('a'), coverLetterContentSha256: hash('a'),
          stagedApplicationHtmlSha256: hash('a'), resumePdfSha256: hash('a'), coverLetterPdfSha256: hash('a'),
          originalJobListingSha256: hash('a'),
        },
        savedArtifacts: {
          applicationHtmlSha256: hash('d'), resumePdfSha256: hash('d'), coverLetterPdfSha256: hash('d'),
          originalJobListingSha256: hash('d'),
        },
      }, null, 2)}\n`;
      const html = '<html>next</html>';
      const resume = Buffer.from('%PDF-resume');
      const cover = Buffer.from('%PDF-cover');
      const saved = text => JSON.parse(text).savedArtifacts;

      const both = saved(__withSyncedGenerationAuditSavedArtifactsForTests(receipt, { applicationHtml: html, pdfs: { resume, cover } }));
      assert(both.applicationHtmlSha256 === auditDigest(html) && both.resumePdfSha256 === auditDigest(resume)
        && both.coverLetterPdfSha256 === auditDigest(cover), 'pdfs must bind every named document');

      const onlyCover = saved(__withSyncedGenerationAuditSavedArtifactsForTests(receipt, { applicationHtml: html, pdfs: { cover } }));
      assert(onlyCover.coverLetterPdfSha256 === auditDigest(cover) && onlyCover.resumePdfSha256 === hash('d'),
        'a document absent from pdfs must keep its existing fingerprint');

      const none = saved(__withSyncedGenerationAuditSavedArtifactsForTests(receipt, { applicationHtml: html, pdfs: {} }));
      assert(none.applicationHtmlSha256 === auditDigest(html) && none.resumePdfSha256 === hash('d')
        && none.coverLetterPdfSha256 === hash('d'), 'an empty pdfs map re-binds only the HTML');

      const single = saved(__withSyncedGenerationAuditSavedArtifactsForTests(receipt, { applicationHtml: html, pdf: resume, documentKind: 'resume' }));
      assert(single.resumePdfSha256 === auditDigest(resume) && single.coverLetterPdfSha256 === hash('d'),
        'the original { pdf, documentKind } form must keep working');

      for (const options of [
        { applicationHtml: html, pdf: resume, documentKind: 'listing' },
        { applicationHtml: html, pdfs: { listing: resume } },
      ]) {
        let message = '';
        try { __withSyncedGenerationAuditSavedArtifactsForTests(receipt, options); } catch (error) { message = error.message; }
        assert(message === 'Application Sync received an invalid audit document kind.',
          `an unknown document kind must keep the existing error, got ${JSON.stringify(message)}`);
      }
      return { bound: true };
    },
  },
  {
    name: 'Application PDF reconcile: an external edit to Generation Audit.json while the reconcile commits is never overwritten',
    run: async () => {
      const bundle = await auditedReconcileBundle({ tokenDigit: '9' });
      const realLstat = fs.promises.lstat;
      try {
        await bundle.write('Cover Letter.pdf', await textPdf(auditCoverLines('Maya ships reliable systems.')));
        const htmlBefore = await bundle.read('Application.html');
        const auditPath = path.join(bundle.root, 'Generation Audit.json');
        const auditBefore = await bundle.read('Generation Audit.json');
        const external = auditBefore.replace('"version": 1', '"version": 1,\n  "note": "edited externally"');
        assert(external !== auditBefore, 'setup: the external edit must change the receipt');
        // Land the external edit after the reconcile read the receipt and before its
        // transaction first touches it: the commit must notice and refuse.
        let injected = 0;
        fs.promises.lstat = async function lstatWithRace(target, ...rest) {
          if (String(target) === auditPath && String(new Error().stack).includes('applicationFileTransaction')) {
            injected += 1;
            fs.writeFileSync(auditPath, external);
          }
          return realLstat.call(this, target, ...rest);
        };
        let failure = null;
        try { await bundle.reconcile(); } catch (error) { failure = error; } finally { fs.promises.lstat = realLstat; }
        assert(injected > 0, 'setup: the external edit must have landed inside the transaction');
        assert(failure, 'a receipt that changed under the commit must fail the reconcile instead of being overwritten');
        assert(await bundle.read('Application.html') === htmlBefore, 'the failed transaction must restore Application.html');
        assert(await bundle.read('Generation Audit.json') === external, 'the external receipt edit must be kept byte for byte');
        // With no race the next open succeeds against the externally edited receipt.
        const retry = await bundle.reconcile();
        assert(retry.importedDocuments.join() === 'cover' && (await bundle.read('Generation Audit.json')).includes('edited externally'), 'a later open re-binds the edited receipt without dropping the edit');
        assert(await bundle.status() === 'verified', 'and the bundle verifies again');
        return { guarded: true };
      } finally { fs.promises.lstat = realLstat; await bundle.cleanup(); }
    },
  },
];
