// Pure, side-effect-free indicator for "you applied to this role before".
// Kept free of React so it can be exercised in isolation.
//
// A recruiter reposting the same role under a new listing URL leaves the card
// without its own saved bundle (so no red X), but an earlier bundle for the same
// company + title exists. `data.priorRoleApplication` points at it. A card that
// owns a saved bundle never shows this indicator.

// Sky/cyan palette: red means saved, emerald saved-docs, amber warning.
export const PRIOR_ROLE_TONE = Object.freeze({
  badge: 'border border-sky-400/40 bg-sky-500/20 text-sky-200',
});

const DATE_FORMAT = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };

function formatAppliedDate(appliedAt) {
  if (typeof appliedAt !== 'string' && typeof appliedAt !== 'number') return '';
  if (appliedAt === '') return '';
  const date = new Date(appliedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', DATE_FORMAT);
}

export function priorRoleIndicator(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.localApplication?.status === 'saved') return null;
  const prior = data.priorRoleApplication;
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return null;
  if (typeof prior.id !== 'string' || prior.id.length === 0) return null;
  if (typeof prior.savedDir !== 'string' || prior.savedDir.length === 0) return null;

  const date = formatAppliedDate(prior.appliedAt);
  let detail = date ? `Applied ${date}` : 'Applied earlier';
  if (typeof prior.location === 'string' && prior.location.length > 0) detail += ` · ${prior.location}`;

  return {
    label: 'Applied to this role before',
    detail,
    title: `This is a different listing (a new posting) for the same company and title you already applied to. The earlier bundle's résumé and cover letter can be reused. Folder: ${prior.savedDir}`,
  };
}

function validPriorPointer(data) {
  if (!data || typeof data !== 'object') return null;
  const prior = data.priorRoleApplication;
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return null;
  if (typeof prior.id !== 'string' || prior.id.length === 0) return null;
  if (typeof prior.savedDir !== 'string' || prior.savedDir.length === 0) return null;
  return prior;
}

// Documents held by the earlier bundle of a reposted role. Unlike
// priorRoleIndicator this does not step aside for an owned saved bundle: the
// earlier bundle's documents still count as existing. A bundle with no record
// of its contents holds both.
export function priorRoleDocuments(data) {
  const prior = validPriorPointer(data);
  if (!prior) return { resume: false, cover: false };
  const docs = prior.savedDocuments;
  if (docs && typeof docs === 'object' && typeof docs.resume === 'boolean' && typeof docs.cover === 'boolean') {
    return { resume: docs.resume, cover: docs.cover };
  }
  return { resume: true, cover: true };
}

// Patches that clear every job card referencing a deleted bundle.
export function bundleDeletionPatches(nodes, jobId) {
  if (typeof jobId !== 'string' || jobId.length === 0) return [];
  if (!Array.isArray(nodes)) return [];
  const patches = [];
  for (const node of nodes) {
    if (!node || node.type !== 'jobcard') continue;
    const data = node.data;
    if (!data || typeof data !== 'object') continue;
    let patch = null;
    if (data.localApplication?.id === jobId) {
      patch = { localApplication: null, priorSavedApplication: null };
    } else if (data.priorSavedApplication?.id === jobId) {
      patch = { priorSavedApplication: null };
    }
    if (data.priorRoleApplication?.id === jobId) patch = { ...(patch || {}), priorRoleApplication: null };
    if (patch) patches.push({ id: node.id, patch });
  }
  return patches;
}

export default priorRoleIndicator;
