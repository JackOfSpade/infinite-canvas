/**
 * Which documents one application job produces, and what a saved bundle holds.
 *
 * A job created by a card's Résumé or Cover letter button carries a
 * `documentScope`. A job without one predates the split and produces both, so
 * every helper here treats an absent scope as "both".
 */
import { JSDOM } from 'jsdom';

export const APPLICATION_DOCUMENT_KINDS = Object.freeze(['resume', 'cover']);

export function normalizeApplicationDocumentScope(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!APPLICATION_DOCUMENT_KINDS.includes(value)) throw new Error('Invalid application document.');
  return value;
}

export function otherApplicationDocument(kind) {
  return kind === 'resume' ? 'cover' : 'resume';
}

export function applicationDocumentLabel(kind) {
  return kind === 'cover' ? 'cover letter' : 'résumé';
}

/**
 * Stands in for the render of the document a job does not produce. It passes
 * every fit and fault check without measuring anything, and `absent` is how the
 * import path tells it apart from a real render with no bytes.
 */
export const ABSENT_DOCUMENT_FIT = Object.freeze({
  absent: true, bytes: null, pageCount: 1, fontsLoaded: true, renderError: null, missingFontFaces: Object.freeze([]),
  layout: null, layoutIssues: Object.freeze([]), attempts: Object.freeze([]), contentUtilization: null, compactApplied: false,
});

/** The documents a generated Application.html's bundle data says it holds. */
export function workspaceDocumentKindsFromBundleData(data) {
  if (data?.documentScope === 'cover') return ['cover'];
  if (data?.documentScope === 'resume' || data?.letterRemoved === true) return ['resume'];
  return ['resume', 'cover'];
}

const BUNDLE_DATA_RE = /<script\s+id="ic-application-bundle-data"\s+type="application\/json"(?:\s+nonce="[^"]+")?>([\s\S]*?)<\/script>/i;

export function applicationBundleDataFromHtml(html) {
  const match = BUNDLE_DATA_RE.exec(String(html || ''));
  if (!match) return {};
  try {
    const data = JSON.parse(match[1]);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function workspaceDocumentKinds(html) {
  return workspaceDocumentKindsFromBundleData(applicationBundleDataFromHtml(html));
}

/** `savedDocuments` as the card reads it: one boolean per document. */
export function savedDocumentsFromHtml(html) {
  const kinds = workspaceDocumentKinds(html);
  return { resume: kinds.includes('resume'), cover: kinds.includes('cover') };
}

/**
 * The approved achievements a letter-only job may argue from, shaped like the
 * résumé the letter checks expect. It is never rendered as a document, shown as
 * one, or written to a bundle: without it the letter would be graded against
 * nothing, and with a writer-authored résumé the job would spend the usage it
 * exists to save. Every bullet is an exact approved catalog quote.
 */
export function evidenceResumeForLetter({ identity, sourceRoles, profile, catalog }) {
  const rows = Array.isArray(catalog) ? catalog : [];
  const achievementRows = id => rows.filter(row => row?.id?.startsWith(`host.career.achievement.${id}.`));
  const roles = (Array.isArray(sourceRoles) ? sourceRoles : []).map(role => ({
    id: role.id, title: role.title, company: role.company, dates: role.dates,
    ...(role.location ? { location: role.location } : {}),
    bullets: (profile?.achievements || []).filter(achievement => achievement.roleId === role.id)
      .flatMap(achievement => achievementRows(achievement.id).map(row => ({
        id: `evidence-${row.id.replace(/[^a-z0-9]+/giu, '-')}`, text: String(row.cleanQuote || row.quote || '').replace(/\s+/gu, ' ').trim(), evidenceIds: [row.id],
      })))
      .filter(bullet => bullet.text),
  })).filter(role => role.bullets.length);
  return { schemaVersion: 'structured-resume.v1', identity: { name: identity?.name || '', contact: [...(identity?.contact || [])],
      ...(identity?.subtitleRole ? { subtitleRole: identity.subtitleRole } : {}), ...(identity?.credential ? { credential: identity.credential } : {}) },
    roles, projects: [], skills: [], education: [], credentials: [] };
}

/**
 * How much of a saved résumé a cover-only letter writer may see. It is a
 * prompt-side context aid, not a document: the letter is checked against the
 * approved catalog exactly as before, so the cap only bounds the reading.
 */
export const SAVED_RESUME_TEXT_MAX_CHARS = 6000;

const SAVED_RESUME_BLOCK_SELECTOR = 'h1, h2, h3, h4, p, li';
const HIDDEN_BLOCK_SELECTOR = '[hidden], [aria-hidden="true"]';
const collapseBlockText = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

/**
 * The plain text of the saved résumé panel in a saved Application.html: one
 * line per content block, hidden blocks skipped, whitespace collapsed, and the
 * letter panel never read. Joining a cover-only letter job reads the saved
 * file (not the original generation) so the writer sees the user's own synced
 * edits. Capped at a line boundary so a cut line is never half a claim.
 */
export function savedResumeTextFromHtml(html) {
  const dom = new JSDOM(String(html ?? ''));
  try {
    const panel = dom.window.document.querySelector('[data-ic-document-panel="resume"] main.page');
    if (!panel) return '';
    const selected = [];
    let text = '';
    for (const element of panel.querySelectorAll(SAVED_RESUME_BLOCK_SELECTOR)) {
      if (selected.some(parent => parent.contains(element))) continue;
      if (element.closest(HIDDEN_BLOCK_SELECTOR)) continue;
      selected.push(element);
      const line = collapseBlockText(element.textContent);
      if (!line) continue;
      const next = text ? `${text}\n${line}` : line;
      if (next.length > SAVED_RESUME_TEXT_MAX_CHARS) {
        // Nothing fits yet: one over-long first block is cut to the ceiling.
        if (!text) text = line.slice(0, SAVED_RESUME_TEXT_MAX_CHARS);
        break;
      }
      text = next;
    }
    return text;
  } finally { dom.window.close(); }
}
