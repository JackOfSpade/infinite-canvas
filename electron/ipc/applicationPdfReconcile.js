/**
 * Reconcile the editable Application.html document surface with a PDF that
 * changed outside Infinite Canvas.  This is deliberately a one-way, cautious
 * importer: PDF text has lost the HTML's semantic structure, so an uncertain
 * match is a conflict, never a best-effort rewrite.
 */
import { JSDOM } from 'jsdom';
import { restoreTrustedReceiptDerivations, sanitizeDocumentMainHtml } from './resumeHtml.js';

const PDF_TEXT_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’.-]*|[^\s]/gu;
const MAX_RECONCILE_TOKENS = 4_000;
// Bump when trusted HTML ↔ PDF comparison semantics change so a previously
// deterministic retry verdict is not reused against a repaired comparator.
export const APPLICATION_PDF_RECONCILE_REVISION = 3;
// pdfjs-dist chooses its Node implementation (including the adjacent worker)
// only when Node loads its native ESM file. A static import lets Vite inline its
// browser build into Electron's CJS main bundle, where worker setup falls back
// to `window` and fails after a seemingly successful application import.
// Keep the package specifier in a variable and tell Vite not to transform the
// dynamic import, so Electron's main-process Node resolver loads node_modules
// at runtime instead.
const PDFJS_LEGACY_MODULE = 'pdfjs-dist/legacy/build/pdf.mjs';
let pdfjsModulePromise = null;

async function loadPdfjsForElectronMain() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import(/* @vite-ignore */ PDFJS_LEGACY_MODULE);
  }
  try {
    return await pdfjsModulePromise;
  } catch (error) {
    // Do not permanently cache a transient packaged-module resolution failure.
    pdfjsModulePromise = null;
    throw error;
  }
}

const COVER_LEAF_SELECTOR = [
  '.letter-letterhead .name',
  '.letter-letterhead .tagline',
  '.letter-letterhead .contact',
  '.letter-meta .letter-date',
  '.letter-body .salutation',
  '.letter-body > p:not(.salutation)',
  '.letter-close .valediction',
  '.letter-close .signature',
  '.letter-close .signature-title',
].join(', ');

function normalizeReconcileText(value) {
  return String(value || '')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePdfText(value) {
  return normalizeReconcileText(value)
    // pdf.js separates visual lines, so a normally hyphenated word that wraps
    // can arrive as `full- scale`. The DOM still contains `full-scale`; join
    // only an attached ASCII hyphen followed by an alphanumeric continuation.
    // A true spaced dash (`word - next`) keeps its leading space and therefore
    // does not match this repair.
    .replace(/([\p{L}\p{N}])- +(?=[\p{L}\p{N}])/gu, '$1-');
}

function textTokens(value) {
  return normalizeReconcileText(value).match(PDF_TEXT_TOKEN) || [];
}

function number(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function itemGeometry(item, page) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  return {
    page,
    x: number(transform[4]),
    y: number(transform[5]),
    width: Math.max(0, number(item?.width)),
    height: Math.max(0, Math.abs(number(item?.height, transform[3]))),
    text: String(item?.str || ''),
    hasEOL: Boolean(item?.hasEOL),
  };
}

function sameVisualLine(left, right) {
  const averageHeight = Math.max(1, (left.height + right.height) / 2);
  return Math.abs(left.y - right.y) <= Math.max(1.25, averageHeight * 0.28);
}

function needsSpace(previous, next) {
  if (!previous || !next || /\s$/.test(previous.text) || /^\s/.test(next.text)) return false;
  const previousEnd = previous.x + previous.width;
  const gap = next.x - previousEnd;
  const size = Math.max(1, Math.min(previous.height || 0, next.height || 0));
  return gap > Math.max(0.75, size * 0.14);
}

/**
 * Convert one pdf.js page's text items into visual lines.  Returned entries
 * retain page/y/x geometry and are ordered in normal reading order.
 */
function orderedTextBlocksFromItems(items, { page = 1 } = {}) {
  const ordered = (Array.isArray(items) ? items : [])
    .map(item => itemGeometry(item, page))
    .filter(item => normalizeReconcileText(item.text))
    .sort((left, right) => right.y - left.y || left.x - right.x);
  const lines = [];
  for (const item of ordered) {
    let line = lines.find(candidate => sameVisualLine(candidate, item));
    if (!line) {
      line = { page, x: item.x, y: item.y, width: item.width, height: item.height, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.x = Math.min(line.x, item.x);
    line.y = Math.max(line.y, item.y);
    line.width = Math.max(line.width, item.x + item.width - line.x);
    line.height = Math.max(line.height, item.height);
  }
  return lines
    .map((line) => {
      // A visual line reads left to right, so compose it in x order rather
      // than in the page-wide y-descending order that grouped it. Grouping
      // deliberately tolerates a baseline difference, and two cells of one
      // grid row routinely have one: `.skills dd` carries `line-height:
      // var(--lh-snug)` and its `dt` does not, so the value's first line sits
      // 0.75pt above the label that introduces it. Composed in the outer
      // order, the right-hand column landed BEFORE the left-hand one and the
      // Skills label was emitted after its own wrapped value
      // (`... Docker Compose · MCP ·technologies`), which no token alignment
      // against the DOM can resolve. `needsSpace` also only means anything
      // between x-adjacent items.
      const items = [...line.items].sort((left, right) => left.x - right.x);
      const text = items.reduce(
        (accumulated, item, index) => `${accumulated}${needsSpace(items[index - 1], item) ? ' ' : ''}${item.text}`,
        '',
      );
      // Keep whitespace after an attached hyphen until the trusted DOM can
      // tell us whether it is a wrapped compound (`full- scale`) or a genuine
      // suspended form (`part- and`).
      return { ...line, items, text: normalizeReconcileText(text) };
    })
    .filter(line => line.text)
    .sort((left, right) => left.page - right.page || right.y - left.y || left.x - right.x);
}

/** Extract ordered visual text lines, each with its page/y/x geometry. */
export async function extractPdfTextBlocks(pdfBytes) {
  // Buffer is a Uint8Array subclass, but pdf.js intentionally rejects it to
  // prevent transfer/detachment surprises.  Copy into a plain Uint8Array.
  const bytes = new Uint8Array(pdfBytes || []);
  if (!bytes.byteLength) throw new Error('PDF bytes are missing.');
  let loadingTask;
  let pdf;
  try {
    const { getDocument } = await loadPdfjsForElectronMain();
    loadingTask = getDocument({ data: bytes, disableWorker: true });
    pdf = await loadingTask.promise;
    const blocks = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      blocks.push(...orderedTextBlocksFromItems(textContent.items, { page: pageNumber }));
      page.cleanup();
    }
    return blocks;
  } finally {
    await pdf?.destroy?.();
    await loadingTask?.destroy?.();
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Merge nearby visual lines into paragraph-like blocks.  This is useful for
 * cover-letter body paragraphs, whose PDF representation has one item per
 * wrapped line but a noticeably larger gap between paragraphs.
 */
function groupGeometrySeparatedBlocks(lines) {
  const ordered = (Array.isArray(lines) ? lines : [])
    .filter(line => normalizeReconcileText(line?.text))
    .map(line => ({ ...line, text: normalizeReconcileText(line.text) }))
    .sort((left, right) => left.page - right.page || right.y - left.y || left.x - right.x);
  const pageGaps = new Map();
  for (let index = 1; index < ordered.length; index += 1) {
    const before = ordered[index - 1];
    const current = ordered[index];
    if (before.page !== current.page) continue;
    const gap = before.y - current.y;
    if (gap > 0.5) {
      const gaps = pageGaps.get(current.page) || [];
      gaps.push(gap);
      pageGaps.set(current.page, gaps);
    }
  }
  const leadingByPage = new Map([...pageGaps].map(([page, gaps]) => {
    const likelyLineGaps = [...gaps].sort((left, right) => left - right).slice(0, Math.max(1, Math.ceil(gaps.length * 0.7)));
    return [page, median(likelyLineGaps) || 12];
  }));

  const blocks = [];
  for (const line of ordered) {
    const previous = blocks[blocks.length - 1];
    const leading = leadingByPage.get(line.page) || 12;
    const gap = previous && previous.page === line.page ? previous.lastY - line.y : Infinity;
    const separated = !previous || previous.page !== line.page || gap > Math.max(leading * 1.35, leading + 1.5);
    if (separated) {
      blocks.push({ page: line.page, x: line.x, y: line.y, width: line.width, height: line.height, text: line.text, lines: [line], lastY: line.y });
    } else {
      previous.text = normalizeReconcileText(`${previous.text} ${line.text}`);
      previous.x = Math.min(previous.x, line.x);
      previous.width = Math.max(previous.width, line.x + line.width - previous.x);
      previous.height = Math.max(previous.height, line.height);
      previous.lastY = line.y;
      previous.lines.push(line);
    }
  }
  return blocks.map((block) => {
    const copy = { ...block };
    delete copy.lastY;
    return copy;
  });
}

function panelForKind(document, documentKind) {
  return document.querySelector(`[data-ic-document-panel="${documentKind}"] main.page`)
    || (documentKind === 'resume' ? document.querySelector('main.page') : null);
}

function conflictResult(html, error) {
  return { success: false, status: 'conflict', html, changed: false, exactTextMatch: false, reason: error, error };
}

function coverLeafElements(main) {
  return [...main.querySelectorAll(COVER_LEAF_SELECTOR)].filter((element) => {
    // Nested selectors such as `.letter-body .salutation` are leafs, while a
    // child span inside a leaf must never become a second independently mapped
    // record.
    return normalizeReconcileText(element.textContent);
  });
}

function leafTextNodes(element) {
  const document = element.ownerDocument;
  const walker = document.createTreeWalker(element, document.defaultView.NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (textTokens(walker.currentNode.nodeValue).length) nodes.push(walker.currentNode);
  }
  return nodes;
}

function replaceTokenSequence(nodes, replacementTokens) {
  // The length gate must count matches the same way the substitution below
  // does. Matching the raw string keeps both counts in sync and preserves the
  // DOM's trusted separators while replacing only lexical tokens.
  const originals = nodes.flatMap(node => String(node.nodeValue || '').match(PDF_TEXT_TOKEN) || []);
  if (originals.length !== replacementTokens.length) return false;
  let tokenIndex = 0;
  for (const node of nodes) {
    node.nodeValue = String(node.nodeValue || '').replace(PDF_TEXT_TOKEN, () => replacementTokens[tokenIndex++] || '');
  }
  return true;
}

function attachedHyphenToken(token) {
  return /^[\p{L}\p{N}][\p{L}\p{N}\p{M}'’.-]*-$/u.test(token || '');
}

function alphanumericToken(token) {
  return /^[\p{L}\p{N}]/u.test(token || '');
}

/**
 * Resolve PDF whitespace after an attached hyphen only when the trusted DOM
 * establishes the token shape at that position. A matching compound token is
 * rejoined; a DOM pair such as `part-`, `and` keeps its separator. If neither
 * shape is established, callers must refuse to serialize the ambiguous text.
 */
function reconcileExtractedText(value, currentTokens, { ignorePresentationalAlignment = false } = {}) {
  const text = normalizeReconcileText(value);
  const matches = [...text.matchAll(PDF_TEXT_TOKEN)];
  const rawTokens = matches.map(match => match[0]);
  const signature = tokens => tokens.join('\u0000');
  if (signature(rawTokens) === signature(currentTokens)) {
    return { tokens: rawTokens, text, ambiguousHyphen: false };
  }

  const tokens = [];
  // Resume PDFs contain visual bullets/dots that the trusted DOM deliberately
  // marks aria-hidden. They remain in the extracted token stream until the
  // resume presentation pass below, but must not shift the DOM position used
  // to classify a later wrapped hyphen.
  const alignmentTokens = ignorePresentationalAlignment
    ? currentTokens.filter(token => !isPresentationalToken(token))
    : currentTokens;
  let alignmentTokenCount = 0;
  const separatorRemovals = [];
  let ambiguousHyphen = false;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const token = match[0];
    const previousMatch = matches[index - 1];
    const previousToken = tokens.at(-1);
    const separatorStart = previousMatch ? previousMatch.index + previousMatch[0].length : -1;
    const separator = previousMatch ? text.slice(separatorStart, match.index) : '';
    if (previousMatch && /\s/u.test(separator)
      && attachedHyphenToken(previousToken) && alphanumericToken(token)) {
      const outputIndex = tokens.length - 1;
      const currentIndex = alignmentTokenCount - 1;
      const joined = `${previousToken}${token}`;
      if (joined === alignmentTokens[currentIndex]) {
        tokens[outputIndex] = joined;
        separatorRemovals.push([separatorStart, match.index]);
        continue;
      }
      // The existing DOM separately tokenizes an attached-hyphen word at this
      // position, so retain the PDF separator even if either lexical token was
      // edited. This preserves `part- and` / `part- or` as suspended forms.
      // Do not borrow a matching pair from elsewhere in the document. A leaf
      // can legitimately contain both `full- scale` and `full-scale`; after an
      // insertion shifts token positions, a global match would preserve the
      // separator at the lexical occurrence and silently corrupt it. Only the
      // trusted pair at this exact aligned position resolves the ambiguity.
      if (!(attachedHyphenToken(alignmentTokens[currentIndex])
        && alphanumericToken(alignmentTokens[currentIndex + 1]))) {
        ambiguousHyphen = true;
      }
    }
    tokens.push(token);
    if (!ignorePresentationalAlignment || !isPresentationalToken(token)) alignmentTokenCount += 1;
  }

  let safeText = text;
  for (const [start, end] of separatorRemovals.reverse()) {
    safeText = `${safeText.slice(0, start)}${safeText.slice(end)}`;
  }
  return { tokens, text: safeText, ambiguousHyphen };
}

function replaceCoverLeafText(element, replacement) {
  const currentTokens = textTokens(element.textContent);
  const reconciled = reconcileExtractedText(replacement, currentTokens);
  if (reconciled.ambiguousHyphen) {
    return { conflict: `The PDF has an ambiguous line-ending hyphen in ${element.className || element.localName} text.` };
  }
  const replacementTokens = reconciled.tokens;
  // PDF layout commonly inserts visual whitespace around separators whose DOM
  // spans are intentionally flush ("Engineer·B.S." -> "Engineer · B.S.").
  // Token equality is the semantic equality used by the résumé path too; do
  // not report or serialize a fake edit for spacing the PDF text layer cannot
  // faithfully round-trip.
  if (currentTokens.join('\u0000') === replacementTokens.join('\u0000')) return { changed: false };
  // Unstructured paragraphs can safely accept insertions/removals after the
  // DOM-guided hyphen pass has produced serialization-safe text.
  if (element.children.length === 0) {
    element.textContent = reconciled.text;
    return { changed: true };
  }
  // Structured leaves retain their exact markup and separators; only their
  // lexical tokens may change one-for-one.
  const nodes = leafTextNodes(element);
  if (!replaceTokenSequence(nodes, replacementTokens)) {
    return { conflict: `The PDF changed structured ${element.className || element.localName} text in a way that cannot preserve its markup.` };
  }
  return { changed: true };
}

function compactFoldedText(value) {
  return normalizeReconcileText(value).toLocaleLowerCase().replace(/\s+/gu, '');
}

/**
 * Decide how many PDF visual lines each fixed envelope leaf occupies.
 *
 * An envelope leaf is not guaranteed to be one visual line.  `.contact` is
 * `display: flex; flex-wrap: wrap` by design, so a candidate whose contact row
 * carries more than an email and a phone wraps onto a second line, and `.name`
 * / `.tagline` / `.signature-title` can wrap too.  A fixed one-line-per-leaf
 * slice silently shifts every later leaf — the date absorbs the contact's
 * second line, the salutation absorbs the date, and the salutation's own line
 * falls into the body, where it is counted as an extra paragraph.
 *
 * Geometry cannot settle this: on a real letter the gap between the name and
 * the tagline (20.25pt) and the gap inside a wrapped contact row (15.75pt) sit
 * on either side of the same page-wide threshold by a fraction of a point.
 * The trusted DOM can: a leaf only absorbs a following line while that line
 * continues the leaf's own text.  A PDF edited outside the app stops matching
 * at the first changed token and falls back to one line per leaf, which is the
 * behaviour this function replaced — an unmappable result is then reported as
 * a conflict rather than written into the wrong leaf.
 */
function envelopeLineSpan(envelopeLeaves, lines, { fromEnd = false, reserved = 0 } = {}) {
  const orderedLeaves = fromEnd ? [...envelopeLeaves].reverse() : envelopeLeaves;
  const orderedLines = fromEnd ? [...lines].reverse() : lines;
  const join = fromEnd ? (accumulated, next) => `${next}${accumulated}` : (accumulated, next) => `${accumulated}${next}`;
  const continues = fromEnd
    ? (trusted, accumulated) => trusted.endsWith(accumulated)
    : (trusted, accumulated) => trusted.startsWith(accumulated);
  const perLeaf = [];
  let cursor = 0;
  for (let index = 0; index < orderedLeaves.length; index += 1) {
    if (cursor >= orderedLines.length) return null;
    const trusted = compactFoldedText(orderedLeaves[index].textContent);
    const remainingLeaves = orderedLeaves.length - index - 1;
    let accumulated = compactFoldedText(orderedLines[cursor].text);
    let taken = 1;
    while (trusted !== accumulated && continues(trusted, accumulated)
      // Never consume a line another envelope leaf, or the body, still needs.
      && orderedLines.length - (cursor + taken) > remainingLeaves + reserved) {
      const next = compactFoldedText(orderedLines[cursor + taken].text);
      const extended = join(accumulated, next);
      if (!next || !continues(trusted, extended)) break;
      accumulated = extended;
      taken += 1;
    }
    perLeaf.push(taken);
    cursor += taken;
  }
  return { lineCount: cursor, perLeaf: fromEnd ? perLeaf.reverse() : perLeaf };
}

/** Join each leaf's own visual lines back into one replacement string. */
function envelopeLeafTexts(lines, perLeaf) {
  const texts = [];
  let cursor = 0;
  for (const taken of perLeaf) {
    texts.push(normalizeReconcileText(lines.slice(cursor, cursor + taken).map(line => line.text).join(' ')));
    cursor += taken;
  }
  return texts;
}

/**
 * Reconcile a cover letter's geometry-separated PDF text with its semantic
 * leaf elements.  The fixed envelope (name/tagline/contact/date/salutation),
 * each body paragraph, and closing lines are independently mapped.  Extra or
 * missing blocks are a conflict rather than an unsafe paragraph merge.
 */
function reconcileCoverTextBlocks(main, lines) {
  const leaves = coverLeafElements(main);
  const bodyLeaves = leaves.filter(element => element.matches('.letter-body > p:not(.salutation)'));
  const prefixLeaves = leaves.slice(0, leaves.indexOf(bodyLeaves[0]));
  const suffixLeaves = bodyLeaves.length ? leaves.slice(leaves.indexOf(bodyLeaves.at(-1)) + 1) : [];
  const pageNumbers = new Set(lines.map(line => line.page));
  if (!leaves.length || !bodyLeaves.length) return { conflict: 'The cover-letter panel has no recognizable semantic paragraph structure.' };
  if (pageNumbers.size !== 1) return { conflict: 'Only a one-page cover letter can be reconciled safely.' };
  if (lines.length < prefixLeaves.length + bodyLeaves.length + suffixLeaves.length) {
    return { conflict: 'The PDF has too little text to map the cover-letter envelope.' };
  }

  const prefixSpan = envelopeLineSpan(prefixLeaves, lines, { reserved: bodyLeaves.length + suffixLeaves.length });
  if (!prefixSpan) return { conflict: 'The PDF has too little text to map the cover-letter envelope.' };
  const suffixSpan = envelopeLineSpan(suffixLeaves, lines.slice(prefixSpan.lineCount), { fromEnd: true, reserved: bodyLeaves.length });
  if (!suffixSpan) return { conflict: 'The PDF has too little text to map the cover-letter envelope.' };

  const prefix = envelopeLeafTexts(lines.slice(0, prefixSpan.lineCount), prefixSpan.perLeaf);
  const suffix = envelopeLeafTexts(lines.slice(lines.length - suffixSpan.lineCount), suffixSpan.perLeaf);
  const bodyLines = lines.slice(prefixSpan.lineCount, lines.length - suffixSpan.lineCount);
  const bodyBlocks = groupGeometrySeparatedBlocks(bodyLines);
  if (bodyBlocks.length !== bodyLeaves.length) {
    return { conflict: `The PDF has ${bodyBlocks.length} geometry-separated body block(s), but the cover letter has ${bodyLeaves.length} paragraph(s).` };
  }

  const replacements = [...prefix, ...bodyBlocks.map(block => block.text), ...suffix];
  if (replacements.length !== leaves.length) return { conflict: 'The PDF cover-letter block mapping is incomplete.' };
  let changed = false;
  for (let index = 0; index < leaves.length; index += 1) {
    const result = replaceCoverLeafText(leaves[index], replacements[index]);
    if (result.conflict) return result;
    changed ||= result.changed;
  }
  return { changed, mappedLeaves: leaves.length };
}

function visibleResumeTextNodes(main) {
  const document = main.ownerDocument;
  const walker = document.createTreeWalker(main, document.defaultView.NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (parent?.closest('[aria-hidden="true"], [hidden]')) continue;
    if (textTokens(walker.currentNode.nodeValue).length) nodes.push(walker.currentNode);
  }
  return nodes;
}

function foldedText(value) {
  return normalizeReconcileText(value).toLocaleLowerCase();
}

function collapsedTrackedHeading(text, knownHeadings) {
  const normalized = normalizeReconcileText(text);
  // PDF text extraction represents the design-system's tracked section labels
  // as `E X P E R I E N C E`.  Only collapse a form that matches a heading we
  // already trust in the DOM; arbitrary all-caps résumé content is untouched.
  const compact = normalized.replace(/\s+/g, '');
  if (!/^[\p{L}]+$/u.test(compact) || !/\s/.test(normalized)) return normalized;
  return knownHeadings.find(heading => foldedText(heading).replace(/\s+/g, '') === compact.toLocaleLowerCase()) || normalized;
}

function skillRows(main) {
  const list = main.querySelector('dl.skills');
  if (!list) return [];
  const rows = [];
  let label = null;
  for (const element of list.children) {
    if (element.localName === 'dt') label = normalizeReconcileText(element.textContent);
    else if (element.localName === 'dd' && label) {
      rows.push({ label, value: normalizeReconcileText(element.textContent) });
      label = null;
    }
  }
  return rows.filter(row => row.label && row.value);
}

function labelPrefixLength(tokens, labelTokens) {
  let length = 0;
  while (length < tokens.length && length < labelTokens.length
    // Labels prove the boundary that lets us reconstruct a wrapped <dt>.
    // Unlike headings, they are content, not presentation: accepting a
    // case-only PDF edit here would replace the observed text with the DOM
    // label and incorrectly report the document unchanged.
    && normalizeReconcileText(tokens[length]) === normalizeReconcileText(labelTokens[length])) length += 1;
  return length;
}

function sameSkillLabelColumn(line, labelX) {
  // A value can legitimately begin with the same word as a later label. Do
  // not turn that coincidence into a structural boundary: a Skills <dt> is
  // drawn in the left column while a wrapped <dd> stays on the right.
  return Number.isFinite(line?.x) && Number.isFinite(labelX) && Math.abs(line.x - labelX) <= 12;
}

function tokensText(tokens) {
  return normalizeReconcileText(tokens.join(' '));
}

function sameTokenSequence(left, right) {
  if (left.length !== right.length) return false;
  return left.every((token, index) => normalizeReconcileText(token) === normalizeReconcileText(right[index]));
}

function hasInvertedSkillColumns(lines) {
  const left = Math.min(...lines.map(line => Number(line?.x)).filter(Number.isFinite));
  if (!Number.isFinite(left)) return false;
  // pdf.js normally groups a row's cells into one line. This signature is
  // reserved for the known baseline split: a right-column text block sorts
  // before a later left-column label block, so ordinary value wraps cannot
  // enter the fallback merely because they use the right column.
  return lines.some((line, index) => Number(line?.x) > left + 12
    && lines.slice(index + 1).some(candidate => sameSkillLabelColumn(candidate, left)));
}

function exactSeparatedSkillColumns(lines, rows) {
  if (!hasInvertedSkillColumns(lines)) return null;
  const labelX = Math.min(...lines.map(line => Number(line?.x)).filter(Number.isFinite));
  const labels = [];
  const values = [];
  for (const line of lines) {
    const items = Array.isArray(line.items) ? line.items : [];
    if (sameSkillLabelColumn(line, labelX)) {
      // A line containing both cells has already lost its column boundary at
      // this stage. The regular semantic parser handles that normal shape; do
      // not use this fallback unless every line can be assigned to one column.
      if (items.some(item => Number(item?.x) > labelX + 12)) return null;
      labels.push(...textTokens(line.text));
    } else if (Number.isFinite(line?.x) && line.x > labelX + 12) {
      if (items.some(item => Number(item?.x) <= labelX + 12)) return null;
      values.push(...textTokens(line.text));
    } else {
      return null;
    }
  }
  const expectedLabels = rows.flatMap(row => textTokens(row.label));
  const expectedValues = rows.flatMap(row => textTokens(row.value));
  // The inverted geometry proves why the two columns were interleaved; exact
  // case-sensitive sequence equality for EACH column proves it was not a PDF
  // edit. An insertion, deletion, case change, or same-token reorder remains
  // a normal reconciliation conflict.
  if (!sameTokenSequence(labels, expectedLabels) || !sameTokenSequence(values, expectedValues)) return null;
  return rows.flatMap(row => [
    { ...lines[0], text: row.label },
    { ...lines[0], text: row.value },
  ]);
}

/**
 * Split the Skills grid's visual lines back into one line per `dt`/`dd`.
 *
 * `.skills` is a two-column grid, so a row's label and the first line of its
 * value share a visual line and a long value wraps underneath both of them.
 * Joining those lines yields `label value label value …` in DOM order; this
 * restores the element boundary that the join erased, so a row's value cannot
 * absorb the next row's label.
 *
 * A <dt> can itself wrap. Chromium may then emit the row as a left-label
 * prefix, the right-hand <dd>, and a left-label continuation on the next
 * visual line. That is geometrically faithful, but not DOM reading order.
 * Rebuild a row only when every trusted DOM label is proved in the PDF's left
 * column; a missing, reordered, or ambiguous label stays unmapped.
 */
function semanticSkillLines(lines, rows) {
  const split = [];
  let cursor = 0;
  let labelX = null;
  for (let index = 0; index < rows.length; index += 1) {
    const { label } = rows[index];
    const labelTokens = textTokens(label);
    const first = lines[cursor];
    const firstTokens = textTokens(first?.text);
    const matched = labelPrefixLength(firstTokens, labelTokens);
    if (!matched || (labelX != null && !sameSkillLabelColumn(first, labelX))) return null;
    if (labelX == null) labelX = first.x;

    const valueTokens = firstTokens.slice(matched);
    let labelOffset = matched;
    cursor += 1;

    // A long <dt> can continue below the first row line after its paired <dd>
    // was painted. The continuation must be the next left-column visual line
    // and complete exactly the remaining trusted label tokens.
    while (labelOffset < labelTokens.length) {
      const continuation = lines[cursor];
      const continuationTokens = textTokens(continuation?.text);
      const remaining = labelTokens.slice(labelOffset);
      const continuationLength = labelPrefixLength(continuationTokens, remaining);
      if (!continuationLength || !sameSkillLabelColumn(continuation, labelX)) return null;
      labelOffset += continuationLength;
      valueTokens.push(...continuationTokens.slice(continuationLength));
      cursor += 1;
    }

    const nextLabelTokens = textTokens(rows[index + 1]?.label);
    // Wrapped <dd> lines remain in this row until the next trusted label
    // begins in the same left column. Their observed order is preserved so the
    // global reconciler still rejects real inserts, deletes, and reorders.
    while (cursor < lines.length) {
      const candidate = lines[cursor];
      const candidateTokens = textTokens(candidate.text);
      if (nextLabelTokens.length
        && sameSkillLabelColumn(candidate, labelX)
        && labelPrefixLength(candidateTokens, nextLabelTokens) > 0) break;
      valueTokens.push(...candidateTokens);
      cursor += 1;
    }
    const value = tokensText(valueTokens);
    if (!value) return null;
    split.push({ ...first, text: label }, { ...first, text: value });
  }
  // Any remaining line means a row boundary was not proved, so do not infer it.
  return cursor === lines.length ? split : null;
}

function nextResumeSectionIndex(lines, start, headings, skillsHeading) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (headings.some(heading => foldedText(heading) !== foldedText(skillsHeading)
      && foldedText(lines[index].text) === foldedText(heading))) return index;
  }
  return lines.length;
}

function standalonePdfFolio(value) {
  const match = /^(\d+)\s*\/\s*(\d+)$/u.exec(normalizeReconcileText(value));
  if (!match) return null;
  const page = Number(match[1]);
  const count = Number(match[2]);
  return Number.isSafeInteger(page) && Number.isSafeInteger(count) && page > 0 && count > 0
    ? { page, count }
    : null;
}

function finitePdfCoordinate(value) {
  return Number.isFinite(value) ? value : null;
}

function folioRightEdge(block) {
  const x = finitePdfCoordinate(block?.x);
  const width = finitePdfCoordinate(block?.width);
  return x == null ? null : x + Math.max(0, width || 0);
}

// A bare `1 / 2` is a perfectly valid résumé datum. Treat it as print chrome
// only when the complete document proves the Chromium-folio pattern: every
// page after the deliberately folio-free first page has its own `page / total`
// line, those lines share a lower-right footer geometry, and they sit below
// the real page content. This intentionally works from unmodified extraction
// text, before the resume canonicalizer removes visual bullet markers;
// `• 1 / 2` is content, not a folio. If any evidence is absent, keep the line
// and let reconciliation fail safely rather than discard candidate-authored
// text.
function contextualPdfFolioIndexes(blocks) {
  const records = (Array.isArray(blocks) ? blocks : []).map((block, index) => ({
    block,
    index,
    page: Number(block?.page),
    folio: standalonePdfFolio(block?.text),
  })).filter(record => Number.isSafeInteger(record.page) && record.page > 0);
  const pageCount = records.reduce((highest, record) => Math.max(highest, record.page), 0);
  // The resume stylesheet intentionally suppresses the first-page footer.
  // One later-page line is enough only in a two-page document, where its
  // matching page/total value and lower-right geometry still distinguish it
  // from ordinary body content.
  if (pageCount < 2 || new Set(records.map(record => record.page)).size !== pageCount) return new Set();

  const candidates = records.filter(record => record.folio
    && record.folio.page === record.page
    && record.page > 1
    && record.folio.count === pageCount);
  if (candidates.length !== pageCount - 1) return new Set();
  const candidatesByPage = new Map(candidates.map(record => [record.page, record]));
  if (candidatesByPage.size !== pageCount - 1) return new Set();

  const footerRightEdges = candidates.map(record => folioRightEdge(record.block));
  const footerYs = candidates.map(record => finitePdfCoordinate(record.block?.y));
  if (footerRightEdges.some(value => value == null) || footerYs.some(value => value == null)) return new Set();
  const minFooterRight = Math.min(...footerRightEdges);
  const maxFooterRight = Math.max(...footerRightEdges);
  const minFooterY = Math.min(...footerYs);
  const maxFooterY = Math.max(...footerYs);
  // Browser footers share a baseline and a right edge. The tolerance permits
  // normal font/rounding differences without allowing body-column ratios.
  if (maxFooterRight - minFooterRight > 18 || maxFooterY - minFooterY > 12) return new Set();

  for (let page = 2; page <= pageCount; page += 1) {
    const candidate = candidatesByPage.get(page);
    const x = finitePdfCoordinate(candidate.block?.x);
    const y = finitePdfCoordinate(candidate.block?.y);
    const content = records.filter(record => record.page === page && record.index !== candidate.index);
    const contentXs = content.map(record => finitePdfCoordinate(record.block?.x)).filter(value => value != null);
    const contentYs = content.map(record => finitePdfCoordinate(record.block?.y)).filter(value => value != null);
    if (!content.length) continue; // The blank-page gate will reject this page after its folio is ignored.
    if (!contentXs.length || !contentYs.length || x == null || y == null) return new Set();
    const leftEdge = Math.min(...contentXs);
    const lowestContentY = Math.min(...contentYs);
    // Do not infer a page width. Relative-to-content evidence is enough:
    // Chromium chrome is well beyond the left reading column and below it.
    if (x - leftEdge < 72 || lowestContentY - y < 18) return new Set();
  }
  return new Set(candidates.map(record => record.index));
}

function resumeContentBlocks(blocks) {
  const source = Array.isArray(blocks) ? blocks : [];
  const folios = contextualPdfFolioIndexes(source);
  return source.filter((_block, index) => !folios.has(index));
}

/**
 * Translate known print-only résumé representations back to the document's
 * semantic reading order.  It deliberately relies on the current DOM for
 * headings and skill labels, so it cannot invent a structure from a foreign
 * or damaged PDF.
 */
function canonicalizeResumePdfLines(lines, main) {
  const knownHeadings = [...main.querySelectorAll('.section-head h2')].map(element => normalizeReconcileText(element.textContent));
  const normalized = resumeContentBlocks(lines)
    .map(line => ({
      ...line,
      // `•` is a visual list marker, never a text node in the generated HTML.
      text: collapsedTrackedHeading(normalizeReconcileText(line.text).replace(/^•\s*/, ''), knownHeadings),
    }));
  const skillsHeading = knownHeadings.find(heading => foldedText(heading) === 'skills');
  const skillsIndex = normalized.findIndex(line => skillsHeading && foldedText(line.text) === foldedText(skillsHeading));
  const rows = skillRows(main);
  if (skillsIndex < 0 || !rows.length) return normalized;
  const nextSection = nextResumeSectionIndex(normalized, skillsIndex, knownHeadings, skillsHeading);
  const skillLines = normalized.slice(skillsIndex + 1, nextSection);
  const reordered = semanticSkillLines(skillLines, rows) || exactSeparatedSkillColumns(skillLines, rows);
  return reordered
    ? [...normalized.slice(0, skillsIndex + 1), ...reordered, ...normalized.slice(nextSection)]
    : normalized;
}

function isPresentationalToken(token) {
  return token === '•' || token === '·';
}

function restoreDomPresentationTokens(current, incoming) {
  const semanticIncoming = incoming.filter(token => !isPresentationalToken(token));
  const semanticCurrent = current.filter(token => !isPresentationalToken(token));
  if (semanticCurrent.length !== semanticIncoming.length) return null;
  let semanticIndex = 0;
  return current.map((token) => (isPresentationalToken(token) ? token : semanticIncoming[semanticIndex++]));
}

function resumePdfTextTokens(lines, current) {
  // Join visual lines losslessly first. reconcileExtractedText removes only a
  // separator whose compound identity is established by the current DOM.
  // PDF-only visual separators must not offset that identity check; the next
  // pass restores the exact presentation-token shape owned by the DOM.
  return reconcileExtractedText(lines.map(line => line.text).join(' '), current, {
    ignorePresentationalAlignment: true,
  });
}

function lcsPairs(left, right) {
  if (left.length > MAX_RECONCILE_TOKENS || right.length > MAX_RECONCILE_TOKENS) return null;
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      matrix[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? matrix[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(matrix[leftIndex + 1][rightIndex], matrix[leftIndex][rightIndex + 1]);
    }
  }
  const pairs = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      pairs.push([leftIndex++, rightIndex++]);
    } else if (matrix[leftIndex + 1][rightIndex] >= matrix[leftIndex][rightIndex + 1]) leftIndex += 1;
    else rightIndex += 1;
  }
  return pairs;
}

function plainTextListLeaves(main, nodes) {
  const starts = new Map();
  let offset = 0;
  for (const node of nodes) {
    starts.set(node, offset);
    offset += textTokens(node.nodeValue).length;
  }
  return [...main.querySelectorAll('li')].flatMap((element) => {
    // A list item with a link/span/receipt is structured content.  PDF text
    // cannot safely tell which nested element an insertion belongs to.
    if (element.children.length) return [];
    const textNode = [...element.childNodes].find(node => node.nodeType === element.ownerDocument.defaultView.Node.TEXT_NODE && textTokens(node.nodeValue).length);
    const start = starts.get(textNode);
    const length = textTokens(textNode?.nodeValue).length;
    return Number.isInteger(start) && length ? [{ element, textNode, start, end: start + length }] : [];
  });
}

function visualBulletBlocks(lines) {
  const ordered = (Array.isArray(lines) ? lines : [])
    .filter(line => normalizeReconcileText(line?.text))
    .sort((left, right) => left.page - right.page || right.y - left.y || left.x - right.x);
  const gaps = [];
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].page === ordered[index].page) {
      const gap = ordered[index - 1].y - ordered[index].y;
      if (gap > 0.5) gaps.push(gap);
    }
  }
  const leading = median(gaps.sort((left, right) => left - right).slice(0, Math.max(1, Math.ceil(gaps.length * 0.7)))) || 12;
  const result = [];
  let current = null;
  for (const line of ordered) {
    const startsBullet = /^\s*•\s+/.test(line.text);
    const gap = current && current.page === line.page ? current.lastY - line.y : Infinity;
    if (startsBullet) {
      current = { page: line.page, x: line.x, y: line.y, lastY: line.y, text: normalizeReconcileText(line.text.replace(/^\s*•\s+/, '')) };
      result.push(current);
    } else if (current && current.page === line.page && gap <= Math.max(leading * 1.5, leading + 2)) {
      current.text = normalizeReconcileText(`${current.text} ${line.text}`);
      current.lastY = line.y;
    } else {
      current = null;
    }
  }
  return result.map((block) => {
    const copy = { ...block };
    delete copy.lastY;
    return copy;
  });
}

function leafContainingEdit(leaves, start, end) {
  // Insertions have an empty old range.  The insertion point must be between
  // two tokens in one existing leaf, never at a leaf/section boundary.
  return leaves.find((leaf) => (end < start
    ? start > leaf.start && start < leaf.end
    : start >= leaf.start && end < leaf.end));
}

function reconcilePlainTextBulletInsertions(main, nodes, current, incoming, anchors, lines) {
  const leaves = plainTextListLeaves(main, nodes);
  const bullets = visualBulletBlocks(lines);
  if (!leaves.length || bullets.length !== leaves.length) return null;
  const boundaries = [[-1, -1], ...anchors, [current.length, incoming.length]];
  const changedLeaves = new Set();
  for (let index = 1; index < boundaries.length; index += 1) {
    const [beforeCurrent, beforeIncoming] = boundaries[index - 1];
    const [afterCurrent, afterIncoming] = boundaries[index];
    if (afterCurrent - beforeCurrent === afterIncoming - beforeIncoming) continue;
    const leaf = leafContainingEdit(leaves, beforeCurrent + 1, afterCurrent - 1);
    if (!leaf) return null;
    changedLeaves.add(leaf);
  }
  if (!changedLeaves.size) return null;
  const reconciledBullets = [];
  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index];
    const expected = textTokens(leaf.element.textContent);
    const observed = reconcileExtractedText(bullets[index].text, expected);
    if (observed.ambiguousHyphen) return null;
    reconciledBullets.push(observed);
    if (!changedLeaves.has(leaf) && expected.join('\u0000') !== observed.tokens.join('\u0000')) return null;
  }
  for (const leaf of changedLeaves) {
    const index = leaves.indexOf(leaf);
    const observed = reconciledBullets[index];
    const expected = textTokens(leaf.element.textContent);
    if (expected.length === observed.tokens.length) {
      if (!replaceTokenSequence([leaf.textNode], observed.tokens)) return null;
    } else {
      // Longer/shorter geometry-bound bullets remain importable, but only
      // after every attached-hyphen separator was resolved against this leaf.
      leaf.element.textContent = observed.text;
    }
  }
  return { changed: true, mappedLeaves: changedLeaves.size, mappedTokens: current.length };
}

/**
 * Name the part of the résumé a token index falls in, for a conflict message.
 *
 * Deliberately structural: the section heading and the element, never the
 * divergent words themselves.  This reason is written into `fit-feedback.json`
 * and read back by the responding model, and a host gate that quotes document
 * text invites the model to edit that text — here the retry is an app-side
 * one and the result is supposed to stay untouched.  A section name is enough
 * to find the divergence by hand and carries nothing to copy.
 */
function resumeTokenLocation(nodes, tokenIndex) {
  let offset = 0;
  for (const node of nodes) {
    const length = textTokens(node.nodeValue).length;
    if (tokenIndex < offset + length) {
      const element = node.parentElement;
      const heading = element?.closest('.section')?.querySelector('.section-head h2');
      const sectionName = normalizeReconcileText(heading?.textContent);
      const elementName = element ? `<${element.localName}${element.className ? ` class="${element.className}"` : ''}>` : '';
      if (sectionName && elementName) return `${sectionName} section, ${elementName}`;
      return sectionName || elementName || '';
    }
    offset += length;
  }
  return '';
}

/**
 * Reconcile résumé text only when every changed range has an unambiguous
 * one-for-one token mapping between stable LCS anchors.  Insertions/removals,
 * a wholly rewritten document, or oversized documents return a conflict.
 */
function reconcileResumeTextBlocks(main, lines) {
  const nodes = visibleResumeTextNodes(main);
  const current = nodes.flatMap(node => textTokens(node.nodeValue));
  const canonicalLines = canonicalizeResumePdfLines(lines, main);
  const extracted = resumePdfTextTokens(canonicalLines, current);
  if (extracted.ambiguousHyphen) {
    return { conflict: 'The résumé PDF has an ambiguous line-ending hyphen; automatic replacement is unsafe.' };
  }
  // Dots are visual separators in several generated runs.  Preserve their
  // trusted DOM placement while comparing/importing the meaningful tokens.
  const incoming = restoreDomPresentationTokens(current, extracted.tokens) || extracted.tokens;
  if (!current.length || !incoming.length) return { conflict: 'The résumé or PDF has no extractable text.' };
  if (current.join('\u0000') === incoming.join('\u0000')) return { changed: false, mappedTokens: current.length };
  const anchors = lcsPairs(current, incoming);
  if (!anchors?.length) return { conflict: 'The résumé PDF has no stable token anchors; automatic replacement is unsafe.' };

  const boundaries = [[-1, -1], ...anchors, [current.length, incoming.length]];
  for (let index = 1; index < boundaries.length; index += 1) {
    const [beforeCurrent, beforeIncoming] = boundaries[index - 1];
    const [afterCurrent, afterIncoming] = boundaries[index];
    if (afterCurrent - beforeCurrent !== afterIncoming - beforeIncoming) {
      const leafResult = reconcilePlainTextBulletInsertions(main, nodes, current, incoming, anchors, lines);
      if (leafResult) return leafResult;
      // Say where the alignment first came apart, and whether the two sides
      // hold the same words. An identical multiset that will not align is a
      // reading-order problem in extraction; a differing one is text the PDF
      // genuinely gained or lost. Those have opposite repairs, and without
      // this the message named neither.
      const location = resumeTokenLocation(nodes, Math.max(0, beforeCurrent + 1));
      const sameWords = [...current].sort().join('\u0000') === [...incoming].sort().join('\u0000');
      return {
        conflict: 'The résumé PDF inserted or removed text; automatic token alignment would be ambiguous.'
          + `${location ? ` The first divergence is in the ${location}.` : ''}`
          + (sameWords
            ? ' Both sides hold the same words in a different order, so the PDF text layer is complete and its reading order could not be reconstructed.'
            : ` The PDF holds ${incoming.length} token(s) against the document's ${current.length}.`),
      };
    }
  }
  if (!replaceTokenSequence(nodes, incoming)) return { conflict: 'The résumé markup could not preserve its text-node boundaries.' };
  return { changed: true, mappedTokens: current.length, anchors: anchors.length };
}

// Text reconciliation already reconstructs the PDF's actual visual reading
// order. Reuse that evidence for the one pagination defect CSS alone cannot
// prove: a section label printed at the foot of one page while the first real
// line it introduces begins on the next. This is deliberately conservative:
// it reports only exact, trusted heading labels and their immediate following
// extracted line, never guesses at paragraph ownership from y-distance.
function inspectPdfPagination(main, kind, blocks) {
  const textBlocks = kind === 'resume' ? resumeContentBlocks(blocks) : (Array.isArray(blocks) ? blocks : []);
  const textPages = [...new Set(textBlocks
    // A PDF text extractor can preserve a drawn whitespace run. That is not
    // document content: without this check a visually blank page could evade
    // the terminal blank-page gate simply by carrying an empty text object.
    .filter(block => normalizeReconcileText(block?.text))
    .map(block => Number(block?.page))
    .filter(page => Number.isSafeInteger(page) && page > 0))].sort((left, right) => left - right);
  if (kind !== 'resume') return { textPages, orphanHeadingCount: 0 };
  const lines = canonicalizeResumePdfLines(blocks, main);
  const headings = [...main.querySelectorAll('.section-head h2, .subsection-head h3')]
    .map(element => foldedText(normalizeReconcileText(element.textContent)))
    .filter(Boolean);
  let cursor = 0;
  let orphanHeadingCount = 0;
  for (const heading of headings) {
    let index = -1;
    for (let candidate = cursor; candidate < lines.length; candidate += 1) {
      if (foldedText(lines[candidate]?.text) === heading) { index = candidate; break; }
    }
    if (index < 0) continue; // Text reconciliation itself will reject a missing heading.
    cursor = index + 1;
    const following = lines.slice(cursor).find(line => normalizeReconcileText(line?.text));
    if (following && Number(lines[index]?.page) < Number(following.page)) orphanHeadingCount += 1;
  }
  return { textPages, orphanHeadingCount };
}

/**
 * Pure reconciliation over already-extracted PDF lines.  It preserves all
 * application HTML outside the selected panel and returns the original HTML on
 * every conflict.
 */
export function reconcileApplicationHtmlFromPdfBlocks({ applicationHtml, html, documentKind = 'resume', document, blocks = [] } = {}) {
  const source = String(applicationHtml ?? html ?? '');
  const kind = documentKind || document || 'resume';
  if (!source) return conflictResult(source, 'Application HTML is missing.');
  if (!['resume', 'cover'].includes(kind)) return conflictResult(source, 'Document kind must be resume or cover.');
  // Retain parser locations so replacement operates on the original bytes,
  // rather than on JSDOM's normalized serialization.  Saved Application.html
  // intentionally keeps trusted outer-shell formatting and may use quoting or
  // entity spelling that `main.outerHTML` does not reproduce.
  const dom = new JSDOM(source, { includeNodeLocations: true });
  try {
    const main = panelForKind(dom.window.document, kind);
    if (!main) return conflictResult(source, `The ${kind} panel is missing.`);
    // Keep the exact source slice, not a serialized full document.  The
    // workspace carries executable chrome/CSP whose formatting is trusted and
    // must remain byte-for-byte intact when only the document panel changes.
    const mainLocation = dom.nodeLocation(main);
    if (!mainLocation || !Number.isInteger(mainLocation.startOffset) || !Number.isInteger(mainLocation.endOffset)) {
      return conflictResult(source, 'The selected panel cannot be replaced without rewriting the trusted outer shell.');
    }
    const { startOffset, endOffset } = mainLocation;
    const trustedMainHtml = source.slice(startOffset, endOffset);
    const result = kind === 'cover'
      ? reconcileCoverTextBlocks(main, blocks)
      : reconcileResumeTextBlocks(main, blocks);
    const pagination = inspectPdfPagination(main, kind, blocks);
    if (result.conflict) return { ...conflictResult(source, result.conflict), pagination };
    if (!result.changed) return { success: true, status: 'unchanged', html: source, exactTextMatch: true, reason: 'PDF text already matches the selected panel.', pagination, ...result };
    let sanitized = sanitizeDocumentMainHtml(main.outerHTML, { documentKind: kind, allowHostState: true, allowTrustedDerivations: true });
    if (kind === 'resume') sanitized = restoreTrustedReceiptDerivations(sanitized, trustedMainHtml);
    const updatedHtml = `${source.slice(0, startOffset)}${sanitized}${source.slice(endOffset)}`;
    return { success: true, status: 'updated', html: updatedHtml, changed: true, exactTextMatch: false, reason: 'Reconciled the selected panel from the external PDF.', pagination, ...result };
  } finally {
    dom.window.close();
  }
}

/** Extract the PDF then reconcile one selected application panel. */
async function reconcileApplicationPdf({ applicationHtml, html, pdfBytes, documentKind = 'resume', document } = {}) {
  const blocks = await extractPdfTextBlocks(pdfBytes);
  return reconcileApplicationHtmlFromPdfBlocks({ applicationHtml, html, documentKind, document, blocks });
}

// Integration-facing name: accepts PDF bytes and intentionally shares the
// same cautious result contract as the pure `...FromPdfBlocks` helper.
export const reconcileApplicationHtmlFromPdf = reconcileApplicationPdf;
