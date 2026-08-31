/**
 * Self-contained HTML builders for the job-application generator (résumé +
 * cover letter). Design doc: docs/resume-achievement-mining-design.md §5.
 *
 * HTML-FIRST, NOT PDF-ONLY (§5.1). The browser tab is still the primary,
 * editable screen artifact — the design system's own `@media print` rule
 * (Job Application Design System/colors_and_type.css ~:394-409) already flips `--bg`
 * to transparent on print, for free, but Sync (electron/ipc/applicationSync.js,
 * driven from the injected chrome below), not a browser's own print dialog,
 * is the only supported way to turn this HTML into a PDF: it re-renders
 * through Electron's own pipeline (resumeRender.js), the same pipeline that
 * applies the dual-mode OCG cream layer, so the artifact that reaches an
 * employer portal is never a browser's own opinion of the same CSS.
 *
 * UPDATE — PDF generation is back, but NOT as a revival of the old
 * `resumePdf.js` (that file launched puppeteer-core against system Chrome;
 * it stays deleted). `electron/ipc/resumeRender.js` renders a PDF companion
 * from the exact HTML this module builds using Electron's OWN
 * `webContents.printToPDF` — no extra browser binary — and
 * `jobApplication.js` drives a local render → page-count → fit loop (SKILL.md
 * §5's compact-density algorithm) around it before shipping. The PDF is a
 * companion packaged with the HTML inside the application ZIP, not a
 * replacement for it: this module's own job (HTML scaffold, inlined CSS,
 * injected chrome) is unchanged by that —
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
 * through cleanly to `process.cwd()` + 'Job Application Design System' under plain
 * Node, exactly as it already did when this logic lived in resumePdf.js.
 *
 * The résumé is filled by the model as a `<main class="page">` block (the
 * design system is "agent fills the markup"); we own the document scaffold,
 * the inlined design-system CSS (whose typefaces load from the design-owned
 * Google Fonts import), the injected
 * `ic-` chrome, and the receipt
 * post-process. The cover letter is built deterministically from structured
 * fields so its layout is always on-brand.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import electronPkg from 'electron';
import { JSDOM } from 'jsdom';
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

// Model-authored résumé markup is embedded in a standalone executable HTML
// workspace. Prompts are not a security boundary: a job description can carry
// prompt injection, and Local AI output is equally untrusted. Keep the accepted
// surface deliberately identical to the documented résumé/cover components.
const SAFE_DOCUMENT_TAGS = new Set([
  'main', 'header', 'section', 'article', 'div',
  'h1', 'h2', 'h3', 'p', 'span', 'strong', 'b', 'em',
  'ul', 'li', 'dl', 'dt', 'dd', 'time', 'a', 'code', 'kbd', 'samp', 'br', 'hr',
]);
const RESUME_MODEL_CLASSES = new Set([
  'page', 'resume-header', 'name', 'tagline', 'subtitle-role', 'credential', 'contact',
  'section', 'section-head', 'subsection-head', 'rule', 'meta-row',
  'role', 'role-header', 'role-title-line', 'title', 'company', 'role-dates',
  'role-meta', 'role-summary', 'role-location', 'highlights',
  'scope', 'tradeoff', 'annotation-label', 'nowrap', 'sep', 'sep-loose',
  'projects', 'project', 'project-name', 'project-desc', 'project-metrics', 'skills',
]);
const COVER_DOCUMENT_CLASSES = new Set([
  'page', 'resume-header', 'letter-letterhead', 'name', 'tagline', 'subtitle-role',
  'credential', 'contact', 'sep', 'letterhead-rule', 'letter-meta', 'letter-date',
  'letter-body', 'salutation', 'letter-close', 'valediction', 'signature', 'signature-title',
]);
const HOST_EDITABLE_CLASSES = new Set(['ic-inferred-skill', 'ic-inferred-skills-section']);
const ACTIVE_DOCUMENT_TAGS = new Set([
  'script', 'style', 'link', 'iframe', 'frame', 'object', 'embed', 'base', 'meta',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'fieldset',
  'img', 'picture', 'source', 'video', 'audio', 'track', 'svg', 'math', 'canvas',
  'template', 'portal', 'noscript',
]);
const SAFE_ROLES = new Set(['document', 'group']);
const SAFE_ITEM_PROPS = new Set(['name', 'jobTitle', 'email', 'telephone', 'hasOccupation']);
const SAFE_ITEM_TYPES = new Set(['https://schema.org/Person', 'https://schema.org/EmployeeRole']);
const SAFE_ARIA_ATTRS = new Set(['aria-hidden', 'aria-label', 'aria-labelledby']);
const HOST_EDITABLE_DATA_ATTRS = new Set([
  'data-ic-inferred-skill', 'data-ic-inferred-separator',
  'data-ic-inferred-label', 'data-ic-inferred-group', 'data-ic-inferred-section',
]);
const MAX_DOCUMENT_MAIN_CHARS = 1024 * 1024;

function hasUnsafeAsciiControl(value, allowTextWhitespace = false) {
  return [...String(value || '')].some((char) => {
    const code = char.charCodeAt(0);
    return code === 127 || (code < 32 && !(allowTextWhitespace && (code === 9 || code === 10 || code === 13)));
  });
}

function safeDocumentHref(value) {
  const href = String(value || '').trim();
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(href) && !hasUnsafeAsciiControl(href)
    ? href.slice(0, 2048)
    : '';
}

function allowedDocumentClasses(documentKind, allowHostState) {
  const allowed = documentKind === 'cover' ? COVER_DOCUMENT_CLASSES : RESUME_MODEL_CLASSES;
  return allowHostState ? new Set([...allowed, ...HOST_EDITABLE_CLASSES]) : allowed;
}

function sanitizeDocumentElementAttributes(element, { documentKind, allowHostState, allowTrustedDerivations }) {
  const allowedClasses = allowedDocumentClasses(documentKind, allowHostState);
  for (const attr of [...element.attributes]) {
    const name = attr.name.toLowerCase();
    const rawValue = String(attr.value || '');
    let keep = false;
    let value = rawValue;

    if (name === 'class') {
      value = rawValue.split(/\s+/).filter(token => allowedClasses.has(token)).join(' ');
      keep = Boolean(value);
    } else if (name === 'id') {
      // `ic-*` is the host namespace. A model id there could make
      // getElementById/querySelector bind trusted controls to attacker markup.
      keep = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(rawValue) && !/^ic-/i.test(rawValue);
    } else if (name === 'role') {
      keep = SAFE_ROLES.has(rawValue);
    } else if (SAFE_ARIA_ATTRS.has(name)) {
      keep = rawValue.length <= 256 && !hasUnsafeAsciiControl(rawValue);
    } else if (name === 'itemprop') {
      keep = rawValue.split(/\s+/).every(token => SAFE_ITEM_PROPS.has(token));
    } else if (name === 'itemscope') {
      keep = true;
      value = '';
    } else if (name === 'itemtype') {
      keep = SAFE_ITEM_TYPES.has(rawValue);
    } else if (name === 'datetime') {
      keep = /^[A-Za-z0-9:+.-]{0,64}$/.test(rawValue);
    } else if (name === 'href' && element.localName === 'a') {
      value = safeDocumentHref(rawValue);
      keep = Boolean(value);
    } else if (name === 'title') {
      keep = rawValue.length <= 512 && !hasUnsafeAsciiControl(rawValue);
    } else if (name === 'data-achievement-id') {
      keep = /^[A-Za-z0-9_.:-]{1,120}$/.test(rawValue);
    } else if (allowTrustedDerivations && name === 'data-derivation') {
      keep = rawValue.length <= 2000 && !hasUnsafeAsciiControl(rawValue, true);
    } else if (allowHostState && HOST_EDITABLE_DATA_ATTRS.has(name)) {
      if (name === 'data-ic-inferred-skill') {
        keep = /^[A-Za-z0-9_-]{1,160}$/.test(rawValue);
      } else if (name === 'data-ic-inferred-separator') {
        keep = rawValue === 'join' || rawValue === 'between';
      } else {
        keep = rawValue === '';
      }
    } else if (allowHostState && name === 'hidden') {
      keep = true;
      value = '';
    }

    if (!keep) element.removeAttribute(attr.name);
    else if (value !== rawValue) element.setAttribute(name, value);
  }
}

/**
 * Return one inert, canonical `<main class="page">` document surface.
 * Unsupported formatting elements are unwrapped so their text survives;
 * active/network-capable elements are removed with their contents. Host-only
 * inferred-skill/receipt state is accepted solely for editor/Sync round trips,
 * never from initial model output.
 */
export function sanitizeDocumentMainHtml(raw, { documentKind = 'resume', allowHostState = false, allowTrustedDerivations = false } = {}) {
  const html = String(raw || '').trim();
  if (!html || html.length > MAX_DOCUMENT_MAIN_CHARS) {
    throw new Error('Document markup is missing or exceeds the safe size limit.');
  }
  const dom = new JSDOM(html);
  try {
    const mains = [...dom.window.document.querySelectorAll('main')];
    if (mains.length !== 1 || !mains[0].classList.contains('page')) {
      throw new Error('Document markup must contain exactly one <main class="page"> block.');
    }
    const main = mains[0];
    const elements = [...main.querySelectorAll('*')].reverse();
    for (const element of elements) {
      const tag = element.localName;
      if (ACTIVE_DOCUMENT_TAGS.has(tag)) {
        element.remove();
      } else if (!SAFE_DOCUMENT_TAGS.has(tag)) {
        element.replaceWith(...element.childNodes);
      }
    }
    const walker = dom.window.document.createTreeWalker(main, dom.window.NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(comment => comment.remove());
    sanitizeDocumentElementAttributes(main, { documentKind, allowHostState, allowTrustedDerivations });
    for (const element of main.querySelectorAll('*')) {
      sanitizeDocumentElementAttributes(element, { documentKind, allowHostState, allowTrustedDerivations });
    }
    // The page class is structural, not optional. Filtering may retain it with
    // other documented classes, but never accept a non-page root.
    if (!main.classList.contains('page')) main.classList.add('page');
    return main.outerHTML;
  } finally {
    dom.window.close();
  }
}

/**
 * Reapply only ledger-authored receipt tooltips from an already trusted main.
 * Both id and visible receipt text must match, so edited/new content cannot
 * borrow a derivation merely by copying an achievement id.
 */
export function restoreTrustedReceiptDerivations(candidateHtml, trustedHtml) {
  const candidateDom = new JSDOM(String(candidateHtml || ''));
  const trustedDom = new JSDOM(String(trustedHtml || ''));
  try {
    const trusted = new Map();
    const ambiguous = new Set();
    for (const element of trustedDom.window.document.querySelectorAll('[data-achievement-id][data-derivation]')) {
      const id = element.getAttribute('data-achievement-id') || '';
      const derivation = element.getAttribute('data-derivation') || '';
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id) || !derivation || derivation.length > 2000) continue;
      const key = `${id}\u0000${element.textContent || ''}`;
      if (ambiguous.has(key)) continue;
      if (!trusted.has(key)) trusted.set(key, derivation);
      else if (trusted.get(key) !== derivation) {
        trusted.delete(key);
        ambiguous.add(key);
      }
    }
    for (const element of candidateDom.window.document.querySelectorAll('[data-achievement-id]')) {
      const id = element.getAttribute('data-achievement-id') || '';
      const derivation = trusted.get(`${id}\u0000${element.textContent || ''}`);
      if (derivation) element.setAttribute('data-derivation', derivation);
      else element.removeAttribute('data-derivation');
    }
    const main = candidateDom.window.document.querySelector('main');
    if (!main) throw new Error('Sanitized document is missing its main page.');
    return main.outerHTML;
  } finally {
    candidateDom.window.close();
    trustedDom.window.close();
  }
}

/**
 * Decode ESCAPE SEQUENCES the model sometimes emits as literal two-character text
 * — a backslash followed by n / r / t — instead of the whitespace they denote.
 * A JSON round-trip can leave a double-escaped "\\n" → literal
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
 * Experience bullets use uniform text weight. Models occasionally use visual
 * emphasis for a tool or metric despite the résumé-writing rules; normalize
 * only that presentation markup in `.highlights > li` so structural emphasis
 * elsewhere in the document remains intact. Attributes are deliberately kept
 * when converting a tag: a receipt span still needs `data-achievement-id` for
 * the ledger resolver below.
 */
export function neutralizeHighlightTextEmphasis(mainHtml) {
  return String(mainHtml || '').replace(
    /(<ul\b[^>]*class=(?:"[^"]*\bhighlights\b[^"]*"|'[^']*\bhighlights\b[^']*')[^>]*>)([\s\S]*?)(<\/ul>)/gi,
    (_whole, open, highlights, close) => `${open}${highlights.replace(
      /(<li\b[^>]*>)([\s\S]*?)(<\/li>)/gi,
      (_item, itemOpen, content, itemClose) => `${itemOpen}${content.replace(/<(\/?)(?:b|strong)\b([^>]*)>/gi, '<$1span$2>')}${itemClose}`,
    )}${close}`,
  );
}

/**
 * Resolve the canonical variant attributes for a document, so BOTH the résumé
 * and the cover letter share one print variant / paper / mono treatment.
 *
 * Variants belong exclusively on `<html>`. The design system intentionally
 * ignores a data-* variant on `<main>`, `<body>`, or any other subtree, and
 * every app builder strips any such model error before emitting a document.
 * Reading only the root is also essential because built documents inline
 * design-system comments that may contain illustrative `<main>` snippets.
 *
 * Print mode follows the design system: the default is `dual-pdf` (warm cream
 * on screen, background transparent on print, cream restored as a view-only
 * OCG layer by resumeRender.js's applyDualPdf). Only an explicit `ink-only`
 * opts out (flat white for ATS pipelines).
 */
/**
 * @param {string} sourceHtml  a whole document whose root may carry variants
 * @param {object} [opts]
 * @param {'compact'|null} [opts.density]  Force `data-density="compact"` on
 *   (or, when explicitly `null`, force it OFF) regardless of what the
 *   document root contains. Omit to read the document root.
 */
export function extractVariantAttrs(sourceHtml, { density } = {}) {
  const html = String(sourceHtml || '');
  // Read only the root opening tag. Subtree attributes have no visual effect
  // under the design system's canonical root-only contract.
  const tagFor = (name) => new RegExp(`<${name}\\b[^>]*>`, 'i').exec(html)?.[0] || '';
  const rootTag = tagFor('html');
  const sourceTag = rootTag;
  const attrValue = (name) => {
    const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"'=]+))`, 'i').exec(sourceTag);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
  };
  const mode = String(attrValue('data-print') || '').toLowerCase() === 'ink-only' ? 'ink-only' : 'dual-pdf';
  const out = [`data-print="${mode}"`];
  if (/(?:\s|<)data-mono(?:\s|=|>|\/)/i.test(sourceTag)) out.push('data-mono');
  if (String(attrValue('data-page') || '').toLowerCase() === 'a4') out.push('data-page="a4"');

  // Density is the host's one measured-fit lever. An explicit argument lets
  // the fit loop force the value after it has measured the default render.
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

// Candidate copy may use hyphens within a word/value and en dashes in date or
// numeric ranges. It must never use a dash as prose punctuation: that is a
// design-system hard gate (SKILL.md "Dash punctuation"), enforced here for
// both API and Local AI document builders.
function candidateText(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:mdash|#8212|#x2014);/gi, '—')
    .replace(/&(?:ndash|#8211|#x2013);/gi, '–')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function enDashIsRange(text, index) {
  const before = text.slice(Math.max(0, index - 32), index);
  const after = text.slice(index + 1, index + 34);
  // A date range may name the month on both sides ("May 2023 – June 2026"),
  // not only use a bare year or "Present" as the right endpoint.
  const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  return /\d\s*$/.test(before)
    && new RegExp(`^\\s*(?:\\d|present\\b|${month}\\.?\\s+\\d{4}\\b)`, 'i').test(after);
}

function assertDashPunctuation(text, surface) {
  if (text.includes('—')) {
    throw new Error(`${surface} contains an em dash. Use a comma, conjunction, colon, semicolon, parentheses, or separate sentences instead.`);
  }
  if (/\s-\s/.test(text)) {
    throw new Error(`${surface} contains a spaced hyphen acting as sentence punctuation.`);
  }
  for (let index = text.indexOf('–'); index !== -1; index = text.indexOf('–', index + 1)) {
    if (!enDashIsRange(text, index)) {
      throw new Error(`${surface} contains an en dash outside a date or numeric range.`);
    }
  }
}

/** Enforce the design system's candidate-copy dash gate before document build. */
export function assertCandidateDashPunctuation({ resumeMainHtml = '', coverLetter = null } = {}) {
  const resume = candidateText(resumeMainHtml);
  if (resume) assertDashPunctuation(resume, 'Résumé copy');
  if (coverLetter && typeof coverLetter === 'object') {
    const cover = candidateText([
      coverLetter.name,
      ...(Array.isArray(coverLetter.contact) ? coverLetter.contact : []),
      coverLetter.salutation,
      coverLetter.recipient,
      ...(Array.isArray(coverLetter.paragraphs) ? coverLetter.paragraphs : []),
      coverLetter.closing,
      coverLetter.signatureTitle,
    ].filter(Boolean).join('\n'));
    if (cover) assertDashPunctuation(cover, 'Cover-letter copy');
  }
}

/**
 * Return the browser-side font-readiness predicate shared by the editable
 * workspace and Electron's hidden PDF renderer.
 *
 * `document.fonts.ready` means loading has *finished*, not that every face
 * succeeded. Checking only Source Serif's display weight let a document-panel
 * shell override (or a partial font failure) pass the fit loop while Inter
 * (or a visible mono metric/code run) still fell back and changed pagination.
 * Keep this as a DOM expression rather than a Node helper: FontFaceSet only
 * knows the renderer document's actual loaded faces.
 *
 * The exact set comes from nonempty text nodes inside every document panel
 * (including the hidden cover panel in Application.html). A document without
 * a 500-weight Inter element, for example, must not fail just because that
 * face exists in the stylesheet but Chromium never fetched it. IBM Plex Mono
 * follows the same rule: no code/metrics text means no mono probe.
 */
export function webFontFacesReadyExpression({ details = false } = {}) {
  const result = details
    ? "{ loaded: missingFaces.length === 0, missingFaces: missingFaces.map(function (face) { return (face.unexpected ? 'unexpected ' : '') + face.family + ' ' + face.weight; }), requiredFaces: required.filter(function (face) { return !face.unexpected; }).map(function (face) { return face.weight + ' 12px \\\"' + face.family + '\\\"'; }) }"
    : 'missingFaces.length === 0';
  return String.raw`(function () {
    try {
      if (!document.fonts || !document.fonts.check) return ${details ? '{ loaded: true, missingFaces: [] }' : 'true'};

      var rootStyle = getComputedStyle(document.documentElement);
      var familyFor = function (property) {
        return (rootStyle.getPropertyValue(property).split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
      };
      var normalizedFamily = function (value) {
        return (String(value || '').split(',')[0] || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
      };
      var knownFamilies = [familyFor('--ff-display'), familyFor('--ff-body'), familyFor('--ff-mono')]
        .filter(Boolean);
      var requiredByKey = {};
      var surfaces = Array.prototype.slice.call(document.querySelectorAll('[data-ic-document-panel], main.page'));
      var isDocumentText = function (node) {
        if (!String(node.nodeValue || '').trim()) return false;
        var parent = node.parentElement;
        return !!parent && surfaces.some(function (surface) { return surface.contains(parent); });
      };
      var walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (!isDocumentText(node)) continue;
        var style = getComputedStyle(node.parentElement);
        var family = normalizedFamily(style.fontFamily);
        var rawWeight = String(style.fontWeight || '400').trim().toLowerCase();
        var weight = rawWeight === 'normal' ? '400' : rawWeight === 'bold' ? '700' : rawWeight;
        var knownFamily = knownFamilies.find(function (candidate) { return family === candidate.toLowerCase(); });
        if (knownFamily) {
          requiredByKey[knownFamily + '\u0000' + weight] = { family: knownFamily, weight: weight };
        } else {
          requiredByKey['unexpected\u0000' + family + '\u0000' + weight] = { family: family || '(none)', weight: weight, unexpected: true };
        }
      }
      var required = Object.keys(requiredByKey).map(function (key) { return requiredByKey[key]; });

      var missingFaces = required.filter(function (face) {
        return face.unexpected || !document.fonts.check(face.weight + ' 12px "' + face.family + '"');
      });
      return ${result};
    } catch (e) { return ${details ? '{ loaded: true, missingFaces: [] }' : 'true'}; }
  })()`;
}

// ---------------------------------------------------------------------------
// Design-system coupling surface (migrated from resumePdf.js when the PDF
// path retired — design doc §9 reconnect-checklist rows 1-2). Read-only
// access to Job Application Design System/; nothing in that folder is ever written.
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
 * Resolve `Job Application Design System/`. In dev this is the repo root; in a packaged
 * build it must be asarUnpacked (plain `fs.readFileSync` can't read out of an
 * asar) — resolved off process.resourcesPath there. Fails loudly if absent
 * rather than silently emitting an unstyled document — migrated verbatim from
 * resumePdf.js:78-93 (design doc §9 reconnect-checklist row 2).
 */
export function getDesignSystemDir() {
  const candidates = [];
  try { if (app?.getAppPath) candidates.push(path.join(app.getAppPath(), 'Job Application Design System')); } catch { /* not in electron */ }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'Job Application Design System'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'Job Application Design System'));
  }
  candidates.push(path.join(process.cwd(), 'Job Application Design System'));
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'resume.css'))) return dir;
  }
  throw new Error(
    `Résumé design system not found (looked in: ${candidates.join(', ')}). ` +
    `The 'Job Application Design System' folder must ship with the app.`
  );
}

// Cache successful reads only (never cache a failure) — the design-system CSS
// doesn't change while the app is running, so re-reading three small text
// files on every application generation is pure waste; but if a file is
// genuinely missing we want the NEXT attempt to re-check disk (e.g. a dev
// mid-reconnect), not keep throwing from a stale cache entry that was never
// populated in the first place.
const _cssCache = new Map();
const _assetDataUrlCache = new Map();

// Keep this in lockstep with ENGINEERING.md §Packaging and package.json's
// extraResources filter. STYLE.md is not injected into generation prompts,
// but it remains part of the packaged runtime contract and reconnect audit.
const RUNTIME_DESIGN_FILES = [
  'SKILL.md',
  'readme.md',
  'STYLE.md',
  ...CSS_FILES,
  'resume.html',
  'cover-letter.html',
  'build/dual-mode-pdf.js',
];
const GOOGLE_FONTS_IMPORT_RE = /@import\s+url\(\s*["']?(https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]+)["']?\s*\)\s*;/gi;
const REQUIRED_FONT_IMPORT_PARTS = [
  'family=IBM+Plex+Mono:wght@400;500',
  'family=Inter:wght@400;500;600',
  'family=Source+Serif+4:opsz,wght@8..60,400;8..60,600',
];

const FONT_MIME_TYPES = new Map([
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
]);

/**
 * Convert any safe design-system-relative font references into data URLs.
 * The current contract uses one Google Fonts import, which is preserved
 * verbatim. Local URL support keeps a future re-vendoring change compatible,
 * while the path checks prevent the design system escaping its own directory.
 */
export function inlineDesignCssUrls(cssText, stylesheetPath, designDir = getDesignSystemDir()) {
  const stylesheet = path.resolve(stylesheetPath);
  const root = path.resolve(designDir);
  return String(cssText || '').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _quote, rawUrl) => {
    const assetUrl = String(rawUrl || '').trim();
    if (!assetUrl || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(assetUrl)) return whole;
    if (assetUrl.includes('?') || assetUrl.includes('#')) {
      throw new Error(`Unsupported local CSS asset URL in ${stylesheetPath}: ${assetUrl}`);
    }

    const assetPath = path.resolve(path.dirname(stylesheet), assetUrl);
    const relative = path.relative(root, assetPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`CSS asset escapes résumé design system: ${assetUrl}`);
    }
    const mime = FONT_MIME_TYPES.get(path.extname(assetPath).toLowerCase());
    if (!mime) throw new Error(`Unsupported local CSS asset type in ${stylesheetPath}: ${assetUrl}`);
    if (!fs.existsSync(assetPath)) throw new Error(`Missing local CSS asset in ${stylesheetPath}: ${assetUrl}`);

    if (!_assetDataUrlCache.has(assetPath)) {
      _assetDataUrlCache.set(assetPath, `data:${mime};base64,${fs.readFileSync(assetPath).toString('base64')}`);
    }
    return `url("${_assetDataUrlCache.get(assetPath)}")`;
  });
}

function readDesignCss(fileName) {
  if (_cssCache.has(fileName)) return _cssCache.get(fileName);
  // Deliberately NOT try/caught: a missing CSS file is a STRUCTURAL failure
  // (the output would be an unstyled document), so this must fail loudly —
  // the opposite of the rubric-injection asymmetry in jobApplication.js
  // (design doc §4.1 / §9's startup-assertion comment restates this same
  // asymmetry for the two checks below).
  const designDir = getDesignSystemDir();
  const cssPath = path.join(designDir, fileName);
  const text = inlineDesignCssUrls(fs.readFileSync(cssPath, 'utf8'), cssPath, designDir);
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

// The résumé model picks the print variant per employer (jobApplication.js's
// prompt: dual-pdf for craft-oriented companies, ink-only for enterprise/ATS
// pipelines). Keep that decision read-only — it is part of the tailoring — but
// never invisible: the two variants produce visibly different PDFs, and an
// unexplained white one looks like a failed dual-mode render. The injected
// script fills this note from the canonical root `data-print` attribute.
function printVariantIndicator(jobContext = {}) {
  const company = String(jobContext?.company || '').trim();
  const title = String(jobContext?.title || jobContext?.jobTitle || '').trim();
  // No leading "for" here — the client script prepends its own ("analysis
  // for " + context + " indicates"); a "for" on both sides doubled up into
  // "analysis for for Acme — Title indicates".
  const context = company && title
    ? `${company} — ${title}`
    : (company ? company : (title ? `the ${title} role` : ''));
  return `<span id="ic-print-variant-note" class="ic-print-variant-note" role="note"${context ? ` data-ic-paper-context="${escapeHtml(context)}"` : ''}></span>`;
}

const PRINT_VARIANT_INDICATOR = printVariantIndicator();

const INJECTED_CHROME_CSS = `
/* ==========================================================
   Injected chrome (electron/ipc/resumeHtml.js) — NOT part of
   Job Application Design System/. Namespaced ic- throughout. Every rule
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
.ic-print-variant-note { max-width: 340px; font-size: 11px; line-height: 1.35; opacity: 0.85; }
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
  font: 13px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif;
}
.ic-workspace-kicker { margin: 0 0 5px; color: #d6a86c; font-size: 10px; font-weight: 700; letter-spacing: .15em; text-transform: uppercase; }
.ic-workspace-title { margin: 0; color: inherit; font: 600 24px/1.1 Georgia, "Times New Roman", serif; }
.ic-workspace-context { margin: 8px 0 18px; color: #cfc2b0; font-size: 12px; }
.ic-job-posting-link { display: inline-flex; align-items: center; margin: -8px 0 18px; color: #f7f1e6; font-size: 12px; font-weight: 600; text-underline-offset: 3px; }
.ic-job-posting-link:hover { color: #fffaf0; }
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
.ic-preview-area .page { margin: 0; }
.ic-page-stage { position: relative; width: fit-content; margin: 0 auto 24px; }
.ic-page-stage:last-child { margin-bottom: 0; }
.ic-page-guides { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.ic-page-seam { position: absolute; left: 0; right: 0; }
.ic-page-seam-fade-top, .ic-page-seam-fade-bot { position: absolute; left: 0; right: 0; height: 14px; }
.ic-page-seam-fade-top { top: 0; background: linear-gradient(to bottom, rgba(26,24,21,.10), transparent); }
.ic-page-seam-fade-bot { bottom: 0; background: linear-gradient(to top, rgba(26,24,21,.10), transparent); }
.ic-page-seam-line { position: absolute; left: 0; right: 0; height: 1px; background: rgba(26,24,21,.18); }
.ic-page-seam-line-dashed { position: static; height: 0; border-top: 1px dashed rgba(26,24,21,.30); }
.ic-page-folio { position: absolute; right: 6px; font: 8.5px/1.3 "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace; letter-spacing: -0.005em; color: #8C857A; white-space: nowrap; }
.ic-document-tabs { display: flex; gap: 8px; max-width: 794px; margin: 0 auto 16px; }
.ic-document-tabs .ic-btn { padding: 7px 14px; border: 1px solid #a89f92; border-radius: 4px; background: #f7f4ed; color: #3b352f; font: 600 12px/1.3 -apple-system, "Helvetica Neue", Arial, sans-serif; cursor: pointer; }
.ic-document-tabs [aria-selected="true"] { background: #7A1F2B; border-color: #7A1F2B; color: #fff; }
.ic-pdf-attachment { display: grid; gap: 5px; color: #cfc2b0; font-size: 11px; }
.ic-pdf-attachment input { min-width: 0; max-width: 100%; color: #f7f1e6; font: inherit; }
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
  .ic-document-tabs { display: none !important; }
  .ic-workspace-sidebar { display: none !important; }
  .ic-resume-workspace, .ic-preview-area { display: contents !important; }
  .ic-page-stage { display: contents; }
  .ic-page-guides { display: none !important; }
}

/* ---- receipts (design doc §4.3) ----
   Attributes, not classes — data-achievement-id is written by the model
   (id only) and data-derivation is written by resumeHtml.js's post-process
   (tooltip text only); both survive a design-system swap untouched since
   nothing here is coupled to a Job Application Design System/ class name. */
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

// Browser-side mirror of sanitizeDocumentMainHtml(). It operates on a detached
// template so old localStorage HTML is inert before it ever reaches the live
// page. Keep this intentionally explicit instead of shipping a second sanitizer
// dependency inside every standalone application file.
function editableRuntimeSanitizerSource() {
  const editableTags = [...SAFE_DOCUMENT_TAGS].filter(tag => tag !== 'main');
  return `
  var IC_SAFE_EDIT_TAGS = new Set(${JSON.stringify(editableTags)});
  var IC_ACTIVE_EDIT_TAGS = new Set(${JSON.stringify([...ACTIVE_DOCUMENT_TAGS])});
  var IC_RESUME_EDIT_CLASSES = new Set(${JSON.stringify([...RESUME_MODEL_CLASSES, ...HOST_EDITABLE_CLASSES])});
  var IC_COVER_EDIT_CLASSES = new Set(${JSON.stringify([...COVER_DOCUMENT_CLASSES, ...HOST_EDITABLE_CLASSES])});
  var IC_SAFE_EDIT_ROLES = new Set(${JSON.stringify([...SAFE_ROLES])});
  var IC_SAFE_EDIT_ITEM_PROPS = new Set(${JSON.stringify([...SAFE_ITEM_PROPS])});
  var IC_SAFE_EDIT_ITEM_TYPES = new Set(${JSON.stringify([...SAFE_ITEM_TYPES])});
  var IC_SAFE_EDIT_ARIA = new Set(${JSON.stringify([...SAFE_ARIA_ATTRS])});
  var IC_HOST_EDIT_DATA = new Set(${JSON.stringify([...HOST_EDITABLE_DATA_ATTRS])});

  function icSafeHref(value) {
    var href = String(value || '').trim();
    return /^(?:https?:\\/\\/|mailto:|tel:)[^\\u0000-\\u001f\\u007f]*$/i.test(href) ? href.slice(0, 2048) : '';
  }
  function icSanitizeEditAttributes(element, kind) {
    var classes = kind === 'cover' ? IC_COVER_EDIT_CLASSES : IC_RESUME_EDIT_CLASSES;
    Array.prototype.slice.call(element.attributes).forEach(function (attr) {
      var name = attr.name.toLowerCase();
      var raw = String(attr.value || '');
      var value = raw;
      var keep = false;
      if (name === 'class') {
        value = raw.split(/\\s+/).filter(function (token) { return classes.has(token); }).join(' ');
        keep = !!value;
      } else if (name === 'id') {
        keep = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(raw) && !/^ic-/i.test(raw);
      } else if (name === 'role') {
        keep = IC_SAFE_EDIT_ROLES.has(raw);
      } else if (IC_SAFE_EDIT_ARIA.has(name)) {
        keep = raw.length <= 256 && !/[\\u0000-\\u001f\\u007f]/.test(raw);
      } else if (name === 'itemprop') {
        keep = raw.split(/\\s+/).every(function (token) { return IC_SAFE_EDIT_ITEM_PROPS.has(token); });
      } else if (name === 'itemscope') {
        keep = true; value = '';
      } else if (name === 'itemtype') {
        keep = IC_SAFE_EDIT_ITEM_TYPES.has(raw);
      } else if (name === 'datetime') {
        keep = /^[A-Za-z0-9:+.-]{0,64}$/.test(raw);
      } else if (name === 'href' && element.localName === 'a') {
        value = icSafeHref(raw); keep = !!value;
      } else if (name === 'title') {
        keep = raw.length <= 512 && !/[\\u0000-\\u001f\\u007f]/.test(raw);
      } else if (name === 'data-achievement-id') {
        keep = /^[A-Za-z0-9_.:-]{1,120}$/.test(raw);
      } else if (IC_HOST_EDIT_DATA.has(name)) {
        if (name === 'data-ic-inferred-skill') {
          keep = /^[A-Za-z0-9_-]{1,160}$/.test(raw);
        } else if (name === 'data-ic-inferred-separator') {
          keep = raw === 'join' || raw === 'between';
        } else {
          keep = raw === '';
        }
      } else if (name === 'hidden') {
        keep = true; value = '';
      }
      if (!keep) element.removeAttribute(attr.name);
      else if (value !== raw) element.setAttribute(name, value);
    });
  }
  function icTrustedDerivationMap(root) {
    var trusted = new Map();
    var ambiguous = new Set();
    if (!root) return trusted;
    Array.prototype.slice.call(root.querySelectorAll('[data-achievement-id][data-derivation]')).forEach(function (element) {
      var id = element.getAttribute('data-achievement-id') || '';
      var derivation = element.getAttribute('data-derivation') || '';
      if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(id) || !derivation || derivation.length > 2000) return;
      var key = id + '\\u0000' + (element.textContent || '');
      if (ambiguous.has(key)) return;
      if (!trusted.has(key)) trusted.set(key, derivation);
      else if (trusted.get(key) !== derivation) {
        trusted.delete(key);
        ambiguous.add(key);
      }
    });
    return trusted;
  }
  function icRestoreTrustedDerivations(root, trusted) {
    if (!root || !trusted) return;
    Array.prototype.slice.call(root.querySelectorAll('[data-achievement-id]')).forEach(function (element) {
      var id = element.getAttribute('data-achievement-id') || '';
      var derivation = trusted.get(id + '\\u0000' + (element.textContent || ''));
      if (derivation) element.setAttribute('data-derivation', derivation);
      else element.removeAttribute('data-derivation');
    });
  }
  function icSanitizeEditableMarkup(raw, kind, trustedDerivations) {
    var template = document.createElement('template');
    template.innerHTML = String(raw || '');
    var root = document.createElement('div');
    root.appendChild(template.content);
    Array.prototype.slice.call(root.querySelectorAll('*')).reverse().forEach(function (element) {
      var tag = element.localName;
      if (IC_ACTIVE_EDIT_TAGS.has(tag)) element.remove();
      else if (!IC_SAFE_EDIT_TAGS.has(tag)) element.replaceWith.apply(element, Array.prototype.slice.call(element.childNodes));
    });
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    var comments = [], comment;
    while ((comment = walker.nextNode())) comments.push(comment);
    comments.forEach(function (node) { node.remove(); });
    Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function (element) {
      icSanitizeEditAttributes(element, kind);
    });
    icRestoreTrustedDerivations(root, trustedDerivations);
    return root.innerHTML;
  }
  function icInsertPlainText(text) {
    var value = String(text || '');
    if (document.execCommand && document.execCommand('insertText', false, value)) return;
    var selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    var range = selection.getRangeAt(0);
    range.deleteContents();
    var node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
  }
  function icInstallPlainTextEditing(target) {
    if (!target) return;
    target.addEventListener('paste', function (event) {
      event.preventDefault();
      icInsertPlainText(event.clipboardData ? event.clipboardData.getData('text/plain') : '');
    });
    target.addEventListener('drop', function (event) {
      event.preventDefault();
      icInsertPlainText(event.dataTransfer ? event.dataTransfer.getData('text/plain') : '');
    });
  }
`;
}

function createDocumentScriptNonce() {
  return crypto.randomBytes(18).toString('base64');
}

function contentSecurityPolicyMeta(scriptNonce) {
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}'`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'connect-src http://127.0.0.1:43192',
    "img-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">`;
}

// Job URLs are scraped input and the finished workspace is an executable HTML
// file, so preserve only absolute web URLs with a real host.  In particular,
// keep credentials and control characters out of an artifact that can be
// forwarded or opened outside the app. Returning the URL parser's canonical
// href gives the workspace one stable source value without ever rendering a
// raw, untrusted string.
function safeJobPostingUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2048 || hasUnsafeAsciiControl(raw)) return '';
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || !parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch { return ''; }
}

// A résumé HTML file is intentionally standalone: people routinely open it
// directly from its application folder. A browser cannot write that file, so
// Sync uses a narrowly-scoped localhost capability created by the Electron
// main process. The company segment is display data from a job board, never a
// path supplied by the user.
export function normaliseResumeDownloadBundle(raw = {}) {
  const auditText = (value, maxLength) => String(value ?? '')
    .replace(/[\s\S]/g, char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? ' ' : char)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  const safePart = (value, fallback) => {
    const cleaned = String(value ?? '')
    .replace(/[/\\:*?"<>|]+/g, ' ')
    .replace(/[\s\S]/g, char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? ' ' : char)
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
    const capped = [...cleaned].slice(0, 100).join('').replace(/[. ]+$/g, '').trim();
    // Windows rejects these names even with a normal-looking extension. ZIPs
    // often get unpacked there, so use a friendly deterministic fallback.
    return !capped || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(capped)
      ? fallback
      : capped;
  };
  const validPdfBase64 = (value) => {
    const pdfBase64 = String(value || '').replace(/\s/g, '');
    // Legacy saved workspaces may still contain embedded PDF bytes. Keep only
    // valid values while migrating them; new workspaces store PDFs as siblings.
    return pdfBase64.startsWith('JVBERi0') && /^[A-Za-z0-9+/]*={0,2}$/.test(pdfBase64)
      && pdfBase64.length % 4 === 0 ? pdfBase64 : '';
  };
  // `pdfBase64` was the original single-PDF payload. Retain it solely as a
  // migration source for already-saved application workspaces: it was always
  // the résumé PDF, never the cover letter.
  const resumePdfBase64 = validPdfBase64(raw.resumePdfBase64 || raw.pdfBase64);
  const coverLetterPdfBase64 = validPdfBase64(raw.coverLetterPdfBase64);
  const syncEndpoint = String(raw.sync?.endpoint || '');
  const syncToken = String(raw.sync?.token || '');
  const syncDocument = (value) => {
    const pdfSha256 = String(value?.pdfSha256 || '').toLowerCase();
    const htmlSha256 = String(value?.htmlSha256 || '').toLowerCase();
    return {
      pdfSha256: /^[a-f0-9]{64}$/.test(pdfSha256) ? pdfSha256 : '',
      htmlSha256: /^[a-f0-9]{64}$/.test(htmlSha256) ? htmlSha256 : '',
    };
  };
  const sync = /^http:\/\/127\.0\.0\.1:43192\/application-sync$/.test(syncEndpoint)
    && /^[a-f0-9]{64}$/i.test(syncToken)
    ? {
      endpoint: syncEndpoint,
      token: syncToken,
      version: 2,
      documents: {
        resume: syncDocument(raw.sync?.documents?.resume),
        cover: syncDocument(raw.sync?.documents?.cover),
      },
    }
    : {
      endpoint: '', token: '', version: 2,
      documents: { resume: syncDocument(null), cover: syncDocument(null) },
    };
  const rawAudit = raw.coverLetterAudit && typeof raw.coverLetterAudit === 'object'
    && !Array.isArray(raw.coverLetterAudit) ? raw.coverLetterAudit : null;
  const boundedIndex = (value) => Number.isInteger(value) && value >= 0 && value <= 999 ? value : null;
  const coverLetterAudit = rawAudit ? {
    version: 1,
    rankedNeeds: (Array.isArray(rawAudit.rankedNeeds) ? rawAudit.rankedNeeds : []).slice(0, 12).map(need => ({
      need: auditText(need?.need, 320),
      quote: auditText(need?.quote, 420),
      source: ['posting', 'research'].includes(String(need?.source || '')) ? String(need.source) : '',
      decisiveness: Number.isInteger(need?.decisiveness) && need.decisiveness >= 1 && need.decisiveness <= 100
        ? need.decisiveness : null,
      kind: auditText(need?.kind, 48),
      emphasisReason: auditText(need?.emphasisReason, 420),
    })),
    finalPlan: {
      roleThesis: auditText(rawAudit.finalPlan?.roleThesis, 600),
      mappings: (Array.isArray(rawAudit.finalPlan?.mappings) ? rawAudit.finalPlan.mappings : []).slice(0, 4).map(mapping => ({
        needIndex: boundedIndex(mapping?.needIndex),
        need: auditText(mapping?.need, 320),
        evidence: auditText(mapping?.evidence, 600),
        evidenceRole: auditText(mapping?.evidenceRole, 160),
        achievementIds: (Array.isArray(mapping?.achievementIds) ? mapping.achievementIds : []).slice(0, 12)
          .map(id => auditText(id, 120)).filter(Boolean),
        resumeStatus: auditText(mapping?.resumeStatus, 32),
        inference: auditText(mapping?.inference, 600),
      })),
      companyHook: {
        detail: auditText(rawAudit.finalPlan?.companyHook?.detail, 320),
        source: auditText(rawAudit.finalPlan?.companyHook?.source, 48),
        whyItMattersToCandidate: auditText(rawAudit.finalPlan?.companyHook?.whyItMattersToCandidate, 500),
      },
      logistics: auditText(rawAudit.finalPlan?.logistics, 400),
      droppedNeeds: (Array.isArray(rawAudit.finalPlan?.droppedNeeds) ? rawAudit.finalPlan.droppedNeeds : []).slice(0, 12).map(item => ({
        needIndex: boundedIndex(item?.needIndex),
        reason: auditText(item?.reason, 400),
      })),
    },
    checks: (Array.isArray(rawAudit.checks) ? rawAudit.checks : []).slice(0, 24).map(check => ({
      id: auditText(check?.id, 80),
      passed: check?.passed === true,
      detail: auditText(check?.detail, 320),
    })),
    readiness: (Array.isArray(rawAudit.checks) ? rawAudit.checks : []).some(check => check?.passed !== true)
      ? 'review-required'
      : 'checks-passed',
    note: 'Deterministic checks support factual and structural review; they are not a persuasive-quality score.',
  } : undefined;
  return {
    company: safePart(raw.company, 'Company'),
    candidateName: safePart(raw.candidateName, 'Application'),
    jobUrl: safeJobPostingUrl(raw.jobUrl),
    jobMarkdown: String(raw.jobMarkdown || '').replace(/\r\n/g, '\n'),
    resumePdfBase64,
    coverLetterPdfBase64,
    sync,
    coverLetterAudit,
  };
}

/**
 * Add the Electron sync capability after the generated HTML has been assigned
 * its final on-disk workspace. Generation happens before the renderer knows
 * that folder, so this deliberately updates only the inert JSON data node;
 * it never regexes executable script text or accepts a client-selected path.
 */
export function embedApplicationSyncConfig(applicationHtml, sync) {
  const source = String(applicationHtml || '');
  const match = /(<script\s+id="ic-application-bundle-data"\s+type="application\/json"(?:\s+nonce="[^"]+")?>)([\s\S]*?)(<\/script>)/i.exec(source);
  if (!match) throw new Error('Generated application HTML is missing its sync configuration node.');
  let data;
  try { data = JSON.parse(match[2]); } catch { throw new Error('Generated application HTML has invalid sync configuration data.'); }
  const normalized = normaliseResumeDownloadBundle({ sync });
  if (!normalized.sync.endpoint || !normalized.sync.token) throw new Error('Application sync configuration is invalid.');
  data = { ...(data && typeof data === 'object' ? data : {}), sync: normalized.sync };
  const encoded = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${source.slice(0, match.index)}${match[1]}${encoded}${match[3]}${source.slice(match.index + match[0].length)}`;
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
      category: String(value.resumeCategory || value.category || '').trim(),
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

// The histogram is intentionally kept generic: Local AI output can return an
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

// Normalize a chunk of (possibly tagged) HTML into a bare lowercase
// letters+digits key: strip tags, decode the handful of entities the model
// or the design system might use for a label ("Safety &amp; Response" /
// "Safety &#39;n&#39; Response" etc.), lowercase, collapse whitespace, then
// drop everything that isn't alphanumeric. Used BOTH to key a group's display
// label for de-duplication and to read an existing `<dt>`'s inner HTML for
// merge matching, so "Safety &amp; Response" (model-escaped) and "Safety &
// Response" (already-decoded résumé markup) resolve to the identical key
// regardless of case, punctuation, or nested tags.
function skillLabelKey(raw) {
  return String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^a-z0-9]+/g, '');
}

// The model never gets to write this HTML. Every proposed inferred skill is
// structurally present but hidden, and only the local review decision can
// reveal it. Keeping it in the actual .skills surface means a verified choice
// participates in screen preview, print and edited-HTML downloads alike.
//
// Verify insights are grouped by `category` (a model-supplied 1-3 word Title
// Case domain label, e.g. "Safety & Response"; empty -> "Additional") so a
// verified skill files under a DOMAIN, not under "how it was found" — the
// old hardcoded "Role-fit (verified)" row this replaced was tooling
// vocabulary leaking into a recruiter-facing résumé. Each group is placed
// against the résumé's OWN `<dl class="skills">`, in first-seen order:
//   - MERGE into an existing `<dt>` whose skillLabelKey() matches the
//     group's — the group's skills are appended to the END of that `<dt>`'s
//     `<dd>`, each preceded by its own separator span. No new `<dt>` is
//     created and no marker attribute goes on that `<dd>`: the row is
//     already visible because it holds real corpus-backed skills. UNLESS the
//     matched `<dd>` is degenerate (blank once tags are stripped — nothing
//     for a leading separator to join to), in which case the appended run
//     uses CREATED-style markup instead (see below) so no stray leading `·`
//     renders; it still appends into that same `<dd>`, no second row.
//   - Otherwise CREATE a new `<dt data-ic-inferred-label>` / `<dd
//     data-ic-inferred-group>` pair before `</dl>` (first skill has no
//     leading separator; the rest do).
// With no `<dl class="skills">` to merge into (or no closing `</dl>`), every
// group falls back to a CREATED pair inside a synthesized section, since
// there is nothing to merge into.
//
// Every `data-ic-inferred-separator` is written with a VALUE that states its
// own visibility rule, rather than making the browser infer one from DOM
// shape — the injector is the only place that reliably knows whether real
// (always-visible) corpus content precedes a given separator:
//   - `="join"`  (non-degenerate merge): real content precedes the WHOLE
//     appended run, so the separator is visible iff its own next inferred
//     skill is visible. No backward walk needed or performed.
//   - `="between"` (created `<dd>`, and degenerate-merge appends): only a
//     previously-verified inferred skill can precede it, so the separator is
//     visible iff its next inferred skill is visible AND at least one
//     earlier `[data-ic-inferred-skill]` in the same parent is visible.
// (A real design-system `<dd>` is BARE TEXT with `<span class="sep">`
// elements between items — e.g. `<dd>Go<span class="sep">·</span>Rust</dd>` —
// so a single real skill leaves NO element before an appended separator.
// Encoding "join" at injection time means the runtime never has to walk
// `previousElementSibling` hunting for that invisible text.)
//
// `category` is therefore only ever used two ways: as an escaped display
// label (through escapeHtml, exactly like every other model string here) and
// as a normalized MATCH KEY against existing `<dt>` text. It is never trusted
// as markup and never interpolated unescaped, and — like every inferred
// skill/separator/created label/group — everything it produces still carries
// ` hidden` unless `showAllVerifySkills` is true.
function injectInferredSkills(mainHtml, insights, showAllVerifySkills = false) {
  const verify = insights.filter(item => item.kind === 'verify');
  if (!verify.length) return mainHtml;
  const hiddenAttr = showAllVerifySkills ? '' : ' hidden';

  const sepSpan = (rule) => `<span class="sep" data-ic-inferred-separator="${rule}"${hiddenAttr} aria-hidden="true">·</span>`;
  const skillSpan = (item) => `<span class="ic-inferred-skill" data-ic-inferred-skill="${escapeHtml(item.id)}"${hiddenAttr}>${escapeHtml(item.resumeText || item.skill)}</span>`;
  // Freshly CREATED <dd> (or a degenerate merge target treated the same way):
  // nothing precedes the first skill; every later one is a "between" join.
  const createdSkillsMarkup = (items) => items.map((item, index) => `${index ? sepSpan('between') : ''}${skillSpan(item)}`).join('');
  // Appending to a NON-degenerate EXISTING <dd>: real corpus skills always
  // precede the first appended item, so every appended skill is a "join".
  const appendedSkillsMarkup = (items) => items.map(item => `${sepSpan('join')}${skillSpan(item)}`).join('');

  // Group by category, case/punctuation-insensitive, preserving the
  // first-seen original spelling as the display label. Empty -> "Additional".
  const groups = [];
  const groupByKey = new Map();
  for (const item of verify) {
    const label = item.category || 'Additional';
    const key = skillLabelKey(label);
    let group = groupByKey.get(key);
    if (!group) {
      group = { key, label, items: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  const createdEntry = (group) =>
    `<dt data-ic-inferred-label${hiddenAttr}>${escapeHtml(group.label)}</dt>\n  <dd data-ic-inferred-group${hiddenAttr}>${createdSkillsMarkup(group.items)}</dd>`;

  // NOTE: the boundary check after the bare (unquoted) `skills` alternative is
  // a LOOKAHEAD, not a consuming match. A consuming `(?:\s|>|\/)` here (as
  // this line originally read) treats the tag's own closing `>` as that
  // required character, then lets the following `[^>]*>` overshoot into the
  // NEXT tag hunting for another `>` — so `<dl class="skills">` (nothing
  // after the class attribute) would over-match into `<dt>`. That was inert
  // in the old caller here (it only used this match's length as a
  // `.indexOf('</dl>', …)` search-start, never sliced on it), but this
  // function now slices `mainHtml` at exactly that offset to parse the
  // existing `<dt>/<dd>` pairs, so the overshoot must not happen.
  const skillsOpen = /<dl\b[^>]*\bclass\s*=\s*(?:"[^"]*\bskills\b[^"]*"|'[^']*\bskills\b[^']*'|skills(?=\s|>|\/))[^>]*>/i.exec(mainHtml);
  const closeAt = skillsOpen ? mainHtml.indexOf('</dl>', skillsOpen.index + skillsOpen[0].length) : -1;

  if (skillsOpen && closeAt >= 0) {
    const innerStart = skillsOpen.index + skillsOpen[0].length;
    let inner = mainHtml.slice(innerStart, closeAt);

    // Find every <dt>/<dd> pair INSIDE this one <dl> slice only, so a merge
    // target can never resolve against markup outside the skills list. A
    // <dt> with nested markup is handled by skillLabelKey() stripping tags.
    // `blank` flags a <dd> that is whitespace-only once ITS OWN tags are
    // stripped (e.g. a placeholder <dd></dd>) — nothing for a "join"
    // separator to join to, so such a target gets created-style markup.
    const pairRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
    const pairs = [];
    let pairMatch;
    while ((pairMatch = pairRe.exec(inner))) {
      pairs.push({
        key: skillLabelKey(pairMatch[1]),
        ddCloseIndex: pairMatch.index + pairMatch[0].length - '</dd>'.length,
        blank: /^\s*$/.test(pairMatch[2].replace(/<[^>]*>/g, '')),
      });
    }

    const createGroups = [];
    const merges = [];
    for (const group of groups) {
      const pair = pairs.find(p => p.key === group.key);
      if (pair) merges.push({ ddCloseIndex: pair.ddCloseIndex, group, blank: pair.blank });
      else createGroups.push(group);
    }

    // Insert from the last position backward so an earlier insertion's
    // offset shift never invalidates a later (already-computed) index.
    merges.sort((a, b) => b.ddCloseIndex - a.ddCloseIndex);
    for (const { ddCloseIndex, group, blank } of merges) {
      const markup = blank ? createdSkillsMarkup(group.items) : appendedSkillsMarkup(group.items);
      inner = inner.slice(0, ddCloseIndex) + markup + inner.slice(ddCloseIndex);
    }

    const created = createGroups.map(createdEntry).join('\n  ');
    if (created) inner = `${inner}\n  ${created}\n`;

    return `${mainHtml.slice(0, innerStart)}${inner}${mainHtml.slice(closeAt)}`;
  }

  // Fallback: no <dl class="skills"> to merge into — every group becomes a
  // created <dt>/<dd> pair inside a synthesized section.
  const allCreated = groups.map(createdEntry).join('\n  ');
  const fallback = `\n<section class="section ic-inferred-skills-section" data-ic-inferred-section${hiddenAttr}>\n  <div class="section-head"><h2>Skills</h2><span class="rule" aria-hidden="true"></span></div>\n  <dl class="skills">\n  ${allCreated}\n  </dl>\n</section>\n`;
  return mainHtml.replace(/<\/main>\s*$/i, `${fallback}</main>`);
}

function buildSkillWorkspace({ skillInsights, skillHistogram, jobContext, jobUrl, skillOpportunityError, coverLetterCheckSummary }) {
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
  const candidateLocation = String(jobContext?.candidateLocation || '').trim();
  const jobLocation = String(jobContext?.location || jobContext?.jobLocation || '').trim();
  const cityKey = value => String(value || '').split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const locationMismatch = candidateLocation && jobLocation && !/\bremote\b/i.test(jobLocation)
    && cityKey(candidateLocation) && cityKey(jobLocation) && cityKey(candidateLocation) !== cityKey(jobLocation);
  const context = [title, company].filter(Boolean).join(' · ')
    || (contextRoles.length ? `Tailored for ${contextRoles.join(' · ')}` : 'Review high-value adjacent skills before export.');
  const safeOriginalJobUrl = safeJobPostingUrl(jobUrl);
  const originalJobLink = safeOriginalJobUrl
    ? `<a class="ic-job-posting-link" href="${escapeHtml(safeOriginalJobUrl)}" target="_blank" rel="noopener noreferrer">View original job posting</a>`
    : '';
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
  const locationCheck = locationMismatch ? `<article class="ic-insight-card" data-ic-location-check="work-location">
  <p class="ic-insight-skill">Confirm work location</p>
  <p class="ic-insight-meta">required before Sync</p>
  <p class="ic-insight-copy"><span class="ic-insight-label">Current résumé:</span> ${escapeHtml(candidateLocation)}</p>
  <p class="ic-insight-copy"><span class="ic-insight-label">On-site job:</span> ${escapeHtml(jobLocation)}</p>
  <p class="ic-insight-prompt"><span class="ic-insight-label">Check:</span> Can you reliably work in this job location (including an actual relocation plan, if needed)?</p>
  <div class="ic-insight-actions"><button type="button" data-ic-location-action="confirmed" aria-pressed="false">I can work there</button></div>
</article>` : '';
  return {
    insights,
    markup: `<aside class="ic-workspace-sidebar" aria-label="Résumé tailoring workspace">
  <p class="ic-workspace-kicker">Application workspace</p>
  <h1 class="ic-workspace-title">Application, with receipts.</h1>
  <p class="ic-workspace-context">${escapeHtml(context)}</p>
  ${originalJobLink}
  ${coverLetterCheckSummary ? `<p class="ic-panel-note" role="status">${escapeHtml(coverLetterCheckSummary)}</p>` : ''}
  <div id="ic-skill-workspace-data" data-ic-workspace="${escapeHtml(json)}" hidden></div>
  <div class="ic-toolbar" role="toolbar" aria-label="Document controls">
    <button type="button" id="ic-edit-toggle" class="ic-btn">Edit</button>
    <button type="button" id="ic-sync-btn" class="ic-btn ic-btn-primary">Sync résumé</button>
    ${printVariantIndicator(jobContext)}
    <span id="ic-pdf-bundle-note" class="ic-restore-note" role="status"></span>
    <span id="ic-restore-note" class="ic-restore-note" hidden>Restored your edits from this browser.</span>
    <span class="ic-hint">Sync re-renders the PDF with the same engine that produced the originals — use it instead of your browser’s print dialog.</span>
  </div>
  <div class="ic-banner ic-font-warning" id="ic-font-warning" role="status" hidden>Web fonts didn’t load. Check your internet connection or content blocker, then reopen this application before syncing. Sync refuses to replace a PDF with fallback typography.</div>
  <section class="ic-panel" aria-labelledby="ic-check-title">
    <div class="ic-panel-head"><h2 class="ic-panel-title" id="ic-check-title">Needs your check</h2><span id="ic-review-progress" class="ic-panel-note"></span></div>
    <span id="ic-review-status" class="ic-review-status" role="status"></span>
    ${locationCheck}${verify.length ? verify.map(card).join('') : (locationCheck ? '' : '<p class="ic-panel-note">No high-impact claims need confirmation.</p>')}
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
 * Identity of one generated document revision. Autosaved browser edits carry
 * this value so a regenerated application can tell markup it actually shipped
 * from a superseded draft still sitting in localStorage. Truncated SHA-256: this
 * is a staleness check, not a security boundary — the restored markup is still
 * put through the full editable-markup sanitizer either way.
 */
function documentMarkupFingerprint(markup) {
  const text = String(markup || '');
  if (!text.trim()) return '';
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Build the toolbar/banner markup + behavior script injected into `<body>`.
 *
 * Edit mode (§5.5): `Job Application Design System/readme.md:15-19` documents the
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
 * Fonts (§5.3): uses the same DOM-side face matrix as the hidden PDF renderer
 * and shows a print-hidden banner when any required web face failed. The
 * design system loads these faces from Google Fonts, so the message directs
 * the user to connectivity/content blocking rather than package repair.
 */
function buildInjectedChrome({ docId, kind, workspace = false, downloadBundle, scriptNonce, resumeFingerprint = '', coverFingerprint = '' }) {
  const safeDocId = docId ? String(docId) : `${kind}-untitled`;
  const bundle = normaliseResumeDownloadBundle(downloadBundle);
  const bundleJson = JSON.stringify(bundle).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const isResumeBundle = kind === 'resume';
  // The interactive edit/autosave/Sync chrome is shared by the résumé's own
  // main.page and a standalone cover letter's main.page. Sanitizing a letter
  // through the résumé's class allowlist would strip every letter-* class on
  // a restore, so the kind fed to the sanitizer must track what this
  // document actually is, not the résumé slot the storage key reuses.
  const standaloneSanitizeKind = kind === 'cover-letter' ? 'cover' : 'resume';
  const syncHint = 'Sync re-renders the PDF with the same engine that produced the originals \u2014 use it instead of your browser\u2019s print dialog.';

  const chromeMarkup = workspace ? '' : `<div class="ic-toolbar" role="toolbar" aria-label="Document controls">
  <button type="button" id="ic-edit-toggle" class="ic-btn">Edit</button>
  <button type="button" id="ic-sync-btn" class="ic-btn ic-btn-primary"${isResumeBundle ? '' : ' hidden'}>${isResumeBundle ? 'Sync résumé' : 'Sync edited copy'}</button>
  ${PRINT_VARIANT_INDICATOR}
  ${isResumeBundle ? '<span id="ic-pdf-bundle-note" class="ic-restore-note" role="status"></span>' : ''}
  <span id="ic-restore-note" class="ic-restore-note" hidden>Restored your edits from this browser.</span>
  <span class="ic-hint">${escapeHtml(syncHint)}</span>
</div>
<div class="ic-banner ic-font-warning" id="ic-font-warning" role="status" hidden>Web fonts didn\u2019t load. Check your internet connection or content blocker, then reopen this application before syncing. Sync refuses to replace a PDF with fallback typography.</div>
`;
  const html = `${chromeMarkup}<script id="ic-application-bundle-data" type="application/json" nonce="${escapeHtml(scriptNonce)}">${bundleJson}</script><script nonce="${escapeHtml(scriptNonce)}">
(function () {
${editableRuntimeSanitizerSource()}
  var DOC_ID = ${jsStringLiteral(safeDocId)};
  var HAS_APPLICATION_BUNDLE = ${isResumeBundle ? 'true' : 'false'};
  var bundleDataElement = document.getElementById('ic-application-bundle-data');
  var BUNDLE_DATA = {};
  try { BUNDLE_DATA = JSON.parse(bundleDataElement ? bundleDataElement.textContent : '{}') || {}; } catch (e) {}
  var STORAGE_KEY = 'ic-edit:' + DOC_ID;
  var main = document.querySelector('main.page') || document.querySelector('main');
  var resumeMain = main;
  var coverMain = document.querySelector('[data-ic-document-panel="cover"] main');
  var activeDocument = 'resume';
  var documentTabs = Array.prototype.slice.call(document.querySelectorAll('[data-ic-document-tab]'));
  var editBtn = document.getElementById('ic-edit-toggle');
  var syncBtn = document.getElementById('ic-sync-btn');
  var printVariantNote = document.getElementById('ic-print-variant-note');
  var pdfBundleNote = document.getElementById('ic-pdf-bundle-note');
  var restoreNote = document.getElementById('ic-restore-note');
  var fontWarning = document.getElementById('ic-font-warning');
  var saveTimer = null;
  var skillStorageKey = 'ic-skill-review:' + DOC_ID;
  var skillCards = Array.prototype.slice.call(document.querySelectorAll('[data-ic-insight][data-ic-kind="verify"]'));
  var skillDecisions = {};
  var locationCard = document.querySelector('[data-ic-location-check]');
  var locationStorageKey = 'ic-location-review:' + DOC_ID;
  var locationConfirmed = !!(locationCard && locationCard.getAttribute('data-ic-location-decision') === 'confirmed');
  // Each document has its own exported companion. A résumé edit must never
  // invalidate a still-current cover-letter PDF (and vice versa).
  var pdfStale = { resume: false, cover: false };
  var syncMessage = '';
  var reconcileNoticeKey = 'ic-pdf-reconcile:' + DOC_ID;
  try {
    syncMessage = sessionStorage.getItem(reconcileNoticeKey) || '';
    sessionStorage.removeItem(reconcileNoticeKey);
  } catch (e) {}
  // Keystrokes, skill-decision clicks, and tab switches all funnel into
  // updateSync(). Without this flag one of those firing mid-fetch re-enables
  // the button and overwrites the 'Syncing…' state while the POST is still
  // in flight, inviting a second concurrent sync request.
  var syncInFlight = false;
  var initialResumeMarkup = resumeMain ? resumeMain.innerHTML : '';
  // The generated file is the source of truth. Browser-saved edits are only
  // meaningful against the revision they were typed over, so each autosave slot
  // is stamped with the fingerprint the GENERATOR computed for the markup this
  // file shipped with. Regenerating the application changes that fingerprint and
  // the superseded copy is dropped rather than replayed over fresh content — the
  // failure mode being an old draft silently masking (and, through Sync,
  // overwriting) a newer document the generator had just written to disk.
  // Stamped at generation rather than hashed here so the value is a property of
  // the file, inspectable without executing it, and independent of how a given
  // browser round-trips innerHTML.
  //
  // Sync deliberately does NOT recompute these. It merges the edited main back
  // into the file, so afterwards the stamp describes markup the file no longer
  // has — that looks like a bug and is not one. The stamp identifies the
  // GENERATION, not the current bytes. Recomputing it on Sync would strand every
  // edit typed after that Sync: those autosave under the old stamp, and the next
  // load would move them to :superseded, which nothing can read. That is the
  // exact data loss this guard exists to prevent.
  var RESUME_MARKUP_FINGERPRINT = ${jsStringLiteral(resumeFingerprint)};
  var COVER_MARKUP_FINGERPRINT = ${jsStringLiteral(coverFingerprint)};
  // A standalone cover letter's only main.page binds to main/resumeMain
  // below (there is no separate cover panel to route it through), so this
  // tracks what the DOCUMENT actually is rather than always assuming resume.
  var MAIN_SANITIZE_KIND = ${jsStringLiteral(standaloneSanitizeKind)};
  function icReadAutosave(key, fingerprint) {
    if (!fingerprint) return null;
    var saved = null;
    try { saved = localStorage.getItem(key); } catch (e) { return null; }
    if (!saved) return null;
    var stamped = null;
    try { stamped = localStorage.getItem(key + ':fingerprint'); } catch (e) {}
    if (stamped === fingerprint) return saved;
    // Unstamped entries predate this guard and cannot be shown to match, so
    // they are treated as superseded for the same reason a mismatch is.
    // Superseded is not the same as worthless: this slot is only ever written by
    // a real edit, and an edit that was never Synced exists nowhere else. Move it
    // aside instead of deleting it so it stays recoverable. If the stash throws
    // (quota), the removes never run and the payload is left where it was.
    try {
      localStorage.setItem(key + ':superseded', saved);
      localStorage.removeItem(key);
      localStorage.removeItem(key + ':fingerprint');
    } catch (e) {}
    return null;
  }
  function icWriteAutosave(key, markup, fingerprint) {
    try {
      localStorage.setItem(key, markup);
      localStorage.setItem(key + ':fingerprint', fingerprint);
    } catch (e) {}
  }
  var trustedResumeDerivations = icTrustedDerivationMap(resumeMain);
  icInstallPlainTextEditing(resumeMain);
  icInstallPlainTextEditing(coverMain);

  function persistBundleData() {
    if (bundleDataElement) bundleDataElement.textContent = JSON.stringify(BUNDLE_DATA).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  }
  function documentLabel(kind) {
    return kind === 'cover' ? 'cover letter' : 'résumé';
  }
  function markPdfStale(kind) {
    if (HAS_APPLICATION_BUNDLE) {
      pdfStale[kind === 'cover' ? 'cover' : 'resume'] = true;
      updateSync();
    }
  }
  function updateSync() {
    if (!syncBtn || !HAS_APPLICATION_BUNDLE || syncInFlight) return;
    var reviewBlocked = skillCards.some(function (card) { return !skillDecisions[card.getAttribute('data-ic-insight')]; });
    var configured = !!(BUNDLE_DATA.sync && BUNDLE_DATA.sync.endpoint && BUNDLE_DATA.sync.token);
    var locationBlocked = !!locationCard && !locationConfirmed;
    var blocked = locationBlocked || (activeDocument === 'resume' && reviewBlocked);
    syncBtn.disabled = blocked || !configured;
    syncBtn.setAttribute('aria-disabled', String(blocked || !configured));
    syncBtn.textContent = 'Sync ' + documentLabel(activeDocument);
    syncBtn.title = locationBlocked ? 'Confirm that you can work in the on-site job location before syncing.'
      : (blocked ? 'Resolve every high-impact skill check before syncing the résumé.'
      : (!configured ? 'This copy has not been saved by Infinite Canvas yet.' : 'Render and replace the current ' + documentLabel(activeDocument) + ' PDF in this application folder.'));
    if (pdfBundleNote) {
      if (locationBlocked) { syncMessage = ''; pdfBundleNote.textContent = 'Confirm the on-site work location before syncing.'; }
      else if (blocked) { syncMessage = ''; pdfBundleNote.textContent = 'Resolve skill checks before syncing the résumé.'; }
      else if (!configured) { syncMessage = ''; pdfBundleNote.textContent = 'Save this application from Infinite Canvas before Sync is available.'; }
      // pdfStale is per-document on purpose: a résumé edit must not imply the
      // still-current cover-letter PDF is out of date. Saying which one drifted
      // is the whole point of tracking it — a stale PDF beside a fresh HTML is
      // the one failure mode of this workspace a user cannot see for themselves.
      else if (pdfStale[activeDocument]) pdfBundleNote.textContent = syncMessage || ('This ' + documentLabel(activeDocument) + ' has changed since its PDF was written — Sync to replace it.');
      else pdfBundleNote.textContent = syncMessage || ('Sync renders a fresh ' + documentLabel(activeDocument) + ' PDF and replaces it in this folder.');
    }
  }

  // This is deliberately an explanation, not an override. The model selected
  // the shared résumé/cover-letter paper profile from the employer and job
  // context; Sync must preserve that tailored decision. Name both the visible
  // result and the selection rationale so a white PDF cannot be mistaken for a
  // broken dual-mode render. ink-only now flips the on-screen preview to
  // white too (colors_and_type.css §10.3 / STYLE.md §10.3), so "white in
  // viewers and print" is literally true of the page the user is looking at,
  // not just of the eventual export.
  if (printVariantNote) {
    var paperContext = printVariantNote.getAttribute('data-ic-paper-context') || '';
    var paperDecisionReasonLead = paperContext
      ? 'analysis for ' + paperContext + ' indicates'
      : 'the company or role appears';
    printVariantNote.textContent = document.documentElement.getAttribute('data-print') === 'ink-only'
      ? 'AI paper decision: Flat white PDF — white in viewers and print; ' + paperDecisionReasonLead + (paperContext ? ' an ' : ' ') + 'ATS-heavy, enterprise, regulated, or otherwise conservative recipient profile.'
      : 'AI paper decision: Dual-mode PDF — cream in viewers, white in print; ' + paperDecisionReasonLead + (paperContext ? ' a ' : ' ') + 'design-conscious, startup-oriented, or craft-focused recipient profile.';
  }

  function selectDocument(kind) {
    if (kind !== 'resume' && kind !== 'cover') return;
    stopEditing();
    activeDocument = kind;
    main = kind === 'cover' ? coverMain : resumeMain;
    Array.prototype.slice.call(document.querySelectorAll('[data-ic-document-panel]')).forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-ic-document-panel') !== kind;
    });
    documentTabs.forEach(function (tab) {
      tab.setAttribute('aria-selected', String(tab.getAttribute('data-ic-document-tab') === kind));
      tab.setAttribute('tabindex', tab.getAttribute('data-ic-document-tab') === kind ? '0' : '-1');
    });
    if (editBtn) editBtn.textContent = 'Edit ' + (kind === 'cover' ? 'cover letter' : 'résumé');
    updateSync();
    updateSkillReviewStatus();
    if (window.icPageGuidesRecompute) window.icPageGuidesRecompute();
  }
  documentTabs.forEach(function (tab) {
    tab.addEventListener('click', function () { selectDocument(tab.getAttribute('data-ic-document-tab')); });
    tab.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var index = documentTabs.indexOf(tab);
      var next = documentTabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + documentTabs.length) % documentTabs.length];
      selectDocument(next.getAttribute('data-ic-document-tab'));
      next.focus();
    });
  });

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
  if (locationCard) {
    try { if (localStorage.getItem(locationStorageKey) === 'confirmed') locationConfirmed = true; } catch (e) {}
  }

  function inferredNodes(id, attribute) {
    return Array.prototype.slice.call(document.querySelectorAll('[' + attribute + ']')).filter(function (node) {
      return node.getAttribute(attribute) === id;
    });
  }
  function applySkillDecision(id, decision, persist) {
    var resumeBefore = resumeMain ? resumeMain.innerHTML : '';
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
    // Created groups only (a merged skill lives in an untagged <dd> that's
    // already visible — real corpus content — and needs no row toggling).
    Array.prototype.slice.call(document.querySelectorAll('[data-ic-inferred-group]')).forEach(function (group) {
      var groupVisible = Array.prototype.slice.call(group.querySelectorAll('[data-ic-inferred-skill]')).some(function (node) { return !node.hidden; });
      group.hidden = !groupVisible;
      var label = group.previousElementSibling;
      if (label && label.hasAttribute('data-ic-inferred-label')) label.hidden = !groupVisible;
    });
    // Each separator's data-ic-inferred-separator VALUE states its own
    // visibility rule (set once at injection time, when the real content
    // that precedes it is known for certain — see injectInferredSkills'
    // block comment). The runtime just applies whichever rule it's told:
    //   "join"    (real corpus content precedes the whole run) — visible iff
    //             its own next inferred skill is visible. No backward walk:
    //             a real <dd> is bare text between <span class="sep"> nodes,
    //             so a single real skill leaves no element to walk back to.
    //   "between" (only inferred skills can precede it — a created <dd>, or
    //             a degenerate merge target) — visible iff its next inferred
    //             skill is visible AND an earlier [data-ic-inferred-skill]
    //             sibling in the same parent is visible.
    Array.prototype.slice.call(document.querySelectorAll('[data-ic-inferred-separator]')).forEach(function (sep) {
      var rule = sep.getAttribute('data-ic-inferred-separator');
      var next = sep.nextElementSibling;
      var nextVisible = false;
      while (next) {
        if (next.hasAttribute('data-ic-inferred-skill')) { nextVisible = !next.hidden; break; }
        next = next.nextElementSibling;
      }
      if (rule === 'join') {
        sep.hidden = !nextVisible;
        return;
      }
      var earlierVisible = false;
      var prev = sep.previousElementSibling;
      while (prev) {
        if (prev.hasAttribute('data-ic-inferred-skill') && !prev.hidden) { earlierVisible = true; break; }
        prev = prev.previousElementSibling;
      }
      sep.hidden = !(nextVisible && earlierVisible);
    });
    var fallback = document.querySelector('[data-ic-inferred-section]');
    if (fallback) fallback.hidden = !Array.prototype.slice.call(fallback.querySelectorAll('[data-ic-inferred-skill]')).some(function (node) { return !node.hidden; });
    if (persist) {
      try { localStorage.setItem(skillStorageKey, JSON.stringify(skillDecisions)); } catch (e) {}
      if (resumeMain && resumeMain.innerHTML !== resumeBefore) markPdfStale('resume');
    }
    updateSkillReviewStatus();
  }
  function updateSkillReviewStatus() {
    var total = skillCards.length + (locationCard ? 1 : 0);
    var resolved = skillCards.filter(function (card) { return !!skillDecisions[card.getAttribute('data-ic-insight')]; }).length + (locationCard && locationConfirmed ? 1 : 0);
    var verified = skillCards.filter(function (card) { return skillDecisions[card.getAttribute('data-ic-insight')] === 'verified'; }).length;
    var progress = document.getElementById('ic-review-progress');
    var status = document.getElementById('ic-review-status');
    if (progress) progress.textContent = total ? resolved + ' / ' + total + ' resolved' : '';
    if (status) status.textContent = !total ? '' : (resolved < total
      ? 'Sync unlocks after every required location and high-impact claim check is resolved.'
      : (verified ? verified + ' verified skill' + (verified === 1 ? '' : 's') + ' included in this résumé.' : 'No inferred skills will be added to this résumé.'));
    updateSync();
  }
  skillCards.forEach(function (card) {
    var id = card.getAttribute('data-ic-insight');
    applySkillDecision(id, skillDecisions[id], false);
    Array.prototype.slice.call(card.querySelectorAll('[data-ic-skill-action]')).forEach(function (button) {
      button.addEventListener('click', function () { applySkillDecision(id, button.getAttribute('data-ic-skill-action'), true); });
    });
  });
  if (locationCard) {
    if (locationConfirmed) locationCard.setAttribute('data-ic-location-decision', 'confirmed');
    var locationButton = locationCard.querySelector('[data-ic-location-action="confirmed"]');
    if (locationButton) {
      locationButton.setAttribute('aria-pressed', String(locationConfirmed));
      locationButton.addEventListener('click', function () {
        locationConfirmed = true;
        locationCard.setAttribute('data-ic-location-decision', 'confirmed');
        locationButton.setAttribute('aria-pressed', 'true');
        try { localStorage.setItem(locationStorageKey, 'confirmed'); } catch (e) {}
        updateSkillReviewStatus();
      });
    }
  }
  if (resumeMain && resumeMain.innerHTML !== initialResumeMarkup) markPdfStale('resume');
  updateSkillReviewStatus();
  selectDocument('resume');

  // A file:// page has no authority to read its sibling PDFs. Ask the same
  // capability-scoped loopback bridge used by Sync to compare the fixed
  // Resume.pdf and Cover Letter.pdf paths with the revision hashes embedded in
  // this file. If an otherwise-unmodified PDF has newer text, the bridge
  // imports that text into the trusted editable panel and atomically saves the
  // HTML before this page reloads. Ambiguous two-sided edits are reported as a
  // conflict instead of silently choosing a winner.
  function reconcileExternalPdfsOnOpen() {
    if (!HAS_APPLICATION_BUNDLE) return;
    if (typeof fetch !== 'function') return;
    var sync = BUNDLE_DATA.sync || {};
    if (!sync.endpoint || !sync.token) return;
    fetch(sync.endpoint, {
      method: 'POST', mode: 'cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sync.token, action: 'reconcile' })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok || !body.success) throw new Error(body.error || 'Infinite Canvas could not compare the sibling PDFs.');
        var imported = Array.isArray(body.importedDocuments) ? body.importedDocuments : [];
        var stale = Array.isArray(body.staleDocuments) ? body.staleDocuments : [];
        var conflicts = Array.isArray(body.conflicts) ? body.conflicts : [];
        var variantMismatches = Array.isArray(body.variantMismatches) ? body.variantMismatches : [];
        stale.forEach(function (kind) { if (kind === 'resume' || kind === 'cover') pdfStale[kind] = true; });
        if (variantMismatches.length) {
          syncMessage = variantMismatches.map(function (item) {
            var label = item.document === 'cover' ? 'Cover letter' : 'Résumé';
            return label + ' PDF uses ' + (item.actual === 'dual-pdf' ? 'a cream viewer background' : 'a flat white background')
              + ', but this application selected ' + (item.expected === 'dual-pdf' ? 'dual-mode cream' : 'flat white') + '. Sync to repair it.';
          }).join(' ');
        }
        if (conflicts.length) {
          var conflictMessage = conflicts.map(function (item) {
            return (item.document === 'cover' ? 'Cover letter' : 'Résumé') + ' PDF and HTML both changed; automatic import was paused to protect both revisions.';
          }).join(' ');
          syncMessage = [syncMessage, conflictMessage].filter(Boolean).join(' ');
        }
        if (stale.length || variantMismatches.length || conflicts.length) updateSync();
        if (!imported.length) return;
        imported.forEach(function (kind) {
          var key = kind === 'cover' ? STORAGE_KEY + ':cover' : STORAGE_KEY;
          try {
            localStorage.removeItem(key);
            localStorage.removeItem(key + ':fingerprint');
          } catch (e) {}
        });
        var labels = imported.map(documentLabel).join(' and ');
        try { sessionStorage.setItem(reconcileNoticeKey, 'Imported the updated ' + labels + ' PDF contents into this HTML workspace.'); } catch (e) {}
        window.location.reload();
      });
    }).catch(function (error) {
      var message = error && error.message ? error.message : '';
      syncMessage = !message || /fetch|network|load failed/i.test(message)
        ? 'Automatic PDF comparison could not reach Infinite Canvas. Keep the app running, then reopen this file.'
        : message;
      updateSync();
    });
  }
  reconcileExternalPdfsOnOpen();

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
      var saved = icReadAutosave(STORAGE_KEY, RESUME_MARKUP_FINGERPRINT);
      if (saved) {
        // Parse/sanitize in a detached template first. Assigning legacy rich
        // HTML directly to a connected main can fire an image/event payload
        // before any later cleanup gets a chance to run.
        main.innerHTML = icSanitizeEditableMarkup(saved, MAIN_SANITIZE_KIND, trustedResumeDerivations);
        if (restoreNote) restoreNote.hidden = false;
        markPdfStale('resume');
      }
    } catch (e) { /* localStorage unavailable (e.g. file:// under strict privacy settings) — degrade to no-autosave */ }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        // The main variable follows the selected tab. Capture the stable résumé node so
        // switching to the cover tab during the debounce cannot save cover
        // markup into the résumé's storage slot.
        icWriteAutosave(STORAGE_KEY, icSanitizeEditableMarkup(resumeMain.innerHTML, MAIN_SANITIZE_KIND, trustedResumeDerivations), RESUME_MARKUP_FINGERPRINT);
      }, 500);
    }
    main.addEventListener('input', function () {
      scheduleSave();
      markPdfStale('resume');
      if (window.icPageGuidesRecompute) window.icPageGuidesRecompute();
    });
  }
  if (coverMain) {
    try {
      var savedCover = icReadAutosave(STORAGE_KEY + ':cover', COVER_MARKUP_FINGERPRINT);
      if (savedCover) {
        coverMain.innerHTML = icSanitizeEditableMarkup(savedCover, 'cover');
        // Same disclosure the resume path makes. Swapping the letter out from
        // under the reader with no notice is how a stale draft passes for the
        // generated one.
        if (restoreNote) restoreNote.hidden = false;
        markPdfStale('cover');
      }
    } catch (e) {}
    var coverSaveTimer = null;
    coverMain.addEventListener('input', function () {
      if (coverSaveTimer) clearTimeout(coverSaveTimer);
      coverSaveTimer = setTimeout(function () {
        icWriteAutosave(STORAGE_KEY + ':cover', icSanitizeEditableMarkup(coverMain.innerHTML, 'cover'), COVER_MARKUP_FINGERPRINT);
      }, 500);
      markPdfStale('cover');
      if (window.icPageGuidesRecompute) window.icPageGuidesRecompute();
    });
  }

  // Reconcile inferred-skill visibility with the decision map AFTER the restores
  // above, because a restored payload replaces the whole resume main and brings
  // its own hidden-attribute state with it.
  //
  // Those two records drift apart by design: applySkillDecision persists the
  // decision (skillStorageKey) but never schedules a markup save — scheduleSave
  // fires only from the resume input handler — so every decision made after
  // the last keystroke is missing from the saved markup. The earlier replay at
  // the skillCards wiring pass therefore governs a DOM that :2025 then throws
  // away, and nothing re-asserts it.
  //
  // The decision map is what the person actually clicked; the payload is only
  // where the resume happened to be when they last typed. The map wins. Left
  // unreconciled this ships a rejected skill into the resume and its PDF (or
  // drops a verified one) while the card and the review status say otherwise.
  // persist:false — this writes nothing and marks nothing stale; the restore
  // already called markPdfStale, and applySkillDecision ends in
  // updateSkillReviewStatus so the status line re-derives from the map.
  skillCards.forEach(function (card) {
    var id = card.getAttribute('data-ic-insight');
    applySkillDecision(id, skillDecisions[id], false);
  });

  function stopEditing() {
    if (!main) return;
    main.removeAttribute('contenteditable');
    if (editBtn) editBtn.textContent = 'Edit';
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
      }
    });
  }

  if (syncBtn) {
    syncBtn.addEventListener('click', function () {
      if (syncBtn.disabled || !HAS_APPLICATION_BUNDLE) return;
      var sync = BUNDLE_DATA.sync || {};
      if (!sync.endpoint || !sync.token) { updateSync(); return; }
      stopEditing();
      persistBundleData();
      var documentToSync = activeDocument === 'cover' ? 'cover' : 'resume';
      if (main) main.innerHTML = icSanitizeEditableMarkup(main.innerHTML, documentToSync, documentToSync === 'resume' ? trustedResumeDerivations : null);
      syncMessage = '';
      var currentHtml = '<!doctype html>\\n' + document.documentElement.outerHTML;
      syncInFlight = true;
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      if (pdfBundleNote) pdfBundleNote.textContent = 'Rendering a fresh ' + documentLabel(documentToSync) + ' PDF…';
      fetch(sync.endpoint, {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sync.token, document: documentToSync, html: currentHtml })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || !body.success) throw new Error(body.error || 'Infinite Canvas could not sync this application.');
          pdfStale[documentToSync] = false;
          syncMessage = 'Synced ' + documentLabel(documentToSync) + ' and replaced its PDF in this folder.';
          if (pdfBundleNote) pdfBundleNote.textContent = syncMessage;
        });
      }).catch(function (error) {
        var message = error && error.message ? error.message : '';
        if (!message || /fetch|network|load failed/i.test(message)) message = 'Infinite Canvas is not running or its Sync service is unavailable. Launch it, then try Sync again.';
        syncMessage = message;
        if (pdfBundleNote) pdfBundleNote.textContent = syncMessage;
      }).finally(function () { syncInFlight = false; updateSync(); });
    });
  }

  // ---- Web-font availability detection (§5.3) ----
  try {
    var check = function () {
      var readiness = ${webFontFacesReadyExpression({ details: true })};
      // A CSS @import can add FontFace records after the first fulfilled
      // document.fonts.ready promise. Always clear a speculative warning once
      // the requested document faces have settled, rather than leaving a stale
      // banner after Chrome served them from cache.
      if (fontWarning) fontWarning.hidden = !!readiness.loaded;
      return readiness;
    };
    var loadRequiredDocumentFaces = function () {
      var initial = ${webFontFacesReadyExpression({ details: true })};
      var requiredFaces = Array.isArray(initial.requiredFaces) ? initial.requiredFaces : [];
      var loads = document.fonts && document.fonts.load
        ? Promise.all(requiredFaces.map(function (descriptor) {
          return document.fonts.load(descriptor, 'A').catch(function () { return []; });
        }))
        : Promise.resolve();
      return loads.then(function () {
        return document.fonts && document.fonts.ready ? document.fonts.ready : null;
      }).then(check).catch(check);
    };
    if (window.document.fonts && document.fonts.ready && document.fonts.ready.then) {
      // Run now, after window load, and whenever Chrome finishes a later font
      // batch. This covers cached Google Fonts as well as slow networks.
      loadRequiredDocumentFaces();
      window.addEventListener('load', loadRequiredDocumentFaces, { once: true });
      if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', check);
    } else check();
  } catch (e) { /* font-loading API unsupported — this is an enhancement, degrade quietly */ }
})();
</script>`;

  return html;
}

// ---------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------

/**
 * Normalize the résumé model's output into a complete, single-file HTML
 * document: charset, ONE inlined `<style>` carrying the design-system CSS
 * followed by the injected `ic-` chrome (§5.2 — never a `<link>`, so the file
 * is double-click-openable with no sibling assets; fonts retain the design
 * system's documented CDN dependency), the resolved receipts
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
 * @param {object} [args.downloadBundle] Application-workspace metadata and
 *   Sync capability. The historical name remains for compatibility with
 *   already-saved HTML and tests; new workspaces keep PDFs as sibling files.
 *   A legacy `pdfBase64` is still accepted as résumé migration data.
 * @param {object} [args.coverLetter] Structured generated cover-letter fields.
 *   The cover is rendered into a second editable panel in this same HTML.
 * @param {string} [args.coverLetterCheckSummary] Modest factual status line
 *   shown only when the shipped letter retains deterministic check failures.
 * @param {boolean} [args.showAllVerifySkills] Internal page-fit mode: reveal
 *   every verify candidate to measure the largest user-approved print state.
 *   Final interactive documents leave this false and require explicit review.
 * @returns {string}
 */
export function buildResumeDocument({ resumeMainHtml, variantAttrs, ledger, docId, skillInsights, skillHistogram, jobContext, skillOpportunityError, coverLetterCheckSummary, showAllVerifySkills = false, downloadBundle, coverLetter } = {}) {
  let main = String(resumeMainHtml || '').trim();
  // Defensive: accept a fenced response, but let the DOM-based sanitizer find
  // the one real <main> element. Regex extraction is unsafe here: a script or
  // attribute can contain convincing literal "<main>" text.
  const fence = /```(?:html)?\s*([\s\S]*?)\s*```/i.exec(main);
  if (fence) main = fence[1].trim();
  // Decode any literal "\n"/"\t" the model left in the markup so they collapse as
  // HTML whitespace instead of printing verbatim (real newlines are untouched).
  main = decodeTextEscapes(main);
  main = sanitizeDocumentMainHtml(main, { documentKind: 'resume', allowHostState: false });
  main = stripMainVariantAttrs(main);
  main = neutralizeHighlightTextEmphasis(main);
  assertCandidateDashPunctuation({ resumeMainHtml: main, coverLetter });
  // Resolve/strip receipts BEFORE anything else touches the markup (§4.3 step 3).
  main = injectReceipts(main, ledger);
  const bundle = normaliseResumeDownloadBundle(downloadBundle);
  const workspace = buildSkillWorkspace({
    skillInsights, skillHistogram, jobContext, jobUrl: bundle.jobUrl,
    skillOpportunityError, coverLetterCheckSummary,
  });
  main = injectInferredSkills(main, workspace.insights, showAllVerifySkills);

  const attrs = variantAttrs != null ? variantAttrs : extractVariantAttrs(resumeMainHtml);
  const suppliedCover = coverLetter ? buildCoverLetterDocument({ letter: coverLetter, variantAttrs: attrs, docId: String(docId || 'application') + '-cover' }) : '';
  const suppliedCoverText = String(suppliedCover);
  // buildCoverLetterDocument places its standalone toolbar script BEFORE the
  // real <main>; that script itself contains strings such as
  // querySelector('main.page'). A broad /<main.*<\/main>/ match can therefore
  // begin inside JavaScript and accidentally embed a second toolbar + stale
  // bundle payload in the combined workspace. The actual document main is the
  // final literal <main> in the generated cover HTML.
  const coverStart = suppliedCoverText.toLowerCase().lastIndexOf('<main');
  const coverEnd = coverStart >= 0 ? suppliedCoverText.toLowerCase().indexOf('</main>', coverStart) : -1;
  let coverMain = coverStart >= 0 && coverEnd >= 0
    ? suppliedCoverText.slice(coverStart, coverEnd + '</main>'.length)
    : '<main class="page" role="document"><p>Cover letter was unavailable when this application was generated.</p></main>';
  const css = inlineStylesheets(CSS_FILES);
  const scriptNonce = createDocumentScriptNonce();
  const chrome = buildInjectedChrome({
    docId, kind: 'resume', workspace: true, downloadBundle, scriptNonce,
    resumeFingerprint: documentMarkupFingerprint(main),
    coverFingerprint: documentMarkupFingerprint(coverMain),
  });

  return `<!doctype html>
<html lang="en" ${attrs}>
<head>
<meta charset="utf-8">
${contentSecurityPolicyMeta(scriptNonce)}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Application Workspace</title>
<style>
${css}

${INJECTED_CHROME_CSS}
</style>
</head>
<body>
<div class="ic-resume-workspace">
${workspace.markup}
  <div class="ic-preview-area">
    <div class="ic-document-tabs" role="tablist" aria-label="Application documents">
      <button type="button" id="ic-resume-tab" class="ic-btn" role="tab" data-ic-document-tab="resume" aria-controls="ic-resume-panel" aria-selected="true" tabindex="0">Résumé</button>
      <button type="button" id="ic-cover-tab" class="ic-btn" role="tab" data-ic-document-tab="cover" aria-controls="ic-cover-panel" aria-selected="false" tabindex="-1">Cover letter</button>
    </div>
    <section id="ic-resume-panel" role="tabpanel" aria-labelledby="ic-resume-tab" data-ic-document-panel="resume"><div class="ic-page-stage">${main}<div class="ic-page-guides" aria-hidden="true" data-ic-page-guides></div></div></section>
    <section id="ic-cover-panel" role="tabpanel" aria-labelledby="ic-cover-tab" data-ic-document-panel="cover" hidden><div class="ic-page-stage">${coverMain}<div class="ic-page-guides" aria-hidden="true" data-ic-page-guides></div></div></section>
${chrome}
  </div>
</div>
<script nonce="${escapeHtml(scriptNonce)}">
(function () {
  'use strict';
  try {
    var stages = Array.prototype.slice.call(document.querySelectorAll('.ic-page-stage'));
    if (!stages.length) return;
    // .role-dates / .role-location are the right-hand cell of a two-column
    // (1fr auto) meta row — they sit far from the row's own left edge by
    // design, not because they start a new page. Testing them as independent
    // candidates makes columnIndexOf() below mistake a right-aligned date or
    // location for a second page. dd (skills values) has the same shape and
    // is redundant anyway: its paired dt already reports that row's column
    // correctly from the left edge.
    var CANDIDATE_SELECTOR = 'li, p:not(.role-dates):not(.role-location), dt, header, hr, h1, h2, h3, .role-header, .role-meta, .project, .letter-close';

    function pxFromVar(varValue) {
      var probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:' + varValue + ';';
      document.body.appendChild(probe);
      var px = probe.getBoundingClientRect().height;
      probe.remove();
      return px;
    }

    function measureGeometry(pageEl) {
      var rootVar = getComputedStyle(document.documentElement).getPropertyValue('--page-h').trim() || '11in';
      var pageHeightPx = pxFromVar(rootVar);
      var cs = getComputedStyle(pageEl);
      var marginTopPx = parseFloat(cs.paddingTop) || 0;
      var marginBotPx = parseFloat(cs.paddingBottom) || 0;
      var marginSidePx = parseFloat(cs.paddingLeft) || 0;
      return {
        contentPerPagePx: Math.max(60, pageHeightPx - marginTopPx - marginBotPx),
        marginSidePx: marginSidePx,
        outerWidthPx: pageEl.getBoundingClientRect().width,
      };
    }

    function buildShadowClone(pageEl, geometry) {
      var host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
      var clone = pageEl.cloneNode(true);
      clone.removeAttribute('contenteditable');
      Array.prototype.slice.call(clone.querySelectorAll('[id]')).forEach(function (el) { el.removeAttribute('id'); });
      clone.style.cssText = 'box-sizing:border-box;margin:0;box-shadow:none;min-height:0;'
        + 'width:' + geometry.outerWidthPx + 'px;height:' + geometry.contentPerPagePx + 'px;'
        + 'padding:0 ' + geometry.marginSidePx + 'px;'
        // With border-box sizing, the usable CSS column is the outer paper
        // width minus both side paddings. Add those paddings back as the gap so
        // each successive column begins exactly one outer paper width later —
        // the same advance columnIndexOf() measures below.
        + 'column-width:' + geometry.outerWidthPx + 'px;column-gap:' + (geometry.marginSidePx * 2) + 'px;column-fill:auto;overflow:visible;';
      host.appendChild(clone);
      document.body.appendChild(host);
      void clone.getBoundingClientRect();
      return { host: host, clone: clone };
    }

    function columnIndexOf(left, containerLeft, columnWidth) {
      return columnWidth <= 0 ? 0 : Math.max(0, Math.round((left - containerLeft) / columnWidth));
    }

    function computeBreaks(pageEl) {
      var geometry = measureGeometry(pageEl);
      var liveCandidates = Array.prototype.slice.call(pageEl.querySelectorAll(CANDIDATE_SELECTOR));
      if (!liveCandidates.length) return { breaks: [], pageCount: 1 };
      var shadow = buildShadowClone(pageEl, geometry);
      try {
        var cloneCandidates = Array.prototype.slice.call(shadow.clone.querySelectorAll(CANDIDATE_SELECTOR));
        var containerLeft = shadow.clone.getBoundingClientRect().left;
        var pageLiveRect = pageEl.getBoundingClientRect();
        var breaks = [];
        var lastColumn = 0;
        var n = Math.min(liveCandidates.length, cloneCandidates.length);
        for (var i = 0; i < n; i++) {
          var rects = cloneCandidates[i].getClientRects();
          if (!rects.length) continue;
          var firstCol = columnIndexOf(rects[0].left, containerLeft, geometry.outerWidthPx);
          var lastCol = columnIndexOf(rects[rects.length - 1].left, containerLeft, geometry.outerWidthPx);
          if (firstCol > lastColumn) {
            var prevLive = liveCandidates[i - 1];
            var afterBottom = prevLive ? prevLive.getBoundingClientRect().bottom : pageLiveRect.top;
            var beforeTop = liveCandidates[i].getBoundingClientRect().top;
            var top = Math.min(Math.max(afterBottom - pageLiveRect.top, 0), Math.max(beforeTop - pageLiveRect.top, 0));
            var bottom = Math.max(beforeTop - pageLiveRect.top, top);
            breaks.push({ page: firstCol + 1, top: top, bottom: bottom, approximate: false });
            lastColumn = firstCol;
          }
          if (lastCol > firstCol) {
            for (var c = firstCol; c < lastCol; c++) {
              var ratio = (c + 1 - firstCol) / (lastCol - firstCol + 1);
              var liveRect = liveCandidates[i].getBoundingClientRect();
              breaks.push({ page: c + 2, top: liveRect.top - pageLiveRect.top + liveRect.height * ratio, bottom: 0, approximate: true });
            }
            lastColumn = lastCol;
          }
        }
        return { breaks: breaks, pageCount: lastColumn + 1 };
      } finally {
        shadow.host.remove();
      }
    }

    function renderGuides(stage) {
      var pageEl = stage.querySelector('.page');
      var guides = stage.querySelector('.ic-page-guides');
      if (!pageEl || !guides) return;
      var result;
      try { result = computeBreaks(pageEl); } catch (e) { guides.innerHTML = ''; return; }
      var html = '';
      result.breaks.forEach(function (b) {
        if (b.approximate) {
          html += '<div class="ic-page-seam ic-page-seam-approx" style="top:' + b.top + 'px">'
            + '<div class="ic-page-seam-line ic-page-seam-line-dashed"></div>'
            + '<span class="ic-page-folio" style="top:-11px">Page ' + b.page + '</span></div>';
        } else {
          var h = Math.max(1, b.bottom - b.top);
          html += '<div class="ic-page-seam" style="top:' + b.top + 'px;height:' + h + 'px">'
            + '<div class="ic-page-seam-fade-top"></div><div class="ic-page-seam-line" style="top:' + (h / 2) + 'px"></div>'
            + '<div class="ic-page-seam-fade-bot"></div><span class="ic-page-folio" style="top:' + (h / 2 - 6) + 'px">Page ' + b.page + '</span></div>';
        }
      });
      guides.innerHTML = html;
      stage.setAttribute('data-ic-page-count', String(result.pageCount));
    }

    var scheduled = false;
    function scheduleRecompute() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        stages.forEach(function (stage) { if (stage.offsetParent !== null) renderGuides(stage); });
      });
    }
    window.icPageGuidesRecompute = scheduleRecompute;
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(scheduleRecompute);
      stages.forEach(function (stage) {
        var pageEl = stage.querySelector('.page');
        if (pageEl) ro.observe(pageEl);
      });
    }
    window.addEventListener('resize', scheduleRecompute);
    new MutationObserver(scheduleRecompute).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-page', 'data-density', 'data-mono', 'data-print'],
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleRecompute).catch(function () {});
    scheduleRecompute();
  } catch (e) { /* Screen-only preview enhancement: never block the application. */ }
})();
</script>
</body>
</html>`;
}

function coverLetterDateTime(value) {
  const match = String(value || '').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b.*\b(\d{4})\b/i);
  if (!match) return '';
  const month = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ].indexOf(match[1].toLowerCase()) + 1;
  return month ? `${match[2]}-${String(month).padStart(2, '0')}` : '';
}

/**
 * Build the cover-letter document from structured fields using the design
 * system's NATIVE cover-letter surface (`cover-letter.html` / `cover-letter.css`):
 * the same `.resume-header` letterhead as the résumé, a hairline rule, the
 * date-only `.letter-meta` block, the Source-Serif `.letter-body`, and the
 * `.letter-close` signature block. We own only field substitution — the
 * typography, spacing, and the serif-body voice come straight from the design
 * system's stylesheets (no guessed inline CSS). `variantAttrs` mirrors the
 * résumé's print variant so the pair renders as one set. No receipts here
 * (design doc §4.4): the cover letter is built from plain-string fields with
 * nowhere to hang a `data-achievement-id`, and any figure it uses also
 * appears in the résumé where it *does* carry one.
 *
 * @param {object} args
 * @param {object} [args.letter]        { name, tagline, subtitleRole, credential,
 *                                         contact[], date, salutation, paragraphs[],
 *                                         closing, signatureTitle }
 * @param {string} [args.variantAttrs]
 * @param {string} [args.docId]         stable id for this document, namespaces localStorage autosave (§5.5)
 */
export function buildCoverLetterDocument({ letter = {}, variantAttrs = '', docId } = {}) {
  assertCandidateDashPunctuation({ coverLetter: letter });
  // Every field is decodeTextEscapes()'d before escaping so a literal "\n"/"\t"
  // the model emitted renders as real whitespace, not verbatim text.
  const name     = escapeHtml(decodeTextEscapes(letter.name || ''));
  const taglineSource = decodeTextEscapes(letter.tagline || '');
  const subtitleRoleSource = decodeTextEscapes(letter.subtitleRole || '');
  const credentialSource = decodeTextEscapes(letter.credential || '');
  const tagline  = escapeHtml(taglineSource);
  const subtitleRole = escapeHtml(subtitleRoleSource);
  const credential = escapeHtml(credentialSource);
  const contacts = Array.isArray(letter.contact) ? letter.contact : [];
  const contactHtml = contacts
    .filter(Boolean)
    .map(c => escapeHtml(decodeTextEscapes(c)))
    .join('\n      <span class="sep" aria-hidden="true">·</span>\n      ');

  const date       = escapeHtml(decodeTextEscapes(letter.date || ''));
  const dateTime   = coverLetterDateTime(letter.date);

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

  // The Local AI envelope supplies these from the accepted résumé. Reuse its
  // exact semantic header shape only when it accounts for ALL flattened
  // tagline text: a partially classed malformed résumé header must retain its
  // plain trailing text in the safe fallback rather than dropping it here.
  // Older callers that only know a flattened tagline retain that escaped text.
  const headerText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const flattenedTagline = headerText(taglineSource);
  const flattenedRole = headerText(subtitleRoleSource);
  const flattenedCredential = headerText(credentialSource);
  const canonicalTagline = flattenedCredential
    ? `${flattenedRole} · ${flattenedCredential}`
    : flattenedRole;
  const hasCanonicalStructuredTagline = Boolean(flattenedRole)
    && flattenedTagline === canonicalTagline;
  const letterheadTagline = hasCanonicalStructuredTagline
    ? `<p class="tagline">
      <span class="subtitle-role" itemprop="jobTitle">${subtitleRole}</span>${flattenedCredential ? `
      <span class="sep" aria-hidden="true">·</span>
      <span class="credential">${credential}</span>` : ''}
    </p>`
    : (tagline ? `<p class="tagline" itemprop="jobTitle">${tagline}</p>` : '');

  const css = inlineStylesheets(CSS_FILES);
  const scriptNonce = createDocumentScriptNonce();
  // Assembled before the chrome so the letter can be fingerprinted: the
  // standalone document edits this main through the same autosave slot the
  // workspace uses for its resume panel.
  const letterMain = `<main class="page" role="document" itemscope itemtype="https://schema.org/Person">
  <header class="resume-header letter-letterhead">
    <h1 class="name" itemprop="name">${name}</h1>
    ${letterheadTagline}
    ${contactHtml ? `<p class="contact" role="group" aria-label="Contact">
      ${contactHtml}
    </p>` : ''}
  </header>

  <hr class="letterhead-rule" aria-hidden="true">

  <div class="letter-meta">
    ${date ? `<p class="letter-date"><time${dateTime ? ` datetime="${dateTime}"` : ''}>${date}</time></p>` : ''}
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
</main>`;
  const chrome = buildInjectedChrome({
    docId, kind: 'cover-letter', scriptNonce,
    resumeFingerprint: documentMarkupFingerprint(letterMain),
  });

  return `<!doctype html>
<html lang="en" ${variantAttrs}>
<head>
<meta charset="utf-8">
${contentSecurityPolicyMeta(scriptNonce)}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cover Letter</title>
<style>
${css}

${INJECTED_CHROME_CSS}
</style>
</head>
<body>
${chrome}
${letterMain}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Startup assertion (§9)
// ---------------------------------------------------------------------------

/**
 * Startup assertion for the résumé design-system coupling surface (§9).
 * `Job Application Design System/` is owned by Claude design, read-only from this
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
 * @returns {{ok: boolean, checked: string[], missing: string[], mainExtractionOk: boolean, coverMainExtractionOk: boolean, fontContractOk: boolean, fontDelivery: string|null, error: string|null}}
 */
export function assertDesignSystemIntact() {
  const result = {
    ok: true,
    checked: [],
    missing: [],
    mainExtractionOk: false,
    coverMainExtractionOk: false,
    fontContractOk: false,
    fontDelivery: null,
    error: null,
  };
  try {
    const dir = getDesignSystemDir();
    for (const file of RUNTIME_DESIGN_FILES) {
      result.checked.push(file);
      if (!fs.existsSync(path.join(dir, file))) {
        result.missing.push(file);
        result.ok = false;
      }
    }

    for (const [file, key] of [['resume.html', 'mainExtractionOk'], ['cover-letter.html', 'coverMainExtractionOk']]) {
      const htmlPath = path.join(dir, file);
      if (!fs.existsSync(htmlPath)) {
        result.missing.push(file);
        result.ok = false;
        continue;
      }
      result[key] = /<main[\s\S]*<\/main>/i.test(fs.readFileSync(htmlPath, 'utf8'));
      if (!result[key]) result.ok = false;
    }

    const tokenCss = fs.readFileSync(path.join(dir, 'colors_and_type.css'), 'utf8');
    const imports = [...tokenCss.matchAll(GOOGLE_FONTS_IMPORT_RE)].map(match => match[1]);
    const importUrl = imports[0] || '';
    const expectedTokensPresent = [
      /--ff-display\s*:\s*["']Source Serif 4["']/,
      /--ff-body\s*:\s*["']Inter["']/,
      /--ff-mono\s*:\s*["']IBM Plex Mono["']/,
    ].every(pattern => pattern.test(tokenCss));
    result.fontDelivery = imports.length ? 'google-fonts' : null;
    result.fontContractOk = imports.length === 1
      && REQUIRED_FONT_IMPORT_PARTS.every(part => importUrl.includes(part))
      && expectedTokensPresent;
    if (!result.fontContractOk) result.ok = false;
  } catch (err) {
    // getDesignSystemDir() throwing (the whole folder is gone) lands here —
    // still never propagates past this function.
    result.ok = false;
    result.error = err?.message || String(err);
  }

  if (result.ok) {
    logger.info('[resumeHtml] design-system startup assertion passed (runtime files, templates, and Google Fonts contract intact)');
  } else {
    logger.warn(`[resumeHtml] DESIGN-SYSTEM RECONNECT NEEDED — startup assertion failed: ${JSON.stringify(result)}. Résumé/cover-letter generation will run against a stale or broken contract until this is addressed (see docs/resume-achievement-mining-design.md §9 reconnect checklist).`);
  }
  return result;
}
