/**
 * Self-contained HTML builders for the job-application generator (résumé +
 * cover letter). Design doc: docs/resume-achievement-mining-design.md §5.
 *
 * HTML-FIRST, NOT PDF-FIRST (§5.1). PDF generation retired entirely — there
 * used to be a `resumePdf.js` that launched puppeteer-core against system
 * Chrome and post-processed the bytes with the design system's OCG cream
 * layer, because one PDF had to serve as both the screen artifact and the
 * print artifact. Now the browser tab IS the screen artifact: the design
 * system's own `@media print` rule (resume_design_system/colors_and_type.css
 * ~:394-409) already flips `--bg` to transparent on print, for free. The user
 * opens the file this module returns directly in Chrome and exports to PDF
 * via `window.print()` — see the injected chrome below. `resumePdf.js` is
 * DELETED; nothing in it survived the retirement (see this file's git log /
 * the phase report for the full accounting).
 *
 * Because the PDF path is gone, this module now owns the two coupling points
 * that used to live in resumePdf.js (design doc §9 reconnect-checklist rows
 * 1-2, migrated here): the `CSS_FILES` filename list and `getDesignSystemDir()`.
 * That pulls in `fs`/`path`/`electron` — this file is no longer dependency-
 * free the way it was when it only built HTML strings. That's fine under
 * `scripts/test-runner.js`: `getDesignSystemDir()` never actually needs a real
 * `app` object (it only reads `app.getAppPath`, guarded by `?.`), so it falls
 * through cleanly to `process.cwd()` + 'resume_design_system' under plain
 * Node, exactly as it already did when this logic lived in resumePdf.js.
 *
 * The résumé is filled by the model as a `<main class="page">` block (the
 * design system is "agent fills the markup"); we own the document scaffold,
 * the inlined design-system CSS, the injected `ic-` chrome, and the receipt
 * post-process. The cover letter is built deterministically from structured
 * fields so its layout is always on-brand.
 */
import fs from 'fs';
import path from 'path';
import electronPkg from 'electron';
import { logger } from '../logger.js';
import { ledgerById, derivationTooltip } from '../../src/utils/achievementLedger.js';

const { app } = electronPkg;

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
 * rendered document as "\n" / "\t". Decode the whitespace escapes to the real chars
 * so HTML collapses/breaks them correctly. Matches ONLY the literal 2-char
 * sequences, so it's a no-op on already-correct content (real newlines/tabs are
 * untouched).
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
 * screen, background transparent on print via the design system's own
 * `@media print` rule — no post-processing needed now that the artifact IS the
 * screen view). Only an explicit `ink-only` opts out (flat white for ATS
 * pipelines). The attributes are placed on `<html>` (the design system's
 * canonical placement) by the document builders below. Logic unchanged from
 * the PDF-era version (design doc §5.1: "extractVariantAttrs is unchanged") —
 * only this doc comment was updated to drop the stale OCG reference.
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
 * True when the variant is dual-pdf. Used to no longer gate an OCG
 * post-process (that pipeline retired with resumePdf.js) — instead it tailors
 * the injected print-hint copy (§5.4): the dual-pdf variant can truthfully
 * tell the user the warm background disappears automatically on print,
 * ink-only has no such background to explain away. Kept as an exported pure
 * function (unchanged logic) because scripts/test-runner.js already exercises
 * it directly.
 */
export function isDualMode(variantAttrs) {
  return /data-print="dual-pdf"/.test(String(variantAttrs || ''));
}

// ---------------------------------------------------------------------------
// Design-system coupling surface (migrated from resumePdf.js when the PDF
// path retired — design doc §9 reconnect-checklist rows 1-2). Read-only
// access to resume_design_system/; nothing in that folder is ever written.
// ---------------------------------------------------------------------------

// The design-system stylesheets this module inlines at build time. Résumé
// documents need only the first two (tokens + component styles); the cover
// letter also needs cover-letter.css for its letter-specific classes (it
// still borrows .resume-header/.letterhead-rule etc. from resume.css — see
// buildCoverLetterDocument below). Filename list migrated verbatim from
// resumePdf.js:70.
const CSS_FILES = ['colors_and_type.css', 'resume.css', 'cover-letter.css'];
const RESUME_CSS_FILES = CSS_FILES.slice(0, 2);

/**
 * Resolve `resume_design_system/`. In dev this is the repo root; in a packaged
 * build it must be asarUnpacked (plain `fs.readFileSync` can't read out of an
 * asar) — resolved off process.resourcesPath there. Fails loudly if absent
 * rather than silently emitting an unstyled document — migrated verbatim from
 * resumePdf.js:78-93 (design doc §9 reconnect-checklist row 2).
 */
export function getDesignSystemDir() {
  const candidates = [];
  try { if (app?.getAppPath) candidates.push(path.join(app.getAppPath(), 'resume_design_system')); } catch { /* not in electron */ }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'resume_design_system'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resume_design_system'));
  }
  candidates.push(path.join(process.cwd(), 'resume_design_system'));
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'resume.css'))) return dir;
  }
  throw new Error(
    `Résumé design system not found (looked in: ${candidates.join(', ')}). ` +
    `The 'resume_design_system' folder must ship with the app.`
  );
}

// Cache successful reads only (never cache a failure) — the design-system CSS
// doesn't change while the app is running, so re-reading three small text
// files on every application generation is pure waste; but if a file is
// genuinely missing we want the NEXT attempt to re-check disk (e.g. a dev
// mid-reconnect), not keep throwing from a stale cache entry that was never
// populated in the first place.
const _cssCache = new Map();
function readDesignCss(fileName) {
  if (_cssCache.has(fileName)) return _cssCache.get(fileName);
  // Deliberately NOT try/caught: a missing CSS file is a STRUCTURAL failure
  // (the output would be an unstyled document), so this must fail loudly —
  // the opposite of the rubric-injection asymmetry in jobApplication.js
  // (design doc §4.1 / §9's startup-assertion comment restates this same
  // asymmetry for the two checks below).
  const text = fs.readFileSync(path.join(getDesignSystemDir(), fileName), 'utf8');
  _cssCache.set(fileName, text);
  return text;
}

/** Concatenate the named design-system stylesheets into one inlinable string. */
function inlineStylesheets(fileNames) {
  return fileNames.map(readDesignCss).join('\n\n');
}

// ---------------------------------------------------------------------------
// Receipts (§4.3 step 3)
// ---------------------------------------------------------------------------

// Collapse embedded whitespace/newlines before the text goes into an HTML
// attribute value — derivationTooltip() joins already-single-line fields, but
// this is cheap insurance against a stray newline in model-sourced prose
// (career-data quotes, caveats) turning into an awkward literal line break
// inside the attribute.
function flattenForAttr(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve every `data-achievement-id="…"` the résumé model emitted against the
 * checked/refuted ledger, and write the tooltip text itself into a new
 * `data-derivation="…"` attribute. Any id that doesn't resolve (hallucinated,
 * or mining/refuting never ran for this hub) is STRIPPED along with its
 * underline styling hook — the CSS selector below keys off the attribute's
 * mere presence, so removing it removes the hook too; there is no separate
 * class to remember to strip alongside it (design doc §4.3, §9: "prefer
 * attributes over classes for hooks — data-derivation needs no re-wiring on a
 * [design-system] swap").
 *
 * This is the ENTIRE trust boundary for receipts: the model can name an id,
 * it cannot author the tooltip text that appears for it, and it cannot forge
 * a resolution for an id that isn't really in the ledger. An earlier design
 * had the model copy `derivation` prose verbatim and matched on the STRING —
 * rejected because a paraphrase or a normalized dash makes a CORRECT figure
 * lose its receipt silently. Do not reintroduce string matching here.
 *
 * @param {string} mainHtml   the model's <main> block, already fence/newline-normalized
 * @param {Array}  ledger     the hub's achievement ledger (or null/undefined)
 * @returns {string}
 */
function injectReceipts(mainHtml, ledger) {
  // Strip any data-derivation the model's raw <main> HTML already carries,
  // UNCONDITIONALLY and before anything else — this attribute must only ever
  // originate from this function (see the trust-boundary doc-comment above).
  // Two ways a model-authored one could otherwise survive:
  //   1. Paired with a real data-achievement-id: HTML's duplicate-attribute
  //      parsing rule keeps the FIRST occurrence of a repeated attribute name
  //      and silently drops later ones. The replace() below appends its own
  //      `data-derivation="<real text>"` AFTER whatever's already on the tag,
  //      so a model-emitted `data-derivation="…" data-achievement-id="a3"`
  //      would have the model's forged text win in a real browser (and thus
  //      in the exported PDF/HTML) instead of the ledger-derived one.
  //   2. Standalone, with no data-achievement-id at all: the CSS hover hook
  //      (`[data-derivation]:hover::after`, below) keys off the attribute's
  //      mere presence, so an un-paired forged attribute renders a tooltip
  //      even though the fast-path return right after this would otherwise
  //      never touch that element.
  // Stripped before the fast-path check specifically to cover case 2 — a tag
  // with a forged data-derivation but no data-achievement-id would skip the
  // rest of this function entirely if the check ran first.
  //
  // Matches all THREE HTML attribute-value quoting forms — double-quoted,
  // single-quoted, and unquoted — not just the double-quoted one. HTML
  // attributes are equally valid as data-derivation='forged' or
  // data-derivation=forged, and an LLM emitting free-form HTML reaches for
  // single quotes routinely (it's the more common quoting style in the
  // training distribution for inline JSX-adjacent markup). A strip that only
  // matched `"[^"]*"` would leave every single-/unquoted forged derivation
  // sitting on the tag, and the CSS hover hook below keys off the attribute's
  // MERE PRESENCE — so that surviving string still renders as a tooltip in
  // the browser and in the exported PDF, i.e. exactly the forgery this strip
  // exists to prevent. Half-closing this hole would be worse than not having
  // it at all: a double-quote-only strip reads as "covered" while the
  // single-quoted case stays wide open.
  let html = String(mainHtml || '').replace(/\sdata-derivation=(?:"[^"]*"|'[^']*'|[^\s>]*)/g, '');
  if (!/data-achievement-id\s*=/.test(html)) return html; // fast path: nothing to resolve

  const byId = ledgerById(Array.isArray(ledger) ? ledger : []);
  let resolved = 0;
  let stripped = 0;
  // Double-quote-only here, unlike the strip above, is deliberately NOT
  // widened to match all three quoting forms — this regex resolves ids
  // against the ledger, it doesn't gate a forgery. An id written in single-
  // or unquoted form (something the model would only do by producing
  // malformed markup, since the design system's own examples are always
  // double-quoted) simply fails to match here and the tag is left with
  // whatever data-achievement-id text it had — no data-derivation gets
  // attached, so no tooltip renders. That's the SAFE failure direction (no
  // receipt shown), the mirror image of the strip above where a missed match
  // is the UNSAFE direction (a forged receipt survives). Widening this one
  // would only add match surface for zero safety benefit.
  const out = html.replace(/\sdata-achievement-id="([^"]*)"/g, (_whole, rawId) => {
    const item = byId.get(rawId);
    const tooltip = item ? flattenForAttr(derivationTooltip(item)) : '';
    if (!tooltip) {
      stripped += 1;
      return ''; // unresolved id (or no ledger at all) → no receipt, no underline hook
    }
    resolved += 1;
    return ` data-achievement-id="${escapeHtml(rawId)}" data-derivation="${escapeHtml(tooltip)}"`;
  });

  if (stripped > 0) {
    logger.info(`[resumeHtml] receipts: resolved ${resolved}, stripped ${stripped} unresolved data-achievement-id (model hallucinated an id, or no ledger was available for this hub)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Injected chrome (§5.2-§5.5, §9) — namespaced `ic-` throughout so a wholesale
// design-system replacement can never collide with it. Everything here is
// `@media print { display: none }` (or otherwise print-neutral) — the printed
// artifact must be byte-identical in appearance to what the design system
// produces on its own, because that PDF is still what gets uploaded to
// employer portals (§5.2's single most important constraint).
// ---------------------------------------------------------------------------

const INJECTED_CHROME_CSS = `
/* ==========================================================
   Injected chrome (electron/ipc/resumeHtml.js) — NOT part of
   resume_design_system/. Namespaced ic- throughout. Every rule
   in this block is inert on print.
   ========================================================== */
.ic-toolbar {
  position: sticky;
  top: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 20px;
  background: #1A1815;
  color: #F7F4ED;
  font: 13px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif;
}
.ic-toolbar .ic-btn {
  font: inherit;
  padding: 5px 12px;
  border-radius: 3px;
  border: 1px solid rgba(247, 244, 237, 0.35);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.ic-toolbar .ic-btn:hover { background: rgba(247, 244, 237, 0.12); }
.ic-toolbar .ic-btn-primary { background: #7A1F2B; border-color: #7A1F2B; }
.ic-toolbar .ic-btn-primary:hover { background: #8F2534; }
.ic-toolbar .ic-hint { margin-left: auto; opacity: 0.8; font-size: 12px; }
.ic-toolbar .ic-restore-note { opacity: 0.8; font-size: 12px; }
.ic-banner {
  padding: 8px 20px;
  font: 13px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif;
}
.ic-font-warning { background: #FCEFC7; color: #6B4E00; border-bottom: 1px solid #E8CE84; }
@media print {
  .ic-toolbar, .ic-banner { display: none !important; }
}

/* ---- receipts (design doc §4.3) ----
   Attributes, not classes — data-achievement-id is written by the model
   (id only) and data-derivation is written by resumeHtml.js's post-process
   (tooltip text only); both survive a design-system swap untouched since
   nothing here is coupled to a resume_design_system/ class name. */
[data-achievement-id] {
  border-bottom: 1px dotted var(--ink-3, #8C857A);
  cursor: help;
}
[data-derivation] { position: relative; }
[data-derivation]:hover::after,
[data-derivation]:focus::after {
  content: attr(data-derivation);
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 2147483000;
  width: max-content;
  max-width: 320px;
  padding: 8px 10px;
  background: #1A1815;
  color: #F7F4ED;
  font: 11.5px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif;
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  white-space: normal;
}
@media print {
  [data-achievement-id] { border-bottom: none; cursor: auto; }
  [data-derivation]:hover::after,
  [data-derivation]:focus::after { content: none; }
}

/* ---- edit mode (design doc §5.5) ---- */
[contenteditable="true"] {
  outline: 1px dashed rgba(122, 31, 43, 0.5);
  outline-offset: 6px;
}
@media print {
  [contenteditable="true"] { outline: none; }
}
`;

// Safely embed a string inside an inline <script> as a JS string literal.
// JSON.stringify handles quoting/escaping; the extra \u003c/\u003e swap is
// defense-in-depth against a docId that happened to contain "</script>" —
// low-probability (docId is caller-generated, not scraped/model text) but
// free to guard against.
function jsStringLiteral(s) {
  return JSON.stringify(String(s ?? '')).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * Build the toolbar/banner markup + behavior script injected into `<body>`.
 *
 * Edit mode (§5.5): `resume_design_system/readme.md:15-19` documents the
 * OPPOSITE intent — "No human interactive surface. No editor." That doc is
 * design-owned and must not be edited, so the divergence is recorded HERE
 * instead: once PDF generation retired, the shipped artifact IS the file the
 * user opens and prints from, and a résumé with one wrong date shouldn't
 * require regenerating through the whole pipeline to fix. `contenteditable`
 * on `<main>` is a REAL browser tab, not a React-reconciled node, so there is
 * no virtual-DOM-vs-native-undo fight to manage the way src/nodes/TextNode.jsx
 * (~:151) and src/utils/nativeTextUndo.js (~:28) have to for in-canvas text —
 * the browser's own Ctrl+Z "just works" here. A future instance should NOT
 * "fix" this editor away to match the design doc's stated intent; it is a
 * deliberate, discussed divergence (design doc §5.5).
 *
 * Fonts (§5.3): checks `document.fonts.check()` against the computed
 * `--ff-display` family and shows a print-hidden banner on failure, rather
 * than vendoring the families (which would go silently wrong the moment the
 * design system is replaced with different ones — see §5.3's rationale).
 */
function buildInjectedChrome({ docId, kind, dual }) {
  const safeDocId = docId ? String(docId) : `${kind}-untitled`;
  const printHint = dual
    ? 'Printing? The warm background disappears automatically — no settings needed for that. In the print dialog, uncheck \u201cHeaders and footers\u201d and set Margins \u2192 Default so the page-number footer isn\u2019t covered.'
    : 'Printing? In the print dialog, uncheck \u201cHeaders and footers\u201d and set Margins \u2192 Default so the page-number footer isn\u2019t covered.';

  const html = `<div class="ic-toolbar" role="toolbar" aria-label="Document controls">
  <button type="button" id="ic-edit-toggle" class="ic-btn">Edit</button>
  <button type="button" id="ic-export-btn" class="ic-btn ic-btn-primary">Export (Print / Save as PDF)</button>
  <button type="button" id="ic-download-btn" class="ic-btn" hidden>Download edited copy</button>
  <span id="ic-restore-note" class="ic-restore-note" hidden>Restored your edits from this browser.</span>
  <span class="ic-hint">${escapeHtml(printHint)}</span>
</div>
<div class="ic-banner ic-font-warning" id="ic-font-warning" role="status" hidden>Fonts didn\u2019t load (offline?). This will print with fallback typefaces \u2014 reconnect and reload.</div>
<script>
(function () {
  var DOC_ID = ${jsStringLiteral(safeDocId)};
  var STORAGE_KEY = 'ic-edit:' + DOC_ID;
  var main = document.querySelector('main.page') || document.querySelector('main');
  var editBtn = document.getElementById('ic-edit-toggle');
  var exportBtn = document.getElementById('ic-export-btn');
  var downloadBtn = document.getElementById('ic-download-btn');
  var restoreNote = document.getElementById('ic-restore-note');
  var fontWarning = document.getElementById('ic-font-warning');
  var saveTimer = null;

  // ---- Edit mode + localStorage autosave (§5.5). contenteditable edits
  // vanish on reload without this; keyed by docId so different documents
  // (and different applications generated from the same hub) never collide. ----
  if (main) {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        main.innerHTML = saved;
        if (restoreNote) restoreNote.hidden = false;
      }
    } catch (e) { /* localStorage unavailable (e.g. file:// under strict privacy settings) — degrade to no-autosave */ }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        try { localStorage.setItem(STORAGE_KEY, main.innerHTML); } catch (e) {}
      }, 500);
    }
    main.addEventListener('input', scheduleSave);
  }

  function stopEditing() {
    if (!main) return;
    main.removeAttribute('contenteditable');
    if (editBtn) editBtn.textContent = 'Edit';
    if (downloadBtn) downloadBtn.hidden = true;
  }

  if (editBtn && main) {
    editBtn.addEventListener('click', function () {
      var editing = main.getAttribute('contenteditable') === 'true';
      if (editing) {
        stopEditing();
      } else {
        main.setAttribute('contenteditable', 'true');
        main.focus();
        editBtn.textContent = 'Done editing';
        if (downloadBtn) downloadBtn.hidden = false;
      }
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      // Commit any in-progress edit before printing so no editing chrome
      // (the dashed outline, an active caret) can appear in the printed
      // output — the printed artifact must match the design system exactly.
      stopEditing();
      window.print();
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', function () {
      var blob = new Blob(['<!doctype html>\\n' + document.documentElement.outerHTML], { type: 'text/html' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = DOC_ID + ' (edited).html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  // ---- Font detection, never vendoring (§5.3) ----
  try {
    var ffDisplay = getComputedStyle(document.documentElement).getPropertyValue('--ff-display');
    var firstFamily = (ffDisplay.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
    if (firstFamily && window.document.fonts && document.fonts.check) {
      var check = function () {
        try {
          // document.fonts.check()'s shorthand defaults to font-weight 400
          // ("normal") when no weight is given. resume.css's .name sets
          // Source Serif 4 at font-weight 600 (--fw-semibold) and NEVER
          // renders it at 400 anywhere in the résumé; browsers only fetch the
          // specific weight actually used, so the check queried a weight that
          // legitimately never loaded and always returned false — firing this
          // banner on every résumé export, online or offline. Read the ACTUAL
          // computed weight off a real on-page element that uses --ff-display
          // (résumé: .name at 600; cover letter: .letter-body at 400) instead
          // of assuming one — self-corrects for either document and for any
          // future design-system weight change with no matching JS edit here.
          var ffEl = document.querySelector('.name') || document.querySelector('.letter-body') || document.documentElement;
          var ffWeight = (getComputedStyle(ffEl).fontWeight || '400').trim() || '400';
          if (!document.fonts.check(ffWeight + ' 12px "' + firstFamily + '"') && fontWarning) fontWarning.hidden = false;
        } catch (e) {}
      };
      if (document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(check).catch(check);
      else check();
    }
  } catch (e) { /* font-loading API unsupported — this is an enhancement, degrade quietly */ }
})();
</script>`;

  return html;
}

// ---------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------

/**
 * Normalize the résumé model's output into a full, self-contained HTML
 * document: charset, ONE inlined `<style>` carrying the design-system CSS
 * followed by the injected `ic-` chrome (§5.2 — never a `<link>`, so the file
 * is double-click-openable with no sibling assets), the resolved receipts
 * (§4.3), and the injected toolbar/edit-mode/font-warning chrome (§5.2-§5.5).
 * The model returns just the `<main class="page" …>…</main>` block; we own
 * everything around it so the styling can never break regardless of what
 * `<head>` the model emitted.
 *
 * @param {object} args
 * @param {string} args.resumeMainHtml  the model's raw `<main class="page">…</main>` output
 * @param {string} [args.variantAttrs]  override for the resolved data-print/data-mono/data-page attrs
 * @param {Array}  [args.ledger]        the hub's achievement ledger (or null — receipts degrade to stripped ids)
 * @param {string} [args.docId]         stable id for this document, namespaces localStorage autosave (§5.5)
 * @returns {string}
 */
export function buildResumeDocument({ resumeMainHtml, variantAttrs, ledger, docId } = {}) {
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
  // Resolve/strip receipts BEFORE anything else touches the markup (§4.3 step 3).
  main = injectReceipts(main, ledger);

  const attrs = variantAttrs != null ? variantAttrs : extractVariantAttrs(resumeMainHtml);
  const css = inlineStylesheets(RESUME_CSS_FILES);
  const chrome = buildInjectedChrome({ docId, kind: 'resume', dual: isDualMode(attrs) });

  return `<!doctype html>
<html lang="en" ${attrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Résumé</title>
<style>
${css}

${INJECTED_CHROME_CSS}
</style>
</head>
<body>
${chrome}
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
 * résumé's print variant so the pair renders as one set. No receipts here
 * (design doc §4.4): the cover letter is built from plain-string fields with
 * nowhere to hang a `data-achievement-id`, and any figure it uses also
 * appears in the résumé where it *does* carry one.
 *
 * @param {object} args
 * @param {object} [args.letter]        { name, tagline, contact[], date, recipient (\n-separated lines),
 *                                         salutation, paragraphs[], closing, signatureTitle }
 * @param {string} [args.variantAttrs]
 * @param {string} [args.docId]         stable id for this document, namespaces localStorage autosave (§5.5)
 */
export function buildCoverLetterDocument({ letter = {}, variantAttrs = '', docId } = {}) {
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

  const css = inlineStylesheets(CSS_FILES);
  const chrome = buildInjectedChrome({ docId, kind: 'cover-letter', dual: isDualMode(variantAttrs) });

  return `<!doctype html>
<html lang="en" ${variantAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cover Letter</title>
<style>
${css}

${INJECTED_CHROME_CSS}
</style>
</head>
<body>
${chrome}
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

// ---------------------------------------------------------------------------
// Startup assertion (§9)
// ---------------------------------------------------------------------------

/**
 * Startup assertion for the résumé design-system coupling surface (§9).
 * `resume_design_system/` is owned by Claude design, read-only from this
 * repo's side, and may be replaced wholesale — reconnection is done manually
 * and deliberately. This function's job is NOT to heal anything; it exists to
 * say "a reconnect is needed" instead of letting the app silently generate
 * résumés/cover letters against a stale contract.
 *
 * This is deliberately the OPPOSITE of the rubric-injection fail-quiet rule
 * in jobApplication.js (design doc §4.1): fail LOUD on what breaks the
 * artifact (missing CSS, a `<main>` sample that no longer extracts), degrade
 * quietly on what only improves it (that's the rubric injection, not this).
 *
 * Must NEVER throw — electron/main.js calls this fire-and-forget at startup
 * with no try/catch around the call itself (only a `.catch()` on the
 * resulting promise, for the impossible case of an unexpected rejection), so
 * every failure mode here is caught internally and folded into the returned
 * result instead. Must not block anything either — purely diagnostic.
 *
 * @returns {{ok: boolean, checked: string[], missing: string[], mainExtractionOk: boolean, error: string|null}}
 */
export function assertDesignSystemIntact() {
  const result = { ok: true, checked: [], missing: [], mainExtractionOk: false, error: null };
  try {
    const dir = getDesignSystemDir();
    for (const file of CSS_FILES) {
      result.checked.push(file);
      if (!fs.existsSync(path.join(dir, file))) {
        result.missing.push(file);
        result.ok = false;
      }
    }
    const htmlPath = path.join(dir, 'resume.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      result.mainExtractionOk = /<main[\s\S]*<\/main>/i.test(html);
      if (!result.mainExtractionOk) result.ok = false;
    } else {
      result.missing.push('resume.html');
      result.ok = false;
    }
  } catch (err) {
    // getDesignSystemDir() throwing (the whole folder is gone) lands here —
    // still never propagates past this function.
    result.ok = false;
    result.error = err?.message || String(err);
  }

  if (result.ok) {
    logger.info('[resumeHtml] design-system startup assertion passed (CSS files + <main> sample intact)');
  } else {
    logger.warn(`[resumeHtml] DESIGN-SYSTEM RECONNECT NEEDED — startup assertion failed: ${JSON.stringify(result)}. Résumé/cover-letter generation will run against a stale or broken contract until this is addressed (see docs/resume-achievement-mining-design.md §9 reconnect checklist).`);
  }
  return result;
}
