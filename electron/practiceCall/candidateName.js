/**
 * The candidate's own name for a practice call, read from the approved career snapshot the
 * interview was prepared from (profile.identity.name). A real interviewer has the application in
 * front of them and greets the candidate by name. The name is read in the main process only: the
 * Interview Helper's renderer projection of a snapshot leaves identity out on purpose, and this
 * does not change that. An unreadable snapshot or a missing name yields '' and the interviewer
 * then speaks without a name.
 */
import { careerSnapshotStorageRoot, readPinnedCareerSnapshot } from '../ipc/careerSnapshot.js';

const MAX_NAME_CHARS = 80;

/** One line of plain text: no line breaks, no bracket or quote characters a prompt would misread. */
export function cleanCandidateName(value) {
  if (typeof value !== 'string') return '';
  // Invisible format characters go, except the two joiners that are part of the spelling in
  // Persian, Urdu and several Indic scripts.
  const line = value.replace(/(?![\u200c\u200d])\p{Cf}/gu, '').replace(/[\p{Cc}[\]<>{}"`]/gu, ' ').replace(/\s+/g, ' ').trim();
  return line.length > MAX_NAME_CHARS ? '' : line;
}

export async function loadCandidateName({
  snapshotId, userDataPath, readSnapshot = readPinnedCareerSnapshot, storageRoot = careerSnapshotStorageRoot,
} = {}) {
  if (typeof snapshotId !== 'string' || !snapshotId || typeof userDataPath !== 'string' || !userDataPath) return '';
  const snapshot = await readSnapshot(storageRoot(userDataPath), snapshotId, { readOnly: true });
  return cleanCandidateName(snapshot?.profile?.identity?.name);
}
