/**
 * Join a newly generated single document into a saved application folder.
 *
 * The kept document may hold hand edits, so its markup is spliced byte-for-byte
 * and never rebuilt: rebuilding would re-run generation-time gates over what the
 * person typed, and could refuse or rewrite it.
 *
 * The résumé panel's chrome is the base either way. It is the fuller of the two
 * (a letter-only file has no résumé panel to add a tab beside), so a résumé
 * joining a letter takes the fresh résumé file and carries the kept letter in.
 */
import { JSDOM } from 'jsdom';
import { applicationBundleDataFromHtml, otherApplicationDocument, workspaceDocumentKinds } from './applicationDocumentScope.js';
import { applicationCoverPanelMarkup, APPLICATION_COVER_TAB_MARKUP } from './resumeHtml.js';

const BUNDLE_NODE_RE = /(<script\s+id="ic-application-bundle-data"\s+type="application\/json"(?:\s+nonce="[^"]+")?>)[\s\S]*?(<\/script>)/i;

const scriptLiteralRe = name => new RegExp(`var ${name} = ("(?:[^"\\\\]|\\\\.)*");`, 'gu');

function readScriptLiteral(html, name) {
  const matches = [...String(html).matchAll(scriptLiteralRe(name))];
  if (matches.length !== 1) return null;
  try { return JSON.parse(matches[0][1]); } catch { return null; }
}

function writeScriptLiteral(html, name, value) {
  const matches = [...String(html).matchAll(scriptLiteralRe(name))];
  if (matches.length > 1) throw new Error(`Application workspace has an ambiguous ${name}; the document was not merged.`);
  // A file from before this literal existed has no slot to stamp, and its page
  // script does not read one.
  if (!matches.length) return html;
  const encoded = JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${html.slice(0, matches[0].index)}var ${name} = ${encoded};${html.slice(matches[0].index + matches[0][0].length)}`;
}

function panelLocations(html) {
  const dom = new JSDOM(String(html), { includeNodeLocations: true });
  try {
    const doc = dom.window.document;
    const single = selector => {
      const nodes = doc.querySelectorAll(selector);
      if (nodes.length !== 1) throw new Error(`Application workspace has ${nodes.length} ${selector} nodes; the document was not merged.`);
      return dom.nodeLocation(nodes[0]);
    };
    const coverPanels = doc.querySelectorAll('[data-ic-document-panel="cover"]');
    const coverMain = coverPanels.length === 1 ? coverPanels[0].querySelector('main.page') : null;
    return {
      resumePanel: single('[data-ic-document-panel="resume"]'),
      resumeTab: single('[data-ic-document-tab="resume"]'),
      coverPanel: coverPanels.length === 1 ? dom.nodeLocation(coverPanels[0]) : null,
      coverTab: doc.querySelectorAll('[data-ic-document-tab="cover"]').length === 1 ? dom.nodeLocation(doc.querySelector('[data-ic-document-tab="cover"]')) : null,
      coverMain: coverMain ? dom.nodeLocation(coverMain) : null,
    };
  } finally { dom.window.close(); }
}

function coverMainMarkup(html) {
  const dom = new JSDOM(String(html), { includeNodeLocations: true });
  try {
    const main = dom.window.document.querySelector('[data-ic-document-panel="cover"] main.page');
    const location = main ? dom.nodeLocation(main) : null;
    if (!location) throw new Error('Application workspace has no cover letter to merge.');
    return String(html).slice(location.startOffset, location.endOffset);
  } finally { dom.window.close(); }
}

function withCoverPanel(baseHtml, coverMain) {
  const at = panelLocations(baseHtml);
  // Applied from the end of the file backward so earlier offsets stay valid.
  const edits = [];
  if (at.coverPanel) edits.push({ start: at.coverPanel.startOffset, end: at.coverPanel.endOffset, text: applicationCoverPanelMarkup(coverMain) });
  else edits.push({ start: at.resumePanel.endOffset, end: at.resumePanel.endOffset, text: `\n    ${applicationCoverPanelMarkup(coverMain)}` });
  if (!at.coverTab) edits.push({ start: at.resumeTab.endOffset, end: at.resumeTab.endOffset, text: `\n      ${APPLICATION_COVER_TAB_MARKUP}` });
  let html = String(baseHtml);
  for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  return html;
}

function withBundleData(html, data) {
  const encoded = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  if (!BUNDLE_NODE_RE.test(html)) throw new Error('Application workspace has no bundle data; the document was not merged.');
  return html.replace(BUNDLE_NODE_RE, (_match, open, close) => `${open}${encoded}${close}`);
}

/**
 * @returns null when the folder holds nothing to keep, so the save writes the
 *   new document alone. Otherwise the merged HTML, which document was kept, and
 *   that document's last synced revision pair.
 */
export function mergeApplicationDocument({ existingHtml, stagedHtml, documentScope }) {
  const keptKind = otherApplicationDocument(documentScope);
  if (!workspaceDocumentKinds(existingHtml).includes(keptKind)) return null;
  const existingData = applicationBundleDataFromHtml(existingHtml);
  const keptSyncDocument = existingData?.sync?.documents?.[keptKind] || null;
  let html;
  let data;
  if (documentScope === 'cover') {
    html = withCoverPanel(existingHtml, coverMainMarkup(stagedHtml));
    html = writeScriptLiteral(html, 'COVER_MARKUP_FINGERPRINT', readScriptLiteral(stagedHtml, 'COVER_MARKUP_FINGERPRINT'));
    data = { ...existingData };
  } else {
    html = withCoverPanel(stagedHtml, coverMainMarkup(existingHtml));
    // Keep the letter's browser-saved edits reachable: its autosave slots are
    // keyed by the letter's own file identity and generation stamp.
    html = writeScriptLiteral(html, 'COVER_MARKUP_FINGERPRINT', readScriptLiteral(existingHtml, 'COVER_MARKUP_FINGERPRINT'));
    const docId = readScriptLiteral(existingHtml, 'DOC_ID');
    if (docId) html = writeScriptLiteral(html, 'DOC_ID', docId);
    data = { ...applicationBundleDataFromHtml(stagedHtml), ...(existingData.coverLetterAudit ? { coverLetterAudit: existingData.coverLetterAudit } : {}) };
  }
  delete data.documentScope;
  delete data.letterRemoved;
  html = withBundleData(html, data);
  const kinds = workspaceDocumentKinds(html);
  if (!kinds.includes('resume') || !kinds.includes('cover')) throw new Error('Merged application workspace does not hold both documents.');
  panelLocations(html);
  return { html, keptKind, keptSyncDocument };
}
