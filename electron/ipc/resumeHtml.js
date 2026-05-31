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
 * Build the cover-letter document deterministically from structured fields, so
 * the layout is always on-brand (unlike the résumé, whose rich structure the
 * model fills directly). Reuses the design tokens + `.resume-header` for the
 * letterhead, plus a small inline letter-body stylesheet. `variantAttrs` mirrors
 * the résumé's print variant.
 */
export function buildCoverLetterDocument(letter = {}, variantAttrs = '') {
  const name     = escapeHtml(letter.name || '');
  const tagline  = escapeHtml(letter.tagline || '');
  const contacts = Array.isArray(letter.contact) ? letter.contact : [];
  const contactHtml = contacts
    .filter(Boolean)
    .map(escapeHtml)
    .join('<span class="sep" aria-hidden="true">·</span>\n    ');
  const date        = escapeHtml(letter.date || '');
  const recipient   = escapeHtml(letter.recipient || '');
  const salutation  = escapeHtml(letter.salutation || 'Dear Hiring Team,');
  const paragraphs  = (Array.isArray(letter.paragraphs) ? letter.paragraphs : [])
    .filter(p => String(p || '').trim())
    .map(p => `      <p>${escapeHtml(p)}</p>`)
    .join('\n');
  const closing     = escapeHtml(letter.closing || 'Sincerely,');

  return `<!doctype html>
<html lang="en" ${variantAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="colors_and_type.css">
<link rel="stylesheet" href="resume.css">
<style>
  .letter { font-size: var(--fs-body); color: var(--ink-body); line-height: var(--lh-body); margin-top: var(--s-9); }
  .letter-date      { color: var(--ink-meta); font-size: var(--fs-small); margin: 0 0 var(--s-6); }
  .letter-recipient { color: var(--ink-meta); font-size: var(--fs-small); white-space: pre-line; margin: 0 0 var(--s-6); }
  .letter-salutation { margin: 0 0 var(--s-4); }
  .letter p { margin: 0 0 var(--s-4); }
  .letter-close { margin: var(--s-6) 0 var(--s-1); }
  .letter-sign  { font-weight: var(--fw-semibold); color: var(--ink-body); }
</style>
</head>
<body>
<main class="page" role="document">
  <header class="resume-header">
    <h1 class="name">${name}</h1>
    ${tagline ? `<p class="tagline">${tagline}</p>` : ''}
    ${contactHtml ? `<p class="contact" role="group" aria-label="Contact">${contactHtml}</p>` : ''}
  </header>
  <div class="letter">
    ${date ? `<p class="letter-date">${date}</p>` : ''}
    ${recipient ? `<p class="letter-recipient">${recipient}</p>` : ''}
    <p class="letter-salutation">${salutation}</p>
${paragraphs}
    <p class="letter-close">${closing}</p>
    <p class="letter-sign">${name}</p>
  </div>
</main>
</body>
</html>`;
}
