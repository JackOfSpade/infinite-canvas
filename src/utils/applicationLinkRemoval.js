import { appliedCheckTime } from './applicationBundleIdentity.js';
import { getRunningApplicationDocument } from './applicationDocumentRuns.js';
import { getOfficialPostingPreparation } from './officialPostingPreparation.js';

// A search drops every listing whose links match a saved application bundle
// (filterAppliedListings) and stamps each row it keeps with the time of that
// check (`appliedCheckAt`). A card's verified official posting is only found
// AFTER its search ran, so a repost of an applied job on another board can reach
// the Board and only then match the bundle. When the card's row passed the check
// after the bundle was saved, the check would have dropped it had it known the
// link: such a card is removed instead of shown with the exact-listing X. A
// missing stamp (every row checked before the stamp existed) and any lock keep
// the card (the X stays); a card with work in flight waits for a later tick.

/**
 * True while the card is generating or about to: its Generate click holds the
 * card's application-document claim from before its first await until it ends,
 * its official-posting preparation (or its Board's refresh) holds a claim, or
 * the module run queue holds an active or queued run for it.
 *
 * @param {object} card
 * @param {{ canvasFilePath?: string|null, queueSnapshot?: object|null }} [context]
 */
export function jobCardHasApplicationWorkInFlight(card, { canvasFilePath = null, queueSnapshot = null } = {}) {
  const cardId = typeof card?.id === 'string' ? card.id : '';
  if (!cardId) return false;
  if (getRunningApplicationDocument(cardId)) return true;
  if (getOfficialPostingPreparation(canvasFilePath, cardId)) return true;
  const hubId = typeof card?.data?.hubId === 'string' ? card.data.hubId : '';
  if (hubId && getOfficialPostingPreparation(canvasFilePath, hubId)) return true;
  const runs = [
    ...(Array.isArray(queueSnapshot?.activeRuns) ? queueSnapshot.activeRuns : []),
    ...(queueSnapshot?.active ? [queueSnapshot.active] : []),
    ...(Array.isArray(queueSnapshot?.queued) ? queueSnapshot.queued : []),
  ];
  return runs.some(run => run?.nodeId === cardId);
}

/**
 * True only when an exact saved-bundle match should REMOVE the card: the card
 * has no bundle of its own, neither it nor its Board is locked, and its row
 * provably passed the applied-listing check strictly after the bundle was
 * saved. A removable card with work in flight (jobCardHasApplicationWorkInFlight)
 * is deferred by the caller: neither removed nor given the X until it settles.
 *
 * @param {object} card              live job card node
 * @param {object} localApplication  the matched bundle pointer (findSavedApplicationLinks)
 * @param {(id: string) => object|null} findNode  live node lookup across levels
 */
export function shouldRemoveCardFoundAfterApplication(card, localApplication, findNode) {
  if (card?.type !== 'jobcard' || !card.data || card.data.localApplication || card.data.locked) return false;
  const hubId = typeof card.data.hubId === 'string' ? card.data.hubId : '';
  if (hubId && findNode?.(hubId)?.data?.locked) return false;
  const importedAt = Date.parse(typeof localApplication?.receipt?.importedAt === 'string' ? localApplication.receipt.importedAt : '');
  if (!Number.isFinite(importedAt)) return false;
  const checkedAt = appliedCheckTime(card.data);
  return checkedAt != null && checkedAt > importedAt;
}

const MAX_NAMED_REMOVALS = 3;

/** The one toast naming the cards a restore tick removed, or null. */
export function appliedRemovalToast(cards) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  if (!list.length) return null;
  const clean = value => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '');
  const names = list.slice(0, MAX_NAMED_REMOVALS).map((card) => {
    const parts = [clean(card?.data?.company), clean(card?.data?.title)].filter(Boolean);
    return parts.length ? parts.join(' — ') : 'Untitled job';
  });
  const more = list.length - names.length;
  const count = `${list.length} job${list.length === 1 ? '' : 's'}`;
  return {
    title: 'Already applied',
    description: `Removed ${count} you already applied to: ${names.join('; ')}${more > 0 ? `; +${more} more` : ''}`,
    type: 'info',
  };
}
