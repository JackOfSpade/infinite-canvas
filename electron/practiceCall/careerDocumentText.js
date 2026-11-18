/**
 * The career documents the candidate provided for this interview (the text of the files the
 * approved career snapshot was compiled from), for a job that has no application of its own, such
 * as a typed job. Read in the main process from the snapshot store, as candidateName.js does. The
 * text is the converted text when a file was converted. An unreadable snapshot yields '' and the
 * caller treats that as no documents.
 */
import { careerDataFromCareerSnapshot, careerSnapshotStorageRoot, readPinnedCareerSnapshot } from '../ipc/careerSnapshot.js';

export const CAREER_DOCUMENT_MAX_CHARS = 40000;

/** Keeps every file represented: the budget is shared evenly, and a short file gives its spare room to the others. */
export function capCareerDocumentText(text, maxChars = CAREER_DOCUMENT_MAX_CHARS) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length <= maxChars) return value;
  const parts = value.split(/\n\n(?=={5} FILE: )/u).filter(Boolean);
  if (parts.length < 2) return value.slice(0, maxChars);
  const budgets = new Array(parts.length).fill(0);
  let left = maxChars;
  let open = parts.map((_, index) => index);
  while (open.length && left > 0) {
    const share = Math.floor(left / open.length) || 1;
    const next = [];
    for (const index of open) {
      const give = Math.min(share, parts[index].length - budgets[index], left);
      budgets[index] += give;
      left -= give;
      if (budgets[index] < parts[index].length) next.push(index);
    }
    if (next.length === open.length && share === 1 && left <= 0) break;
    open = next;
  }
  return parts.map((part, index) => part.slice(0, budgets[index])).join('\n\n');
}

export async function loadCareerDocumentText({
  snapshotId, userDataPath, readSnapshot = readPinnedCareerSnapshot, storageRoot = careerSnapshotStorageRoot,
  toText = careerDataFromCareerSnapshot, maxChars = CAREER_DOCUMENT_MAX_CHARS,
} = {}) {
  if (typeof snapshotId !== 'string' || !snapshotId || typeof userDataPath !== 'string' || !userDataPath) return '';
  const snapshot = await readSnapshot(storageRoot(userDataPath), snapshotId, { readOnly: true });
  if (!snapshot) return '';
  return capCareerDocumentText(toText(snapshot), maxChars);
}
