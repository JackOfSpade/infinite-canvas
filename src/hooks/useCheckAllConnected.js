import { useCallback, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';

const DEFAULT_FIELDS = { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked' };

/**
 * Walks every node of `cardType` connected outbound from `hubId` and runs
 * `check-listing-status` against each in sequence. Backs both the SellHub
 * "Check All" and the JobHub "Check All Statuses" buttons.
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
  fields = DEFAULT_FIELDS,
  updateNode,
  itemLabel = 'item',
}) {
  const { getEdges, getNodes } = useReactFlow();
  const { addToast } = useToast();
  const [checkingAll, setCheckingAll] = useState(false);

  const getConnectedCards = useCallback(() => {
    const outgoing = getEdges().filter(e => e.source === hubId);
    const ids = new Set(outgoing.map(e => e.target));
    return getNodes().filter(n => ids.has(n.id) && n.type === cardType);
  }, [hubId, cardType, getEdges, getNodes]);

  const checkAll = useCallback(async () => {
    if (checkingAll) return;
    const cards = getConnectedCards();
    if (cards.length === 0) return;

    setCheckingAll(true);
    let checked = 0;
    try {
      for (const card of cards) {
        const url = String(getUrl(card.data) || '').trim();
        if (!url) {
          updateNode(card.id, {
            [fields.status]:      'error',
            [fields.message]:     'No URL to check',
            [fields.lastChecked]: new Date().toISOString(),
          });
          continue;
        }
        try {
          const res = await window.electronAPI?.checkListingStatus?.({
            url,
            platformId: getPlatformId(card.data),
            nodeId: card.id,
          });
          const writes = { [fields.lastChecked]: new Date().toISOString() };
          if (res?.success) {
            writes[fields.status]  = res.status || 'unknown';
            writes[fields.message] = res.message || '';
          } else {
            writes[fields.status]  = 'error';
            writes[fields.message] = res?.error || 'Status check failed';
          }
          updateNode(card.id, writes);
          checked++;
        } catch (err) {
          EventLogger.error('[useCheckAllConnected] failed for', card.id, err);
          updateNode(card.id, {
            [fields.status]:      'error',
            [fields.message]:     err?.message || String(err),
            [fields.lastChecked]: new Date().toISOString(),
          });
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
  }, [checkingAll, fields, getUrl, getPlatformId, updateNode, addToast, itemLabel]);

  return { checkingAll, checkAll, getConnectedCards };
}
