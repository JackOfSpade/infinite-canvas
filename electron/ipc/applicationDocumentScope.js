/**
 * Which documents one application job produces, and what a saved bundle holds.
 *
 * A job created by a card's Résumé or Cover letter button carries a
 * `documentScope`. A job without one predates the split and produces both, so
 * every helper here treats an absent scope as "both".
 */
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
