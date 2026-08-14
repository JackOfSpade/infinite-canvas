/**
 * Self-contained HTML builders for the job-application generator (résumé +
 * cover letter). Design doc: docs/resume-achievement-mining-design.md §5.
 *
 * HTML-FIRST, NOT PDF-ONLY (§5.1). The browser tab is still the primary,
 * editable screen artifact — the design system's own `@media print` rule
 * (resume_design_system/colors_and_type.css ~:394-409) already flips `--bg`
 * to transparent on print, for free, and the user can always open the file
 * this module returns directly in Chrome and export via `window.print()`
 * (see the injected chrome below).
 *
 * UPDATE — PDF generation is back, but NOT as a revival of the old
 * `resumePdf.js` (that file launched puppeteer-core against system Chrome;
 * it stays deleted). `electron/ipc/resumeRender.js` renders a PDF companion
 * from the exact HTML this module builds using Electron's OWN
 * `webContents.printToPDF` — no extra browser binary — and
 * `jobApplication.js` drives a local render → page-count → fit loop (SKILL.md
 * §5's compact-density algorithm) around it before shipping. The PDF is a
 * companion written NEXT TO the HTML, not a replacement for it: this module's
 * own job (HTML scaffold, inlined CSS, injected chrome) is unchanged by that —
 * resumeRender.js only ever consumes the HTML string this file already
 * produces, it doesn't feed back into how that HTML is built.
 *
 * This module still owns the two coupling points that used to live in
 * resumePdf.js (design doc §9 reconnect-checklist rows 1-2, migrated here):
 * the `CSS_FILES` filename list and `getDesignSystemDir()`.
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
/**
 * @param {string} resumeMainHtml
 * @param {object} [opts]
 * @param {'compact'|null} [opts.density]  Force `data-density="compact"` on
 *   (or, when explicitly `null`, force it OFF) regardless of what the
 *   model's markup contains. Omit to fall through to whatever the model
 *   wrote (see the data-density block below).
 */
export function extractVariantAttrs(resumeMainHtml, { density } = {}) {
  const html = String(resumeMainHtml || '');
  // Only read the opening <main> tag. Searching body copy can accidentally
  // select a variant, and HTML permits single-quoted or unquoted attributes
  // just as much as the double-quoted examples in the design system.
  const mainTag = /<main\b[^>]*>/i.exec(html)?.[0] || html;
  const attrValue = (name) => {
    const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"'=]+))`, 'i').exec(mainTag);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
  };
  const mode = String(attrValue('data-print') || '').toLowerCase() === 'ink-only' ? 'ink-only' : 'dual-pdf';
  const out = [`data-print="${mode}"`];
  if (/(?:\s|<)data-mono(?:\s|=|>|\/)/i.test(mainTag)) out.push('data-mono');
  if (String(attrValue('data-page') || '').toLowerCase() === 'a4') out.push('data-page="a4"');

  // data-density — the design system's ONE deterministic page-fit lever
  // (SKILL.md §5's "compact-density algorithm"; colors_and_type.css ~:300
  // cascades it into ~10 tokens: body type −5%, tighter leading, spacing
  // −25%, margins in). THIS FUNCTION REBUILDS THE ATTRIBUTE STRING FROM
  // SCRATCH — it was previously missing entirely from the recognized-attrs
  // list above (only data-print/data-mono/data-page were), which meant any
  // data-density the model happened to emit was silently DROPPED on every
  // call, with no error and no signal that it had been lost. That made the
  // one lever a page-count fit loop needs to pull unreachable: nothing
  // downstream of this function ever saw it, no matter who tried to set it.
  //
  // `density` lets the CALLER force the value — this is how jobApplication.js's
  // fit loop applies compact density after measuring a rendered page count
  // (a decision the MODEL can't make, since it never sees a page count; per
  // SKILL.md's own rule, "apply only after a first render shows overflow" /
  // "do not apply pre-emptively"). An explicit `density` argument always wins
  // over the model's markup. When omitted, we still recognize a
  // model-emitted `data-density="compact"` (rather than silently dropping it,
  // the exact bug this comment documents) — the full SKILL.md text is
  // injected into the résumé prompt as the editorial rubric
  // (jobApplication.js's `getEditorialRubric`), so the model has read the
  // literal `data-density="compact"` example markup and could plausibly copy
  // it even though it isn't instructed to.
  const resolvedDensity = density !== undefined
    ? density
    : (String(attrValue('data-density') || '').toLowerCase() === 'compact' ? 'compact' : null);
  if (resolvedDensity === 'compact') out.push('data-density="compact"');

  return out.join(' ');
}

// The builder owns the final root-level variants. Once their values have been
// resolved, discard copies on <main>: a length-revision response could
// otherwise leave a conflicting local attribute that overrides the root and
// makes page size/OCG mode disagree with the fit-loop's decision.
function stripMainVariantAttrs(mainHtml) {
  return String(mainHtml || '').replace(/<main\b[^>]*>/ig, tag =>
    tag.replace(/\sdata-(?:print|mono|page|density)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/ig, ''),
  );
}

/**
 * True when the variant is dual-pdf. Two consumers:
 *   1. Tailors the injected print-hint copy (§5.4): the dual-pdf variant can
 *      truthfully tell the user the warm background disappears automatically
 *      on print, ink-only has no such background to explain away.
 *   2. (Restored) gates the OCG cream post-process again — jobApplication.js
 *      calls `resumeRender.js`'s `applyDualPdf()` only when this returns true,
 *      mirroring SKILL.md §5 step 6 ("if the variant is ink-only or unset,
 *      skip this step — never run addOcgBackground() on an ink-only PDF").
 *      This is exactly the gating role the function's name always implied;
 *      it briefly had no PDF consumer while PDF generation was retired.
 * Kept as an exported pure function (unchanged logic) because
 * scripts/test-runner.js already exercises it directly.
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
.ic-toolbar .ic-btn:disabled { opacity: .42; cursor: not-allowed; background: transparent; }
.ic-toolbar .ic-btn-primary { background: #7A1F2B; border-color: #7A1F2B; }
.ic-toolbar .ic-btn-primary:hover { background: #8F2534; }
.ic-toolbar .ic-hint { margin-left: auto; opacity: 0.8; font-size: 12px; }
.ic-toolbar .ic-restore-note { opacity: 0.8; font-size: 12px; }
.ic-banner {
  padding: 8px 20px;
  font: 13px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif;
}
.ic-font-warning { background: #FCEFC7; color: #6B4E00; border-bottom: 1px solid #E8CE84; }

/* ---- résumé workspace --------------------------------------------------
   This is deliberately an application shell around (not in) .page.  The
   page remains the sole printed artifact; see the print reset below. */
.ic-resume-workspace {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  align-items: stretch;
  background: #e7e0d1;
  font: 13px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif;
}
.ic-workspace-sidebar {
  position: sticky;
  top: 0;
  align-self: start;
  max-height: 100vh;
  overflow: auto;
  box-sizing: border-box;
  padding: 22px 18px 30px;
  background: #241f19;
  color: #f7f1e6;
}
.ic-workspace-kicker { margin: 0 0 5px; color: #d6a86c; font-size: 10px; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; }
.ic-workspace-title { margin: 0; color: inherit; font: 600 24px/1.1 Georgia, "Times New Roman", serif; }
.ic-workspace-context { margin: 8px 0 18px; color: #cfc2b0; font-size: 12px; }
.ic-workspace-sidebar .ic-toolbar { position: static; display: grid; grid-template-columns: 1fr; gap: 8px; padding: 0; background: transparent; }
.ic-workspace-sidebar .ic-toolbar .ic-btn { min-height: 34px; text-align: left; }
.ic-workspace-sidebar .ic-toolbar .ic-hint { margin: 5px 0 0; color: #cfc2b0; font-size: 11px; }
.ic-workspace-sidebar .ic-banner { margin: 12px -18px 0; padding: 9px 18px; }
.ic-panel { margin-top: 22px; padding-top: 16px; border-top: 1px solid rgba(247, 241, 230, .18); }
.ic-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 0 0 10px; }
.ic-panel-title { margin: 0; color: inherit; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
.ic-panel-note, .ic-review-status { color: #cfc2b0; font-size: 11px; }
.ic-review-status { display: block; margin: 0 0 10px; }
.ic-insight-card { padding: 12px; margin: 8px 0; border: 1px solid rgba(247, 241, 230, .2); background: #302921; }
.ic-insight-card[data-ic-decision="verified"] { border-color: #8eb49b; }
.ic-insight-card[data-ic-decision="not_mine"] { opacity: .62; }
.ic-insight-skill { margin: 0 0 5px; color: #fffaf0; font-size: 14px; font-weight: 700; }
.ic-insight-meta { margin: 0 0 7px; color: #d6a86c; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.ic-insight-copy { margin: 0; color: #d8cdbc; font-size: 12px; }
.ic-insight-copy + .ic-insight-copy { margin-top: 6px; }
.ic-insight-label { color: #fffaf0; font-weight: 700; }
.ic-insight-prompt { margin: 9px 0 0; padding: 8px; border-left: 2px solid #d6a86c; background: rgba(0,0,0,.14); color: #f2e7d6; font-size: 11px; }
.ic-insight-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 10px; }
.ic-insight-actions button { padding: 5px 8px; border: 1px solid rgba(247,241,230,.35); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.ic-insight-actions button[aria-pressed="true"] { background: #d6a86c; border-color: #d6a86c; color: #241f19; font-weight: 700; }
.ic-learn-card { padding: 10px 0; border-top: 1px solid rgba(247, 241, 230, .12); }
.ic-learn-card:first-of-type { border-top: 0; }
.ic-hist-role { width: 100%; margin: 0 0 10px; padding: 7px 8px; border: 1px solid rgba(247,241,230,.35); background: #302921; color: #fffaf0; font: inherit; }
.ic-hist-panel[hidden] { display: none; }
.ic-hist-row { display: grid; grid-template-columns: minmax(88px, 38%) minmax(0, 1fr) auto; gap: 8px; align-items: center; margin: 8px 0; }
.ic-hist-label { overflow-wrap: anywhere; color: #f7f1e6; font-size: 11px; line-height: 1.2; }
.ic-hist-bar { display: flex; height: 9px; overflow: hidden; background: #4b4035; }
.ic-hist-bar > span { display: block; height: 100%; }
.ic-hist-verify { width: var(--ic-verify, 0%); background: #8eb49b; }
.ic-hist-learn { width: var(--ic-learn, 0%); background: #d6a86c; }
.ic-hist-count { color: #fffaf0; font-size: 11px; font-variant-numeric: tabular-nums; }
.ic-hist-breakdown { grid-column: 2 / 4; margin-top: -5px; color: #cfc2b0; font-size: 10px; }
.ic-hist-legend { display: flex; gap: 12px; margin: 7px 0 12px; color: #cfc2b0; font-size: 10px; }
.ic-hist-key::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 5px; background: #d6a86c; }
.ic-hist-key-verify::before { background: #8eb49b; }
.ic-preview-area { min-width: 0; padding: 34px 24px 70px; background: #e7e0d1; }
.ic-preview-area .page { margin: 0 auto; }
.ic-inferred-skill { white-space: normal; }
@media screen {
  body { padding: 0; background: #e7e0d1; }
}
@media (max-width: 860px) {
  .ic-resume-workspace { display: block; }
  .ic-workspace-sidebar { position: static; max-height: none; }
  .ic-preview-area { padding: 22px 12px 48px; overflow-x: auto; }
}
@media print {
  .ic-toolbar, .ic-banner { display: none !important; }
  .ic-workspace-sidebar { display: none !important; }
  .ic-resume-workspace, .ic-preview-area { display: contents !important; }
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

// Skill-review inputs are model-produced advice, so normalize them into a
// deliberately small, display-only contract before they get anywhere near the
// document. The browser code uses the stable ids below; labels are always
// escaped when inserted into HTML. Callers may use either the compact array
// form or { insights: [...] } while the generation pipeline settles on its
// final response schema.
function normaliseSkillInsights(raw) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw?.insights) ? raw.insights : []));
  const rawRole = raw?.role;
  const analysisRole = typeof rawRole === 'object'
    ? String(rawRole?.canonicalName || rawRole?.sourceTitle || '').trim()
    : String(rawRole || '').trim();
  const used = new Set();
  return source.map((item, index) => {
    const value = item && typeof item === 'object' ? item : {};
    const kind = String(value.kind || value.type || '').toLowerCase() === 'learn' ? 'learn' : 'verify';
    const skill = String(value.canonicalSkillName || value.skill || value.skillName || value.name || value.canonicalSkill || '').trim();
    if (!skill) return null;
    const role = String(value.role || value.roleName || value.roleCategory || value.jobRole || analysisRole).trim();
    const base = String(value.id || `${kind}:${role.toLowerCase()}:${skill.toLowerCase()}`)
      .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `skill-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return {
      id,
      kind,
      skill,
      resumeText: String(value.suggestedResumeText || skill).trim(),
      role: role || 'This role',
      evidence: String(value.candidateEvidence || value.evidence || value.reason || value.rationale || value.why || '').trim(),
      impact: String(value.jobEvidence || value.impact || value.jobImpact || value.relevance || '').trim(),
      adjacency: String(value.adjacencyReason || '').trim(),
      importance: String(value.jobImportance || '').trim(),
      question: String(value.verificationQuestion || '').trim(),
      learningAction: String(value.learningAction || '').trim(),
    };
  }).filter(Boolean);
}

// The histogram is intentionally kept generic: generation can return an
// array of role buckets, a { roles } object, or a flat list. We merge role and
// skill spelling variants here as a defensive last mile; the AI should still
// canonicalise these upstream so counts mean the same thing across runs.
function normaliseSkillHistogram(raw) {
  const root = Array.isArray(raw) ? raw : (raw?.roles || raw?.histogram || raw?.items || []);
  const buckets = Array.isArray(root) ? root : [];
  const roles = new Map();
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const roleName = String(bucket.role || bucket.roleName || bucket.name || bucket.category || '').trim();
    if (!roleName) continue;
    const roleKey = roleName.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!roles.has(roleKey)) roles.set(roleKey, {
      id: String(bucket.id || '').trim(),
      role: roleName,
      generationCount: Math.max(0, Number(bucket.generationCount || 0) || 0),
      skills: new Map(),
    });
    const target = roles.get(roleKey);
    const entries = Array.isArray(bucket.skills) ? bucket.skills : (Array.isArray(bucket.items) ? bucket.items : []);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const skill = String(entry.skill || entry.skillName || entry.name || '').trim();
      if (!skill) continue;
      const skillKey = skill.toLowerCase().replace(/\s+/g, ' ').trim();
      const current = target.skills.get(skillKey) || { skill, demandCount: 0, verifyCount: 0, learnCount: 0 };
      current.demandCount += Math.max(0, Number(entry.demandCount ?? entry.count ?? entry.demand ?? 0) || 0);
      current.verifyCount += Math.max(0, Number(entry.verifyCount ?? entry.verify ?? 0) || 0);
      current.learnCount += Math.max(0, Number(entry.learnCount ?? entry.learn ?? 0) || 0);
      target.skills.set(skillKey, current);
    }
  }
  return [...roles.values()].map(bucket => ({
    id: bucket.id,
    role: bucket.role,
    generationCount: bucket.generationCount,
    skills: [...bucket.skills.values()].sort((a, b) => b.demandCount - a.demandCount || a.skill.localeCompare(b.skill)),
  })).sort((a, b) => a.role.localeCompare(b.role));
}

// The model never gets to write this HTML. Every proposed inferred skill is
// structurally present but hidden, and only the local review decision can
// reveal it. Keeping it in the actual .skills surface means a verified choice
// participates in screen preview, print and edited-HTML downloads alike.
function injectInferredSkills(mainHtml, insights, showAllVerifySkills = false) {
  const verify = insights.filter(item => item.kind === 'verify');
  if (!verify.length) return mainHtml;
  const inlineSkills = verify.map((item, index) =>
    `${index ? `<span class="sep" data-ic-inferred-separator${showAllVerifySkills ? '' : ' hidden'} aria-hidden="true">·</span>` : ''}` +
    `<span class="ic-inferred-skill" data-ic-inferred-skill="${escapeHtml(item.id)}"${showAllVerifySkills ? '' : ' hidden'}>${escapeHtml(item.resumeText || item.skill)}</span>`
  ).join('');
  const hidden = showAllVerifySkills ? '' : ' hidden';
  const entries = `<dt data-ic-inferred-label${hidden}>Role-fit (verified)</dt>\n` +
    `  <dd data-ic-inferred-group${hidden}>${inlineSkills}</dd>`;
  const skillsOpen = /<dl\b[^>]*\bclass\s*=\s*(?:"[^"]*\bskills\b[^"]*"|'[^']*\bskills\b[^']*'|skills)(?:\s|>|\/)[^>]*>/i.exec(mainHtml);
  if (skillsOpen) {
    const closeAt = mainHtml.indexOf('</dl>', skillsOpen.index + skillsOpen[0].length);
    if (closeAt >= 0) return `${mainHtml.slice(0, closeAt)}\n  ${entries}\n${mainHtml.slice(closeAt)}`;
  }
  const fallback = `\n<section class="section ic-inferred-skills-section" data-ic-inferred-section${hidden}>\n  <div class="section-head"><h2>Skills</h2><span class="rule" aria-hidden="true"></span></div>\n  <dl class="skills">\n  ${entries}\n  </dl>\n</section>\n`;
  return mainHtml.replace(/<\/main>\s*$/i, `${fallback}</main>`);
}

function buildSkillWorkspace({ skillInsights, skillHistogram, jobContext, skillOpportunityError }) {
  const insights = normaliseSkillInsights(skillInsights);
  const rawRole = skillInsights?.role && typeof skillInsights.role === 'object' ? skillInsights.role : {};
  const matchedRoleId = String(rawRole.matchedRoleId || '').trim();
  const canonicalRole = String(rawRole.canonicalName || rawRole.sourceTitle || '').trim().toLowerCase();
  const histogram = normaliseSkillHistogram(skillHistogram).sort((a, b) => {
    const aCurrent = (matchedRoleId && a.id === matchedRoleId) || a.role.toLowerCase() === canonicalRole;
    const bCurrent = (matchedRoleId && b.id === matchedRoleId) || b.role.toLowerCase() === canonicalRole;
    return Number(bCurrent) - Number(aCurrent) || a.role.localeCompare(b.role);
  });
  const verify = insights.filter(item => item.kind === 'verify');
  const learn = insights.filter(item => item.kind === 'learn');
  const contextRoles = [...new Set(insights.map(item => item.role).filter(Boolean))];
  const title = String(jobContext?.title || jobContext?.jobTitle || '').trim();
  const company = String(jobContext?.company || '').trim();
  const context = [title, company].filter(Boolean).join(' · ')
    || (contextRoles.length ? `Tailored for ${contextRoles.join(' · ')}` : 'Review high-value adjacent skills before export.');
  const card = (item) => `<article class="ic-insight-card${item.kind === 'learn' ? ' ic-learn-card' : ''}" data-ic-insight="${escapeHtml(item.id)}" data-ic-kind="${item.kind}">
  <p class="ic-insight-skill">${escapeHtml(item.skill)}</p>
  <p class="ic-insight-meta">${escapeHtml(item.importance || 'high')} impact · ${item.kind === 'verify' ? 'nearby — verify first' : 'learn first'}</p>
  ${item.impact ? `<p class="ic-insight-copy"><span class="ic-insight-label">Why it matters:</span> ${escapeHtml(item.impact)}</p>` : ''}
  ${item.evidence ? `<p class="ic-insight-copy"><span class="ic-insight-label">Your foundation:</span> ${escapeHtml(item.evidence)}</p>` : ''}
  ${item.adjacency ? `<p class="ic-insight-copy"><span class="ic-insight-label">Distance:</span> ${escapeHtml(item.adjacency)}</p>` : ''}
  ${item.kind === 'verify' && item.question ? `<p class="ic-insight-prompt"><span class="ic-insight-label">Check:</span> ${escapeHtml(item.question)}</p>` : ''}
  ${item.kind === 'verify' && item.learningAction ? `<p class="ic-insight-prompt" data-ic-not-mine-plan hidden><span class="ic-insight-label">Fastest gap close:</span> ${escapeHtml(item.learningAction)}</p>` : ''}
  ${item.kind === 'learn' && item.learningAction ? `<p class="ic-insight-prompt"><span class="ic-insight-label">Start here:</span> ${escapeHtml(item.learningAction)}</p>` : ''}
  ${item.kind === 'verify' ? `<div class="ic-insight-actions" aria-label="Confirm ${escapeHtml(item.skill)}">
    <button type="button" data-ic-skill-action="verified" data-ic-skill-id="${escapeHtml(item.id)}" aria-pressed="false">Verified</button>
    <button type="button" data-ic-skill-action="not_mine" data-ic-skill-id="${escapeHtml(item.id)}" aria-pressed="false">Not mine</button>
  </div>` : ''}
</article>`;
  const maxDemand = Math.max(1, ...histogram.flatMap(role => role.skills.map(skill => skill.demandCount)));
  const histPanels = histogram.map((role, index) => `<div class="ic-hist-panel" data-ic-hist-panel="${escapeHtml(role.role)}"${index ? ' hidden' : ''}>
    <p class="ic-panel-note">${escapeHtml(role.generationCount)} application${role.generationCount === 1 ? '' : 's'} analyzed</p>
    ${role.skills.length ? role.skills.map(skill => `<div class="ic-hist-row">
      <span class="ic-hist-label">${escapeHtml(skill.skill)}</span>
      <span class="ic-hist-bar" aria-hidden="true"><span class="ic-hist-verify" style="--ic-verify:${Math.round((skill.verifyCount / maxDemand) * 100)}%"></span><span class="ic-hist-learn" style="--ic-learn:${Math.round((skill.learnCount / maxDemand) * 100)}%"></span></span>
      <span class="ic-hist-count">${escapeHtml(skill.demandCount)}</span>
      <span class="ic-hist-breakdown">${escapeHtml(skill.verifyCount)} to verify · ${escapeHtml(skill.learnCount)} to learn</span>
    </div>`).join('') : '<p class="ic-panel-note">No recurring skill signals yet.</p>'}
  </div>`).join('');
  const histControl = histogram.length > 1 ? `<label class="ic-panel-note" for="ic-hist-role">Role category</label><select id="ic-hist-role" class="ic-hist-role">${histogram.map(role => `<option value="${escapeHtml(role.role)}">${escapeHtml(role.role)}</option>`).join('')}</select>` : '';
  const json = JSON.stringify({ insights, histogram });
  return {
    insights,
    markup: `<aside class="ic-workspace-sidebar" aria-label="Résumé tailoring workspace">
  <p class="ic-workspace-kicker">Application workspace</p>
  <h1 class="ic-workspace-title">Resume, with receipts.</h1>
  <p class="ic-workspace-context">${escapeHtml(context)}</p>
  <div id="ic-skill-workspace-data" data-ic-workspace="${escapeHtml(json)}" hidden></div>
  <div class="ic-toolbar" role="toolbar" aria-label="Document controls">
    <button type="button" id="ic-edit-toggle" class="ic-btn">Edit</button>
    <button type="button" id="ic-export-btn" class="ic-btn ic-btn-primary">Export (Print / Save as PDF)</button>
    <button type="button" id="ic-download-btn" class="ic-btn" hidden>Download edited copy</button>
    <span id="ic-restore-note" class="ic-restore-note" hidden>Restored your edits from this browser.</span>
    <span class="ic-hint">Printing? The page preview is the only thing that prints.</span>
  </div>
  <div class="ic-banner ic-font-warning" id="ic-font-warning" role="status" hidden>Fonts didn’t load (offline?). This will print with fallback typefaces — reconnect and reload.</div>
  <section class="ic-panel" aria-labelledby="ic-check-title">
    <div class="ic-panel-head"><h2 class="ic-panel-title" id="ic-check-title">Needs your check</h2><span id="ic-review-progress" class="ic-panel-note"></span></div>
    <span id="ic-review-status" class="ic-review-status" role="status"></span>
    ${verify.length ? verify.map(card).join('') : '<p class="ic-panel-note">No high-impact claims need confirmation.</p>'}
  </section>
  <section class="ic-panel" aria-labelledby="ic-learn-title">
    <div class="ic-panel-head"><h2 class="ic-panel-title" id="ic-learn-title">Skills to learn</h2><span class="ic-panel-note">Never added to résumé</span></div>
    ${learn.length ? learn.map(card).join('') : '<p class="ic-panel-note">No adjacent learning gaps surfaced for this role.</p>'}
  </section>
  <section class="ic-panel" aria-labelledby="ic-demand-title">
    <div class="ic-panel-head"><h2 class="ic-panel-title" id="ic-demand-title">Demand over time</h2><span class="ic-panel-note">Across applications</span></div>
    <div class="ic-hist-legend"><span class="ic-hist-key ic-hist-key-verify">nearby / verify</span><span class="ic-hist-key">learn</span></div>
    ${histControl}
    <div id="ic-histograms">${histPanels || '<p class="ic-panel-note">Signals will accumulate as you tailor more applications.</p>'}</div>
  </section>
  ${skillOpportunityError ? `<p class="ic-panel-note" role="status">Demand analysis was unavailable for this application; no new signal was recorded.</p>` : ''}
</aside>`,
  };
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
function buildInjectedChrome({ docId, kind, dual, workspace = false }) {
  const safeDocId = docId ? String(docId) : `${kind}-untitled`;
  const printHint = dual
    ? 'Printing? The warm background disappears automatically — no settings needed for that. In the print dialog, uncheck \u201cHeaders and footers\u201d and set Margins \u2192 Default so the page-number footer isn\u2019t covered.'
    : 'Printing? In the print dialog, uncheck \u201cHeaders and footers\u201d and set Margins \u2192 Default so the page-number footer isn\u2019t covered.';

  const chromeMarkup = workspace ? '' : `<div class="ic-toolbar" role="toolbar" aria-label="Document controls">
  <button type="button" id="ic-edit-toggle" class="ic-btn">Edit</button>
  <button type="button" id="ic-export-btn" class="ic-btn ic-btn-primary">Export (Print / Save as PDF)</button>
  <button type="button" id="ic-download-btn" class="ic-btn" hidden>Download edited copy</button>
  <span id="ic-restore-note" class="ic-restore-note" hidden>Restored your edits from this browser.</span>
  <span class="ic-hint">${escapeHtml(printHint)}</span>
</div>
<div class="ic-banner ic-font-warning" id="ic-font-warning" role="status" hidden>Fonts didn\u2019t load (offline?). This will print with fallback typefaces \u2014 reconnect and reload.</div>
`;
  const html = `${chromeMarkup}<script>
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
  var skillStorageKey = 'ic-skill-review:' + DOC_ID;
  var skillCards = Array.prototype.slice.call(document.querySelectorAll('[data-ic-insight][data-ic-kind="verify"]'));
  var skillDecisions = {};

  // ---- High-impact inferred skills --------------------------------------
  // A candidate may be close enough to be worth checking, but it is never a
  // résumé claim until the person explicitly marks it verified. Decisions are
  // stored separately from editable HTML; data attributes also preserve the
  // current state in a downloaded edited copy when file:// storage is blocked.
  skillCards.forEach(function (card) {
    var existing = card.getAttribute('data-ic-decision');
    if (existing === 'verified' || existing === 'not_mine') skillDecisions[card.getAttribute('data-ic-insight')] = existing;
  });
  try {
    var savedSkillDecisions = JSON.parse(localStorage.getItem(skillStorageKey) || '{}');
    if (savedSkillDecisions && typeof savedSkillDecisions === 'object') {
      Object.keys(savedSkillDecisions).forEach(function (id) {
        if (savedSkillDecisions[id] === 'verified' || savedSkillDecisions[id] === 'not_mine') skillDecisions[id] = savedSkillDecisions[id];
      });
    }
  } catch (e) {}

  function inferredNodes(id, attribute) {
    return Array.prototype.slice.call(document.querySelectorAll('[' + attribute + ']')).filter(function (node) {
      return node.getAttribute(attribute) === id;
    });
  }
  function applySkillDecision(id, decision, persist) {
    if (decision === 'verified' || decision === 'not_mine') skillDecisions[id] = decision;
    else delete skillDecisions[id];
    var resolved = skillDecisions[id];
    skillCards.filter(function (card) { return card.getAttribute('data-ic-insight') === id; }).forEach(function (card) {
      if (resolved) card.setAttribute('data-ic-decision', resolved);
      else card.removeAttribute('data-ic-decision');
      Array.prototype.slice.call(card.querySelectorAll('[data-ic-skill-action]')).forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-ic-skill-action') === resolved));
      });
      Array.prototype.slice.call(card.querySelectorAll('[data-ic-not-mine-plan]')).forEach(function (plan) {
        plan.hidden = resolved !== 'not_mine';
      });
    });
    inferredNodes(id, 'data-ic-inferred-skill').forEach(function (node) { node.hidden = resolved !== 'verified'; });
    var visibleSkills = Array.prototype.slice.call(document.querySelectorAll('[data-ic-inferred-skill]')).filter(function (node) { return !node.hidden; });
    Array.prototype.slice.call(document.querySelectorAll('[data-ic-inferred-label], [data-ic-inferred-group]')).forEach(function (node) { node.hidden = visibleSkills.length === 0; });
    var seenVisible = false;
    Array.prototype.slice.call(document.querySelectorAll('[data-ic-inferred-group] > *')).forEach(function (node) {
      if (node.hasAttribute('data-ic-inferred-skill') && !node.hidden) seenVisible = true;
      if (node.hasAttribute('data-ic-inferred-separator')) {
        var laterVisible = false;
        var cursor = node.nextElementSibling;
        while (cursor) {
          if (cursor.hasAttribute('data-ic-inferred-skill') && !cursor.hidden) { laterVisible = true; break; }
          cursor = cursor.nextElementSibling;
        }
        node.hidden = !(seenVisible && laterVisible);
      }
    });
    var fallback = document.querySelector('[data-ic-inferred-section]');
    if (fallback) fallback.hidden = !Object.keys(skillDecisions).some(function (key) { return skillDecisions[key] === 'verified'; });
    if (persist) {
      try { localStorage.setItem(skillStorageKey, JSON.stringify(skillDecisions)); } catch (e) {}
    }
    updateSkillReviewStatus();
  }
  function updateSkillReviewStatus() {
    var total = skillCards.length;
    var resolved = skillCards.filter(function (card) { return !!skillDecisions[card.getAttribute('data-ic-insight')]; }).length;
    var verified = skillCards.filter(function (card) { return skillDecisions[card.getAttribute('data-ic-insight')] === 'verified'; }).length;
    var progress = document.getElementById('ic-review-progress');
    var status = document.getElementById('ic-review-status');
    if (progress) progress.textContent = total ? resolved + ' / ' + total + ' resolved' : '';
    if (status) status.textContent = !total ? '' : (resolved < total
      ? 'Export unlocks after every high-impact claim is marked Verified or Not mine.'
      : (verified ? verified + ' verified skill' + (verified === 1 ? '' : 's') + ' included in this résumé.' : 'No inferred skills will be added to this résumé.'));
    if (exportBtn) {
      var blocked = total > 0 && resolved < total;
      exportBtn.disabled = blocked;
      exportBtn.setAttribute('aria-disabled', String(blocked));
      exportBtn.title = blocked ? 'Resolve every high-impact skill check before exporting.' : '';
      if (downloadBtn) {
        downloadBtn.disabled = blocked;
        downloadBtn.setAttribute('aria-disabled', String(blocked));
        downloadBtn.title = blocked ? 'Resolve every high-impact skill check before downloading a final copy.' : '';
      }
    }
  }
  skillCards.forEach(function (card) {
    var id = card.getAttribute('data-ic-insight');
    applySkillDecision(id, skillDecisions[id], false);
    Array.prototype.slice.call(card.querySelectorAll('[data-ic-skill-action]')).forEach(function (button) {
      button.addEventListener('click', function () { applySkillDecision(id, button.getAttribute('data-ic-skill-action'), true); });
    });
  });
  updateSkillReviewStatus();

  var histogramSelector = document.getElementById('ic-hist-role');
  if (histogramSelector) histogramSelector.addEventListener('change', function () {
    Array.prototype.slice.call(document.querySelectorAll('[data-ic-hist-panel]')).forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-ic-hist-panel') !== histogramSelector.value;
    });
  });

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
      if (exportBtn.disabled) return;
      // Commit any in-progress edit before printing so no editing chrome
      // (the dashed outline, an active caret) can appear in the printed
      // output — the printed artifact must match the design system exactly.
      stopEditing();
      window.print();
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', function () {
      if (downloadBtn.disabled) return;
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
 * @param {Array|object} [args.skillInsights] High-impact `verify` / `learn`
 *   candidates generated for this job. Verify candidates require a user
 *   decision; learn candidates are workspace-only and never enter `.page`.
 * @param {Array|object} [args.skillHistogram] Persistent, AI-canonicalised
 *   demand observations grouped by role. The browser performs a defensive
 *   spelling merge before rendering its horizontal bars.
 * @param {boolean} [args.showAllVerifySkills] Internal page-fit mode: reveal
 *   every verify candidate to measure the largest user-approved print state.
 *   Final interactive documents leave this false and require explicit review.
 * @returns {string}
 */
export function buildResumeDocument({ resumeMainHtml, variantAttrs, ledger, docId, skillInsights, skillHistogram, jobContext, skillOpportunityError, showAllVerifySkills = false } = {}) {
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
  main = stripMainVariantAttrs(main);
  // Resolve/strip receipts BEFORE anything else touches the markup (§4.3 step 3).
  main = injectReceipts(main, ledger);
  const workspace = buildSkillWorkspace({ skillInsights, skillHistogram, jobContext, skillOpportunityError });
  main = injectInferredSkills(main, workspace.insights, showAllVerifySkills);

  const attrs = variantAttrs != null ? variantAttrs : extractVariantAttrs(resumeMainHtml);
  const css = inlineStylesheets(RESUME_CSS_FILES);
  const chrome = buildInjectedChrome({ docId, kind: 'resume', dual: isDualMode(attrs), workspace: true });

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
<div class="ic-resume-workspace">
${workspace.markup}
  <div class="ic-preview-area">
${main}
${chrome}
  </div>
</div>
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
