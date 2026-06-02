import { useCallback, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { statusCheckWrites, statusErrorWrites } from '../utils/listingStatusWrites';

const DEFAULT_FIELDS = { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked' };

/**
 * Walks every node of `cardType` connected outbound from `hubId` and runs
 * `check-listing-status` against each in sequence. Backs the SellHub
 * "Check All" button. (The hubId-tag ownership walk below also supported
 * Job Search Module's "Check All Statuses", but the transient-card overhaul removed
 * job-card monitoring; the branch is kept for potential reuse.)
 *
 * Sequential is deliberate: marketplaces and job boards both rate-limit
 * single-IP bursts hard, and the user's a single source — fanning out N
 * concurrent fetches buys nothing and risks N "needs-login" false positives.
 *
 * @param {object} opts
 * @param {string} opts.hubId
 * @param {string} opts.cardType — ReactFlow node type to walk (e.g. 'marketplacecard')
 * @param {(cardData) => string} opts.getUrl
 * @param {(cardData) => string} opts.getPlatformId
 * @param {{status, message, lastChecked}} [opts.fields]
 * @param {(id, patch) => void} opts.updateNode
 * @param {string} [opts.itemLabel] — singular noun for the toast ("marketplace", "job")
 */
export function useCheckAllConnected({
  hubId,
  cardType,
  getUrl,
  getPlatformId,
  // Optional getters for the new multi-source check args. Defaults match the
  // marketplacecard shape (data.watchUrls, data.productSnapshot.title); pass
  // explicit getters for other card types (or to opt out by returning empty).
  getWatchUrls    = (d) => Array.isArray(d?.watchUrls) ? d.watchUrls : [],
  getProductTitle = (d) => d?.productSnapshot?.title || '',
  fields = DEFAULT_FIELDS,
  updateNode,
  itemLabel = 'item',
}) {
  const { getEdges, getNodes } = useReactFlow();
  const { addToast } = useToast();
  const [checkingAll, setCheckingAll] = useState(false);

  const getConnectedCards = useCallback(() => {
    // Two ownership signals — accept either:
    //   - `data.hubId === hubId` tag (used by Job Search Module: jobcards live under a
    //     category/bucket tree, so their edges don't terminate at the hub).
    //   - Direct outgoing edge from the hub (used by SellHub: marketplacecards
    //     are spawned as direct children with a single hub→card edge).
    // Without the hubId branch, Job Search Module's "Check All" walks zero cards because
    // hub→category→bucket→jobcard edges don't have source===hubId.
    const outgoing = getEdges().filter(e => e.source === hubId);
    const edgeIds = new Set(outgoing.map(e => e.target));
    return getNodes().filter(n =>
      n.type === cardType &&
      (n.data?.hubId === hubId || edgeIds.has(n.id))
    );
  }, [hubId, cardType, getEdges, getNodes]);

  const checkAll = useCallback(async () => {
    if (checkingAll) return;
    const cards = getConnectedCards();
    if (cards.length === 0) return;

    setCheckingAll(true);
    let checked = 0;
    try {
      for (const card of cards) {
        const url        = String(getUrl(card.data) || '').trim();
        const platformId = getPlatformId(card.data);
        const watchUrls  = getWatchUrls(card.data);
        const productTitle = getProductTitle(card.data);
        // Per-platform watch URLs live server-side; the backend merges them in,
        // so a card with no listing URL but with a configured platform watch
        // URL still gets a meaningful check. Only flag "no URL" when the card
        // has nothing AND no per-card watch URLs.
        if (!url && watchUrls.length === 0) {
          updateNode(card.id, {
            [fields.status]:      'error',
            [fields.message]:     'No URL to check (paste a listing URL or configure a platform watch URL in Settings)',
            [fields.lastChecked]: new Date().toISOString(),
          });
          continue;
        }
        try {
          const res = await window.electronAPI?.checkListingStatus?.({
            url,
            platformId,
            nodeId: card.id,
            watchUrls,
            productTitle,
          });
          updateNode(card.id, statusCheckWrites(res, fields));
          checked++;
        } catch (err) {
          EventLogger.error('[useCheckAllConnected] failed for', card.id, err);
          updateNode(card.id, statusErrorWrites(err, fields));
        }
      }
      addToast({
        title: 'Status check complete',
        description: `Checked ${checked}/${cards.length} ${itemLabel}${cards.length === 1 ? '' : 's'}`,
        type: 'success',
      });
    } finally {
      setCheckingAll(false);
    }
  // getConnectedCards reads getEdges/getNodes which are stable refs from
  // useReactFlow — intentionally omitted to keep this callback stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingAll, fields, getUrl, getPlatformId, getWatchUrls, getProductTitle, updateNode, addToast, itemLabel]);

  return { checkingAll, checkAll, getConnectedCards };
}
