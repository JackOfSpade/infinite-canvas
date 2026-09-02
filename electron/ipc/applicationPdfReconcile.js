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

export function normalizePdfText(value) {
  return String(value || '')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // pdf.js separates visual lines, so a normally hyphenated word that wraps
    // can arrive as `full- scale`. The DOM still contains `full-scale`; join
    // only an attached ASCII hyphen followed by an alphanumeric continuation.
    // A true spaced dash (`word - next`) keeps its leading space and therefore
    // does not match this repair.
    .replace(/([\p{L}\p{N}])- +(?=[\p{L}\p{N}])/gu, '$1-')
    .replace(/\s+/g, ' ')
    .trim();
}

function textTokens(value) {
  return normalizePdfText(value).match(PDF_TEXT_TOKEN) || [];
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
    .filter(item => normalizePdfText(item.text))
    .sort((left, right) => right.y - left.y || left.x - right.x);
  const lines = [];
  for (const item of ordered) {
    let line = lines.find(candidate => sameVisualLine(candidate, item));
    if (!line) {
      line = { page, x: item.x, y: item.y, width: item.width, height: item.height, text: '', items: [] };
      lines.push(line);
    }
    const previous = line.items[line.items.length - 1];
    line.text += `${needsSpace(previous, item) ? ' ' : ''}${item.text}`;
    line.items.push(item);
    line.x = Math.min(line.x, item.x);
    line.y = Math.max(line.y, item.y);
    line.width = Math.max(line.width, item.x + item.width - line.x);
    line.height = Math.max(line.height, item.height);
  }
  return lines
    .map(line => ({ ...line, text: normalizePdfText(line.text) }))
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
    .filter(line => normalizePdfText(line?.text))
    .map(line => ({ ...line, text: normalizePdfText(line.text) }))
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
      previous.text = normalizePdfText(`${previous.text} ${line.text}`);
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
    return normalizePdfText(element.textContent);
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
  // does. textTokens() runs normalizePdfText() first (e.g. it rejoins a
  // hyphen-then-space into one word), so a raw nodeValue containing such an
  // artifact tokenizes to a different count here than PDF_TEXT_TOKEN finds
  // when matched directly against that same raw nodeValue in the loop.
  // Matching the raw string here keeps both counts in sync, so any mismatch
  // is caught below instead of desyncing tokenIndex mid-substitution.
  const originals = nodes.flatMap(node => String(node.nodeValue || '').match(PDF_TEXT_TOKEN) || []);
  if (originals.length !== replacementTokens.length) return false;
  let tokenIndex = 0;
  for (const node of nodes) {
    node.nodeValue = String(node.nodeValue || '').replace(PDF_TEXT_TOKEN, () => replacementTokens[tokenIndex++] || '');
  }
  return true;
}

function replaceCoverLeafText(element, replacement) {
  const currentTokens = textTokens(element.textContent);
  const replacementTokens = textTokens(replacement);
  // PDF layout commonly inserts visual whitespace around separators whose DOM
  // spans are intentionally flush ("Engineer·B.S." -> "Engineer · B.S.").
  // Token equality is the semantic equality used by the résumé path too; do
  // not report or serialize a fake edit for spacing the PDF text layer cannot
  // faithfully round-trip.
  if (currentTokens.join('\u0000') === replacementTokens.join('\u0000')) return { changed: false };
  const children = [...element.children];
  if (children.length === 0) {
    element.textContent = replacement;
    return { changed: true };
  }
  const nodes = leafTextNodes(element);
  if (!replaceTokenSequence(nodes, replacementTokens)) {
    return { conflict: `The PDF changed structured ${element.className || element.localName} text in a way that cannot preserve its markup.` };
  }
  return { changed: true };
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
  if (lines.length < prefixLeaves.length + suffixLeaves.length) return { conflict: 'The PDF has too little text to map the cover-letter envelope.' };

  const prefix = lines.slice(0, prefixLeaves.length).map(line => line.text);
  const suffix = lines.slice(lines.length - suffixLeaves.length).map(line => line.text);
  const bodyLines = lines.slice(prefixLeaves.length, lines.length - suffixLeaves.length);
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
  return normalizePdfText(value).toLocaleLowerCase();
}

function collapsedTrackedHeading(text, knownHeadings) {
  const normalized = normalizePdfText(text);
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
    if (element.localName === 'dt') label = normalizePdfText(element.textContent);
    else if (element.localName === 'dd' && label) {
      rows.push({ label, value: normalizePdfText(element.textContent) });
      label = null;
    }
  }
  return rows.filter(row => row.label && row.value);
}

function semanticSkillLines(lines, rows) {
  const source = normalizePdfText(lines.map(line => line.text).join(' '));
  let offset = 0;
  const reordered = [];
  for (const row of rows) {
    const labelOffset = foldedText(source).indexOf(foldedText(row.label), offset);
    if (labelOffset < offset) return null;
    const value = normalizePdfText(source.slice(offset, labelOffset));
    if (!value) return null;
    // The print layout puts the `dd` value before its `dt` label, and can put
    // them flush together (`BashLanguages`).  Reconstruct DOM order without
    // guessing individual skill boundaries.
    reordered.push({ ...lines[0], text: row.label }, { ...lines[0], text: value });
    offset = labelOffset + row.label.length;
  }
  return offset === source.length ? reordered : null;
}

/**
 * Translate known print-only résumé representations back to the document's
 * semantic reading order.  It deliberately relies on the current DOM for
 * headings and skill labels, so it cannot invent a structure from a foreign
 * or damaged PDF.
 */
function canonicalizeResumePdfLines(lines, main) {
  const knownHeadings = [...main.querySelectorAll('.section-head h2')].map(element => normalizePdfText(element.textContent));
  const normalized = (Array.isArray(lines) ? lines : []).map(line => ({
    ...line,
    // `•` is a visual list marker, never a text node in the generated HTML.
    text: collapsedTrackedHeading(normalizePdfText(line.text).replace(/^•\s*/, ''), knownHeadings),
  }));
  const skillsHeading = knownHeadings.find(heading => foldedText(heading) === 'skills');
  const skillsIndex = normalized.findIndex(line => skillsHeading && foldedText(line.text) === foldedText(skillsHeading));
  const rows = skillRows(main);
  if (skillsIndex < 0 || !rows.length) return normalized;
  const reordered = semanticSkillLines(normalized.slice(skillsIndex + 1), rows);
  return reordered ? [...normalized.slice(0, skillsIndex + 1), ...reordered] : normalized;
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
    return Number.isInteger(start) && length ? [{ element, start, end: start + length }] : [];
  });
}

function visualBulletBlocks(lines) {
  const ordered = (Array.isArray(lines) ? lines : [])
    .filter(line => normalizePdfText(line?.text))
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
      current = { page: line.page, x: line.x, y: line.y, lastY: line.y, text: normalizePdfText(line.text.replace(/^\s*•\s+/, '')) };
      result.push(current);
    } else if (current && current.page === line.page && gap <= Math.max(leading * 1.5, leading + 2)) {
      current.text = normalizePdfText(`${current.text} ${line.text}`);
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
  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index];
    const expected = textTokens(leaf.element.textContent);
    const observed = textTokens(bullets[index].text);
    if (!changedLeaves.has(leaf) && expected.join('\u0000') !== observed.join('\u0000')) return null;
  }
  for (const leaf of changedLeaves) {
    const index = leaves.indexOf(leaf);
    leaf.element.textContent = bullets[index].text;
  }
  return { changed: true, mappedLeaves: changedLeaves.size, mappedTokens: current.length };
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
  const extracted = canonicalLines.flatMap(line => textTokens(line.text));
  // Dots are visual separators in several generated runs.  Preserve their
  // trusted DOM placement while comparing/importing the meaningful tokens.
  const incoming = restoreDomPresentationTokens(current, extracted) || extracted;
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
      return { conflict: 'The résumé PDF inserted or removed text; automatic token alignment would be ambiguous.' };
    }
  }
  if (!replaceTokenSequence(nodes, incoming)) return { conflict: 'The résumé markup could not preserve its text-node boundaries.' };
  return { changed: true, mappedTokens: current.length, anchors: anchors.length };
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
    if (result.conflict) return conflictResult(source, result.conflict);
    if (!result.changed) return { success: true, status: 'unchanged', html: source, exactTextMatch: true, reason: 'PDF text already matches the selected panel.', ...result };
    let sanitized = sanitizeDocumentMainHtml(main.outerHTML, { documentKind: kind, allowHostState: true, allowTrustedDerivations: true });
    if (kind === 'resume') sanitized = restoreTrustedReceiptDerivations(sanitized, trustedMainHtml);
    const updatedHtml = `${source.slice(0, startOffset)}${sanitized}${source.slice(endOffset)}`;
    return { success: true, status: 'updated', html: updatedHtml, changed: true, exactTextMatch: false, reason: 'Reconciled the selected panel from the external PDF.', ...result };
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
