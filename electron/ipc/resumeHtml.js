/**
 * Pure HTML builders for the job-application generator. Kept free of any
 * electron / puppeteer / fs imports so they're trivially unit-testable and can
 * be reused by the renderer (resumePdf.js) without dragging runtime deps into a
 * test process.
 *
 * The résumé is filled by the model as a `<main class="page">` block (the design
 * system is "agent fills the markup"); we own only the document scaffold. The
 * cover letter is built deterministically from structured fields so its layout
 * is always on-brand.
 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Decode ESCAPE SEQUENCES the model sometimes emits as literal two-character text
 * — a backslash followed by n / r / t — instead of the whitespace they denote.
 * It's nudged toward this by prompts that mention "a literal \n" (the recipient
 * block), and a JSON round-trip can also leave a double-escaped "\\n" → literal
 * "\n". Since escapeHtml never touches backslashes, those surface VERBATIM in the
 * rendered PDF as "\n" / "\t". Decode the whitespace escapes to the real chars so
 * HTML collapses/breaks them correctly. Matches ONLY the literal 2-char sequences,
 * so it's a no-op on already-correct content (real newlines/tabs are untouched).
 */
export function decodeTextEscapes(s) {
  return String(s ?? '')
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\\t/g, '\t');
}

/**
 * Resolve the canonical variant attributes from the résumé model's output (it
 * sets them on its `<main class="page" …>`), so BOTH documents share one print
 * variant / paper / mono treatment.
 *
 * Print mode follows the design system: the default is `dual-pdf` (warm cream on
 * screen, background auto-removed when printed via the OCG layer added in
 * post-processing). Only an explicit `ink-only` opts out (flat white for ATS
 * pipelines). The attributes are placed on `<html>` (the design system's
 * canonical placement) by the document builders below.
 */
export function extractVariantAttrs(resumeMainHtml) {
  const html = String(resumeMainHtml || '');
  const mode = /data-print\s*=\s*"ink-only"/i.test(html) ? 'ink-only' : 'dual-pdf';
  const out = [`data-print="${mode}"`];
  if (/\bdata-mono\b/i.test(html)) out.push('data-mono');
  if (/data-page\s*=\s*"a4"/i.test(html)) out.push('data-page="a4"');
  return out.join(' ');
}

/**
 * True when the variant is dual-pdf — the renderer must then post-process the
 * (background-less) PDF with the design system's `addOcgBackground` to add the
 * view-only cream layer. ink-only renders flat white and skips that step.
 */
export function isDualMode(variantAttrs) {
  return /data-print="dual-pdf"/.test(String(variantAttrs || ''));
}

/**
 * Normalize the résumé model's output into a full HTML document. The model
 * returns just the `<main class="page" …>…</main>` block; we own the scaffold
 * (charset, the two design-system stylesheet links, the variant on `<html>`) so
 * the styling can never break regardless of what `<head>` the model emitted.
 */
export function buildResumeDocument(resumeMainHtml, variantAttrs) {
  let main = String(resumeMainHtml || '').trim();
  // Defensive: if the model wrapped its answer in a full document or fences,
  // extract just the <main> block.
  const fence = /```(?:html)?\s*([\s\S]*?)\s*```/i.exec(main);
  if (fence) main = fence[1].trim();
  const mainMatch = /<main[\s\S]*<\/main>/i.exec(main);
  if (mainMatch) main = mainMatch[0];
  // Decode any literal "\n"/"\t" the model left in the markup so they collapse as
  // HTML whitespace instead of printing verbatim (real newlines are untouched).
  main = decodeTextEscapes(main);
  const attrs = variantAttrs != null ? variantAttrs : extractVariantAttrs(resumeMainHtml);
  return `<!doctype html>
<html lang="en" ${attrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="colors_and_type.css">
<link rel="stylesheet" href="resume.css">
</head>
<body>
${main}
</body>
</html>`;
}

/**
 * Build the cover-letter document from structured fields using the design
 * system's NATIVE cover-letter surface (`cover-letter.html` / `cover-letter.css`):
 * the same `.resume-header` letterhead as the résumé, a hairline rule, the
 * date+recipient `.letter-meta` block, the Source-Serif `.letter-body`, and the
 * `.letter-close` signature block. We own only field substitution — the
 * typography, spacing, and the serif-body voice come straight from the design
 * system's stylesheets (no guessed inline CSS). `variantAttrs` mirrors the
 * résumé's print variant so the pair renders as one set.
 *
 * @param {object} letter
 *   { name, tagline, contact[], date, recipient (\n-separated lines),
 *     salutation, paragraphs[], closing, signatureTitle }
 */
export function buildCoverLetterDocument(letter = {}, variantAttrs = '') {
  // Every field is decodeTextEscapes()'d before escaping so a literal "\n"/"\t"
  // the model emitted renders as real whitespace, not verbatim text.
  const name     = escapeHtml(decodeTextEscapes(letter.name || ''));
  const tagline  = escapeHtml(decodeTextEscapes(letter.tagline || ''));
  const contacts = Array.isArray(letter.contact) ? letter.contact : [];
  const contactHtml = contacts
    .filter(Boolean)
    .map(c => escapeHtml(decodeTextEscapes(c)))
    .join('\n      <span class="sep" aria-hidden="true">·</span>\n      ');

  const date       = escapeHtml(decodeTextEscapes(letter.date || ''));
  // The design system renders the recipient as a block: the first line is the
  // addressee (.recipient-name, set bolder), the rest are .recipient-line rows.
  // The schema delivers the block as a single \n-separated string — decode first
  // so a literal "\n" (real OR double-escaped) splits into rows correctly.
  const recipientLines = decodeTextEscapes(letter.recipient || '').split('\n').map(l => l.trim()).filter(Boolean);
  const recipientHtml = recipientLines
    .map((line, i) => i === 0
      ? `<span class="recipient-name">${escapeHtml(line)}</span>`
      : `<span class="recipient-line">${escapeHtml(line)}</span>`)
    .join('\n      ');

  const salutation = escapeHtml(decodeTextEscapes(letter.salutation || 'Dear Hiring Team,'));
  const paragraphs = (Array.isArray(letter.paragraphs) ? letter.paragraphs : [])
    .filter(p => String(p || '').trim())
    // Decode escapes, then escape HTML. A newline WITHIN a paragraph is left as-is
    // so HTML collapses it to a space — cover-letter paragraphs are flowing prose
    // with no intended hard breaks (paragraph breaks come from the array). Do NOT
    // convert to <br>: the model sometimes drops a stray newline mid-sentence
    // (e.g. around a job title's en-dash), and a <br> there is a visible bad break.
    .map(p => `    <p>${escapeHtml(decodeTextEscapes(p))}</p>`)
    .join('\n');
  const closing        = escapeHtml(decodeTextEscapes(letter.closing || 'Sincerely,'));
  const signatureTitle = escapeHtml(decodeTextEscapes(letter.signatureTitle || ''));

  return `<!doctype html>
<html lang="en" ${variantAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="colors_and_type.css">
<link rel="stylesheet" href="resume.css">
<link rel="stylesheet" href="cover-letter.css">
</head>
<body>
<main class="page" role="document" itemscope itemtype="https://schema.org/Person">
  <header class="resume-header letter-letterhead">
    <h1 class="name" itemprop="name">${name}</h1>
    ${tagline ? `<p class="tagline" itemprop="jobTitle">${tagline}</p>` : ''}
    ${contactHtml ? `<p class="contact" role="group" aria-label="Contact">
      ${contactHtml}
    </p>` : ''}
  </header>

  <hr class="letterhead-rule" aria-hidden="true">

  <div class="letter-meta">
    ${date ? `<p class="letter-date"><time>${date}</time></p>` : ''}
    ${recipientHtml ? `<address class="letter-recipient">
      ${recipientHtml}
    </address>` : ''}
  </div>

  <div class="letter-body">
    <p class="salutation">${salutation}</p>
${paragraphs}
  </div>

  <div class="letter-close">
    <p class="valediction">${closing}</p>
    <p class="signature" itemprop="name">${name}</p>
    ${signatureTitle ? `<p class="signature-title">${signatureTitle}</p>` : ''}
  </div>
</main>
</body>
</html>`;
}
