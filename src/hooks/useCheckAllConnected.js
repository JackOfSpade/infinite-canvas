import { useCallback, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { cachedAuthNeedsLoginResult, statusCheckWrites, statusErrorWrites } from '../utils/listingStatusWrites';

const DEFAULT_FIELDS = { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked', trace: 'lastCheckTrace' };
const VERIFY_WAIT_TIMEOUT_MS = 45000;

async function waitForPlatformStartupVerify(platformId, api, timeoutMs = VERIFY_WAIT_TIMEOUT_MS) {
  if (!platformId || !api?.getVerifyState) return 'not-verifying';
  const state = await api.getVerifyState().catch(() => null);
  const verifying = Array.isArray(state?.verifying) ? state.verifying : [];
  if (!verifying.includes(platformId)) return 'not-verifying';

  EventLogger.log(`status check ${platformId} waiting for startup login verification`);

  return await new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    let unsubscribeUpdate = null;
    let unsubscribeDone = null;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribeUpdate?.();
      unsubscribeDone?.();
      resolve(reason);
    };

    unsubscribeUpdate = api.onSessionVerifyUpdate?.(({ platformId: updatedPlatformId } = {}) => {
      if (updatedPlatformId === platformId) finish('updated');
    });
    unsubscribeDone = api.onSessionVerifyDone?.(() => finish('done'));
    timeoutId = setTimeout(() => finish('timeout'), timeoutMs);
    api.getVerifyState?.().then((latest = {}) => {
      const latestVerifying = Array.isArray(latest.verifying) ? latest.verifying : [];
      if (!latestVerifying.includes(platformId)) finish('updated');
    }).catch(() => {});
  });
}

async function cachedNeedsLoginResultForPlatform(platformId, api) {
  if (!platformId || !api?.checkSellMonitorAuth) return null;

  const waitResult = await waitForPlatformStartupVerify(platformId, api);
  if (waitResult === 'timeout') {
    EventLogger.log(`status check ${platformId} startup login verification wait timed out; continuing with cached auth`);
  }

  const auth = await api.checkSellMonitorAuth({ platformId }).catch(() => null);
  if (!auth || auth.connected || !auth.lastConfirmedAt) return null;
  return cachedAuthNeedsLoginResult({
    platformId,
    name: auth.name,
    reason: auth.lastReason,
  });
}

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
    EventLogger.log(`status check-all start: hub=${hubId} ${cards.length} ${itemLabel}(s)`);
    let checked = 0;
    let needsLogin = 0;
    let failed = 0;
    let skipped = 0;
    const loginPlatforms = new Set();
    try {
      for (const card of cards) {
        const url        = String(getUrl(card.data) || '').trim();
        const platformId = getPlatformId(card.data);
        const watchUrls  = getWatchUrls(card.data);
        const productTitle = getProductTitle(card.data);
        // Watch URLs are supplemental context; the listing URL anchors the
        // check to the specific item this card represents.
        if (!url) {
          updateNode(card.id, {
            [fields.status]:      'error',
            [fields.message]:     'No listing URL to check (paste the marketplace listing URL first)',
            [fields.lastChecked]: new Date().toISOString(),
            ...(fields.attention ? { [fields.attention]: [] } : {}),
          });
          skipped++;
          continue;
        }
        try {
          const authGate = await cachedNeedsLoginResultForPlatform(platformId, globalThis.window?.electronAPI);
          if (authGate) {
            updateNode(card.id, statusCheckWrites(authGate, fields));
            EventLogger.log(`status check ${platformId || '?'} ${String(card.id).slice(-12)} → needs-login (cached auth)`);
            needsLogin++;
            if (platformId) loginPlatforms.add(platformId);
            continue;
          }

          const res = await window.electronAPI?.checkListingStatus?.({
            url,
            platformId,
            nodeId: card.id,
            watchUrls,
            productTitle,
          });
          updateNode(card.id, statusCheckWrites(res, fields));
          EventLogger.log(`status check ${platformId || '?'} ${String(card.id).slice(-12)} → ${res?.status || 'error'}`);
          if (res?.status === 'needs-login') {
            needsLogin++;
            if (platformId) loginPlatforms.add(platformId);
          } else if (!res?.status || res?.status === 'error') {
            failed++;
          } else {
            checked++;
          }
        } catch (err) {
          EventLogger.error('[useCheckAllConnected] failed for', card.id, err);
          updateNode(card.id, statusErrorWrites(err, fields));
          failed++;
        }
      }
      EventLogger.log(`status check-all done: checked=${checked} needsLogin=${needsLogin} failed=${failed} skipped=${skipped} of ${cards.length}`);
      if (needsLogin > 0) {
        const platforms = [...loginPlatforms].join(', ');
        addToast({
          title: 'Marketplace login needed',
          description: `${needsLogin}/${cards.length} ${itemLabel}${cards.length === 1 ? '' : 's'} need refreshed login${platforms ? `: ${platforms}` : ''}. Open Settings > Accounts, log in, then run Check All again.`,
          type: 'error',
          duration: 8000,
        });
      } else if (failed > 0 || skipped > 0) {
        addToast({
          title: 'Status check finished with issues',
          description: `Checked ${checked}/${cards.length}; ${failed} failed${skipped ? `, ${skipped} missing URL` : ''}.`,
          type: 'error',
          duration: 7000,
        });
      } else {
        addToast({
          title: 'Status check complete',
          description: `Checked ${checked}/${cards.length} ${itemLabel}${cards.length === 1 ? '' : 's'}`,
          type: 'success',
        });
      }
    } finally {
      setCheckingAll(false);
    }
  // getConnectedCards reads getEdges/getNodes which are stable refs from
  // useReactFlow — intentionally omitted to keep this callback stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingAll, fields, getUrl, getPlatformId, getWatchUrls, getProductTitle, updateNode, addToast, itemLabel]);

  return { checkingAll, checkAll, getConnectedCards };
}
