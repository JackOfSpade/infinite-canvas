import { useEffect, useRef, useState } from 'react';
import {
  createWorkspaceStartupRecoveryCoordinator,
  terminalMarketplaceReplayDisposition,
  workspaceStartupRecoverySignature,
} from '../utils/workspaceStartupRecovery';
import { EventLogger } from '../utils/EventLogger';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { mergeMarketplaceStatusResults } from '../utils/marketplaceStatusProgress';
import {
  isAutomaticMarketplaceResolveIntent,
  marketplaceResearchIdentityMatches,
  marketplaceResearchInputMatches,
  marketplaceStatusInputMatches,
  markMarketplaceTerminalApplied,
  newMarketplaceRecovery,
} from '../utils/marketplaceRunRecovery';
import { normalizeMarketplaceWatchUrls } from '../utils/marketplaceWatchUrls';
import { buildRefreshResearchItems } from '../utils/bundlePricing';
import { normalizeCompWarnings } from '../utils/compSourceScope';
import { ACTIVE_COMP_SOURCES } from '../utils/constants';

/**
 * Workspace-level startup recovery for nodes that are hidden in nested
 * canvases and therefore never mount their own recovery effects. It only
 * invokes sidecars with an exact durable canvas/node/run/input capability.
 * Exact headless source-rescrapes may continue once; browser-native reads,
 * CAPTCHA/login paths and manual AI handoffs stay paused for an explicitly
 * mounted owner.
 */
export function useWorkspaceStartupRecovery({ canvasFilePath, rootNodes, hydrated, updateNodeDataGlobally }) {
  const [plan, setPlan] = useState([]);
  const rootNodesRef = useRef(rootNodes);
  useEffect(() => {
    rootNodesRef.current = rootNodes;
  }, [rootNodes]);
  const recoverySignature = workspaceStartupRecoverySignature(rootNodes);
  const moduleRunQueue = useModuleRunQueue();
  const [coordinator] = useState(() => (
    createWorkspaceStartupRecoveryCoordinator({
      peekJobRun: (args) => window.electronAPI?.peekJobRun?.(args),
      listJobContinuations: (args) => window.electronAPI?.listJobContinuations?.(args),
      peekMarketplaceRecovery: (args) => window.electronAPI?.peekMarketplaceRecovery?.(args),
    })
  ));

  useEffect(() => {
    let cancelled = false;
    if (!hydrated || !canvasFilePath) {
      void Promise.resolve().then(() => { if (!cancelled) setPlan([]); });
      return undefined;
    }
    void coordinator.discover({ canvasFilePath, rootNodes: rootNodesRef.current }).then(async (next) => {
      if (cancelled) return;
      // Marketplace Status inputs include Settings-owned watch URLs. Compare
      // them before issuing the exact resume request: the main handler can
      // create a fresh run for a mismatch, which is correct for an explicit
      // click but never for startup recovery.
      let watchUrlsByPlatform = {};
      try {
        const settings = await window.electronAPI?.getSettings?.();
        watchUrlsByPlatform = settings?.marketplaceWatchUrls || {};
      } catch {
        // An unavailable Settings read means the identity cannot be proven.
        // The status entry is kept paused below rather than guessing.
        watchUrlsByPlatform = null;
      }
      if (cancelled) return;
      const settled = await Promise.all(next.map(async (entry) => {
        if (entry.kind === 'sellhub' && entry.state === 'terminal-replay-ready') {
          if (typeof updateNodeDataGlobally !== 'function') return { ...entry, state: 'update-unavailable' };
          if (terminalMarketplaceReplayDisposition(entry) === 'acknowledge') {
            const acknowledged = await window.electronAPI?.acknowledgeMarketplaceRecovery?.({
              canvasFilePath, nodeId: entry.nodeId, kind: 'sellhub', runId: entry.runId, inputKey: entry.recovery?.inputKey,
              appliedProcessEpoch: entry.nodeData?.marketplaceRunResume?.terminalApplied?.appliedProcessEpoch,
              reason: 'terminal-state-observed-after-restart',
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            if (acknowledged?.success && acknowledged?.completed) {
              updateNodeDataGlobally(entry.nodeId, { marketplaceRunResume: null });
              return { ...entry, state: 'terminal-acknowledged' };
            }
            return { ...entry, state: 'terminal-ack-deferred', error: acknowledged?.error || acknowledged?.reason };
          }
          const terminal = entry.recovery?.result;
          if (entry.recovery?.phase === 'analysis-result' && terminal?.product) {
            const appliedRecovery = markMarketplaceTerminalApplied(entry.recovery, entry.processEpoch);
            updateNodeDataGlobally(entry.nodeId, {
              hubState: 'draft', product: terminal.product, errorMessage: null, marketplaceRunResume: appliedRecovery,
            });
            return { ...entry, state: 'terminal-replayed' };
          }
          if (entry.recovery?.phase === 'priced-result' && terminal && typeof terminal === 'object') {
            updateNodeDataGlobally(entry.nodeId, {
              ...terminal,
              marketplaceRunResume: markMarketplaceTerminalApplied(entry.recovery, entry.processEpoch),
            });
            return { ...entry, state: 'terminal-replayed' };
          }
          return { ...entry, state: 'terminal-invalid' };
        }

        if (entry.kind === 'marketplacestatus' && entry.state === 'terminal-replay-ready') {
          if (typeof updateNodeDataGlobally !== 'function') return { ...entry, state: 'update-unavailable' };
          if (terminalMarketplaceReplayDisposition(entry) === 'acknowledge') {
            const acknowledged = await window.electronAPI?.acknowledgeMarketplaceRecovery?.({
              canvasFilePath, nodeId: entry.nodeId, kind: 'marketplace-status', runId: entry.runId, inputKey: entry.recovery?.inputKey,
              appliedProcessEpoch: entry.nodeData?.marketplaceStatusRunResume?.terminalApplied?.appliedProcessEpoch,
              reason: 'terminal-state-observed-after-restart',
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            if (acknowledged?.success && acknowledged?.completed) {
              updateNodeDataGlobally(entry.nodeId, { marketplaceStatusRunResume: null });
              return { ...entry, state: 'terminal-acknowledged' };
            }
            return { ...entry, state: 'terminal-ack-deferred', error: acknowledged?.error || acknowledged?.reason };
          }
          updateNodeDataGlobally(entry.nodeId, (node) => ({
            marketplaceStatusRunResume: markMarketplaceTerminalApplied(entry.recovery, entry.processEpoch),
            platformStatus: mergeMarketplaceStatusResults(
              node?.data?.platformStatus,
              entry.recovery?.completedResults || {},
            ),
          }));
          return { ...entry, state: 'terminal-replayed' };
        }

        if (entry.kind === 'sellhub' && entry.state === 'source-rescrape-ready') {
          if (typeof updateNodeDataGlobally !== 'function') return { ...entry, state: 'update-unavailable' };
          const data = entry.nodeData || {};
          const researchItems = buildRefreshResearchItems(data.product, data.extraItems, data.itemPricings, data.pricingNotes);
          if (
            !data.product
            || !isAutomaticMarketplaceResolveIntent(entry.recovery)
            || !marketplaceResearchIdentityMatches(
              entry.recovery,
              researchItems,
              data.product.category,
              entry.recovery.input?.sourcePlan,
            )
          ) {
            return { ...entry, state: 'input-changed-paused' };
          }
          const resolveInput = entry.recovery.resolveIntent.input;
          let lease = null;
          try {
            lease = await moduleRunQueue.acquireModuleRun({
              nodeId: entry.nodeId,
              kind: 'marketplace',
              label: `Resume ${resolveInput.sourceId} marketplace source`,
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            const result = await window.electronAPI?.rescrapeSource?.({
              sourceId: resolveInput.sourceId,
              query: resolveInput.query,
              items: resolveInput.items,
              noChallengeConfirmed: resolveInput.noChallengeConfirmed === true,
              nodeId: entry.nodeId,
              canvasFilePath,
              manualAiRunId: entry.runId,
              recovery: entry.recovery,
              autoResume: true,
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            if (!result || result.success === false) {
              return { ...entry, state: 'provider-deferred', error: result?.error || 'The saved source rescrape did not settle.' };
            }
            const refreshed = await window.electronAPI?.peekMarketplaceRecovery?.({
              canvasFilePath,
              nodeId: entry.nodeId,
              kind: 'sellhub',
            });
            const refreshedRecovery = refreshed?.found === true
              && refreshed.runId === entry.runId
              && refreshed.inputKey === entry.recovery.inputKey
              && refreshed.recovery?.resolveIntent?.inputKey === entry.recovery.resolveIntent.inputKey
              && refreshed.recovery?.resolveIntent?.status === 'result'
              ? refreshed.recovery
              : null;
            if (!refreshedRecovery) {
              return { ...entry, state: 'checkpoint-deferred', error: 'The source result was not durably checkpointed.' };
            }
            updateNodeDataGlobally(entry.nodeId, {
              hubState: 'comps-ready',
              pendingItems: refreshedRecovery.pendingItems,
              scrapeWarnings: refreshedRecovery.scrapeWarnings,
              marketplaceRunResume: refreshedRecovery,
            });
            return { ...entry, state: 'source-rescrape-settled' };
          } catch (error) {
            return { ...entry, state: 'provider-deferred', error: error?.message || String(error) };
          } finally {
            lease?.release();
          }
        }

        if (entry.kind === 'sellhub' && entry.state === 'ready') {
          if (typeof updateNodeDataGlobally !== 'function') return { ...entry, state: 'update-unavailable' };
          const data = entry.nodeData || {};
          const researchItems = buildRefreshResearchItems(data.product, data.extraItems, data.itemPricings, data.pricingNotes);
          if (!data.product || !marketplaceResearchInputMatches(entry.recovery, researchItems, data.product.category)) {
            return { ...entry, state: 'input-changed-paused' };
          }
          let lease = null;
          try {
            // Match normal SellHub work on the global marketplace lane. The
            // IPC handler owns the cross-window exact claim and checkpoints
            // every source before this coordinator turns the result into a
            // deliberate comps-ready or synthesis pause.
            lease = await moduleRunQueue.acquireModuleRun({
              nodeId: entry.nodeId,
              kind: 'marketplace',
              label: 'Resume marketplace price research',
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            const result = await window.electronAPI?.scrapePriceComps?.({
              items: researchItems,
              nodeId: entry.nodeId,
              category: data.product.category,
              canvasFilePath,
              manualAiRunId: entry.runId,
              recovery: entry.recovery,
              autoResume: true,
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            if (!result || result.success === false) {
              return { ...entry, state: 'provider-deferred', error: result?.error || 'The saved marketplace scrape did not settle.' };
            }
            if (result.preflightBlocked) {
              const missing = Array.isArray(result.missingLogins) ? result.missingLogins : [];
              updateNodeDataGlobally(entry.nodeId, {
                hubState: 'draft',
                errorMessage: `Price check needs login on: ${missing.join(', ')}. Log in (Settings → Accounts) and re-run.`,
                pendingItems: null,
                scrapeWarnings: [],
                marketplaceRunResume: result.recovery || entry.recovery,
              });
              return { ...entry, state: 'login-paused' };
            }
            const pendingItems = researchItems.map((item, index) => ({
              key: item.key,
              label: item.label,
              query: item.query,
              condition: item.condition,
              pricingNotes: item.pricingNotes,
              productSpec: item.productSpec,
              comps: result.items?.[index]?.comps || { sold: [], active: [] },
            }));
            const warnings = normalizeCompWarnings(
              Array.isArray(result.scrapeWarnings) ? result.scrapeWarnings : [],
              ACTIVE_COMP_SOURCES.map(source => source.id),
            );
            const nextRecovery = warnings.length > 0
              ? { ...entry.recovery, phase: 'comps-ready', pendingItems, scrapeWarnings: warnings, updatedAt: Date.now() }
              : newMarketplaceRecovery({
                runId: entry.runId,
                phase: 'synthesis',
                input: null,
                inputKey: '',
                pendingItems,
                skippedWarnings: [],
              });
            const checkpoint = await window.electronAPI?.checkpointMarketplaceRecovery?.({
              canvasFilePath,
              nodeId: entry.nodeId,
              kind: 'sellhub',
              expectedInputKey: entry.recovery.inputKey,
              recovery: nextRecovery,
            });
            if (!checkpoint?.success || !checkpoint?.saved) {
              return { ...entry, state: 'checkpoint-deferred', error: checkpoint?.error || checkpoint?.reason || 'Could not save the recovered scrape outcome.' };
            }
            if (cancelled) return { ...entry, state: 'cancelled' };
            if (warnings.length > 0) {
              updateNodeDataGlobally(entry.nodeId, {
                hubState: 'comps-ready',
                pendingItems,
                scrapeWarnings: warnings,
                errorMessage: null,
                marketplaceRunResume: nextRecovery,
              });
              return { ...entry, state: 'comps-ready-paused' };
            }
            // Synthesis is a manual-AI decision. Checkpoint its exact input so
            // it can be continued on an explicit mounted action, but never
            // invoke it from a hidden canvas recovery pass.
            updateNodeDataGlobally(entry.nodeId, {
              hubState: 'draft', pendingItems, errorMessage: null, marketplaceRunResume: nextRecovery,
            });
            return { ...entry, state: 'synthesis-paused' };
          } catch (error) {
            return { ...entry, state: 'provider-deferred', error: error?.message || String(error) };
          } finally {
            lease?.release();
          }
        }

        if (entry.kind === 'marketplacestatus' && entry.state === 'ready') {
          if (typeof updateNodeDataGlobally !== 'function' || !watchUrlsByPlatform) {
            return { ...entry, state: 'settings-unavailable' };
          }
          const recoveryIds = entry.recovery?.input?.platformIds || [];
          const watchSnapshot = Object.fromEntries(recoveryIds.map((platformId) => [
            platformId,
            normalizeMarketplaceWatchUrls(watchUrlsByPlatform[platformId]),
          ]));
          if (!marketplaceStatusInputMatches(entry.recovery, recoveryIds, watchSnapshot)) {
            return { ...entry, state: 'input-changed-paused' };
          }
          let lease = null;
          try {
            // Regular Marketplace Status calls have a pass 2 manual-AI
            // handoff after their fetch pass. `autoResume` is the explicit
            // main-process prepare-only seam: it skips native reads and that
            // handoff, leaving durable prepared pages for a mounted action.
            lease = await moduleRunQueue.acquireModuleRun({
              nodeId: entry.nodeId,
              kind: 'marketplace',
              lane: 'marketplace-status',
              label: 'Resume marketplace status fetch',
            });
            // Do not generically abort a precise old-workspace request. Main
            // holds the cross-window exact claim and the sidecar checkpoint;
            // allowing an admitted request to settle preserves that receipt.
            if (cancelled) return { ...entry, state: 'cancelled' };
            const result = await window.electronAPI?.checkMarketplaceStatus?.({
              platformIds: entry.recovery.remainingPlatformIds,
              nodeId: entry.nodeId,
              runId: entry.runId,
              manualAiRunId: entry.runId,
              canvasFilePath,
              recovery: entry.recovery,
              autoResume: true,
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            if (!result || result.success === false) {
              return { ...entry, state: 'provider-deferred', error: result?.error || 'The saved status fetch did not settle.' };
            }
            if (result.recovery) {
              updateNodeDataGlobally(entry.nodeId, (node) => ({
                marketplaceStatusRunResume: result.recovery,
                platformStatus: mergeMarketplaceStatusResults(
                  node?.data?.platformStatus,
                  result.recovery.completedResults || result.results || {},
                ),
              }));
            }
            return {
              ...entry,
              state: 'provider-settled',
              pausedNativeIds: Array.isArray(result.pausedNativeIds) ? result.pausedNativeIds : [],
            };
          } catch (error) {
            return { ...entry, state: 'provider-deferred', error: error?.message || String(error) };
          } finally {
            lease?.release();
          }
        }

        if (entry.kind === 'jobboard-child-bootstrap' && entry.state === 'ready') {
          let lease = null;
          let boardClaim = null;
          try {
            boardClaim = await window.electronAPI?.claimJobBoardRun?.({
              canvasFilePath,
              nodeId: entry.boardOwner.orchestratorNodeId,
              boardRunId: entry.boardOwner.boardRunId,
              operation: 'hidden-provider',
              autoResume: true,
              waitForRelease: false,
            });
            if (boardClaim?.success !== true || boardClaim?.ok !== true || !boardClaim?.claimToken) {
              return { ...entry, state: 'board-owner-deferred', error: boardClaim?.error || boardClaim?.reason };
            }
            lease = await moduleRunQueue.acquireModuleRun({
              nodeId: entry.childNodeId,
              kind: 'jobsearch',
              lane: 'job-search',
              label: 'Resume saved Job Board child',
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            const result = await window.electronAPI?.searchJobs?.({
              ...entry.request,
              boardRecoveryClaim: {
                nodeId: entry.boardOwner.orchestratorNodeId,
                boardRunId: entry.boardOwner.boardRunId,
                claimToken: boardClaim.claimToken,
                operation: 'hidden-provider',
              },
            });
            if (result?.success === true && result?.providerPhaseOnly === true) {
              return { ...entry, state: 'provider-staged', jobRunId: result.runId || null };
            }
            return {
              ...entry,
              state: 'provider-deferred',
              error: result?.error || 'The prepared Board child did not establish a durable provider checkpoint.',
            };
          } catch (error) {
            return { ...entry, state: 'provider-deferred', error: error?.message || String(error) };
          } finally {
            lease?.release();
            if (boardClaim?.claimToken) {
              try {
                await window.electronAPI?.releaseJobBoardRun?.({
                  canvasFilePath,
                  nodeId: entry.boardOwner.orchestratorNodeId,
                  boardRunId: entry.boardOwner.boardRunId,
                  claimToken: boardClaim.claimToken,
                });
              } catch { /* sender teardown releases the exact Board lease */ }
            }
          }
        }

        if (entry.kind === 'jobcontinuation' && entry.state === 'terminal-ack-ready') {
          const completed = await window.electronAPI?.completeJobContinuation?.({
            canvasFilePath,
            nodeId: entry.nodeId,
            parentRunId: entry.intent?.parentRunId,
            intentId: entry.intent?.intentId,
            expectedResultKey: entry.receipt?.resultKey,
            appliedProcessEpoch: entry.receipt?.appliedProcessEpoch,
          });
          return completed?.success === true && completed?.ok === true && completed?.removed === true
            ? { ...entry, state: 'terminal-acknowledged' }
            : { ...entry, state: 'terminal-ack-deferred', error: completed?.error || completed?.reason };
        }

        if (entry.kind === 'jobcontinuation' && entry.state === 'ready') {
          let lease = null;
          let continuationClaim = null;
          let boardClaim = null;
          try {
            if (entry.boardOwner) {
              boardClaim = await window.electronAPI?.claimJobBoardRun?.({
                canvasFilePath,
                nodeId: entry.boardOwner.orchestratorNodeId,
                boardRunId: entry.boardOwner.boardRunId,
                operation: 'hidden-provider',
                autoResume: true,
                waitForRelease: false,
              });
              if (boardClaim?.success !== true || boardClaim?.ok !== true || !boardClaim?.claimToken) {
                return { ...entry, state: 'board-owner-deferred', error: boardClaim?.error || boardClaim?.reason };
              }
            }
            lease = await moduleRunQueue.acquireModuleRun({
              nodeId: entry.nodeId,
              kind: 'jobsearch',
              lane: 'job-search',
              label: entry.intent?.kind === 'late-source-refresh'
                ? 'Resume saved USAJobs refresh'
                : 'Resume saved description recovery',
            });
            if (cancelled) return { ...entry, state: 'cancelled' };
            continuationClaim = await window.electronAPI?.claimJobContinuation?.({
              ...entry.identity,
              intentId: entry.intent?.intentId,
              autoResume: true,
              automaticOperation: 'execute',
            });
            if (
              continuationClaim?.success !== true
              || continuationClaim?.ok !== true
              || !continuationClaim?.leaseToken
            ) {
              return {
                ...entry,
                state: 'continuation-deferred',
                error: continuationClaim?.error || continuationClaim?.reason || 'The exact continuation is already owned.',
              };
            }
            const request = {
              ...entry.request,
              continuationIntentId: entry.intent.intentId,
              continuationLeaseToken: continuationClaim.leaseToken,
            };
            const result = entry.intent.operation === 'search-jobs-single-source'
              ? await window.electronAPI?.searchJobsSingleSource?.(request)
              : await window.electronAPI?.resumeJobSource?.(request);
            if (cancelled) return { ...entry, state: 'cancelled' };
            if (!result || result.success === false) {
              return { ...entry, state: 'provider-deferred', error: result?.error || 'The saved provider continuation did not settle.' };
            }
            if (result?.continuationCheckpoint?.saved === true) {
              return {
                ...entry,
                state: 'terminal-replay-ready',
                resultKey: result.continuationCheckpoint.resultKey,
              };
            }
            return { ...entry, state: 'provider-deferred', error: 'The provider result was not terminal; its continuation remains saved.' };
          } catch (error) {
            return { ...entry, state: 'provider-deferred', error: error?.message || String(error) };
          } finally {
            if (continuationClaim?.leaseToken) {
              try {
                await window.electronAPI?.releaseJobContinuation?.({
                  intentId: entry.intent.intentId,
                  leaseToken: continuationClaim.leaseToken,
                });
              } catch { /* sender teardown releases the lease */ }
            }
            lease?.release();
            if (boardClaim?.claimToken) {
              try {
                await window.electronAPI?.releaseJobBoardRun?.({
                  canvasFilePath,
                  nodeId: entry.boardOwner.orchestratorNodeId,
                  boardRunId: entry.boardOwner.boardRunId,
                  claimToken: boardClaim.claimToken,
                });
              } catch { /* sender teardown releases the Board lease */ }
            }
          }
        }

        if (entry.kind !== 'jobhub' || entry.state !== 'ready') return entry;
        // The shared lane is the duplicate-claim fence between workspace
        // startup and a subsequently mounted node. The request itself is
        // exact-token guarded again in main; it advances only the safe provider
        // phase and leaves renderer scoring/manual-AI for the mounted card.
        let lease = null;
        let boardClaim = null;
        // A nested card can mount after this coordinator has discovered it but
        // before its provider-only request settles. Publish the queue lifecycle
        // to that card: otherwise its own mount effect sees an idle hub and
        // queues an identical resume behind this exact request. The duplicate
        // then keeps the controls locked with a misleading "queued" banner for
        // the entire (potentially long) browser pass.
        const priorHubState = ['done', 'sources-ready'].includes(entry.nodeData?.hubState)
          ? entry.nodeData.hubState
          : 'empty';
        const publishQueued = (position) => {
          updateNodeDataGlobally?.(entry.nodeId, (node) => (
            node?.data?.locked
              ? null
              : { queuedModuleRun: { label: 'Resuming job search', position } }
          ));
        };
        const publishRunning = () => {
          updateNodeDataGlobally?.(entry.nodeId, (node) => (
            node?.data?.locked
              ? null
              : { hubState: 'searching', queuedModuleRun: null }
          ));
        };
        const publishSettled = ({ providerSettled }) => {
          updateNodeDataGlobally?.(entry.nodeId, (node) => {
            // Do not overwrite a later mounted-card action. This coordinator
            // owns only the state it published above, and its exact main-side
            // capability already protects the sidecar itself.
            if (node?.data?.hubState !== 'searching' || node?.data?.queuedModuleRun) return null;
            return {
              hubState: priorHubState,
              queuedModuleRun: null,
              ...(providerSettled ? { providerPhaseAwaitingResume: true } : {}),
            };
          });
        };
        try {
          if (entry.boardOwner) {
            boardClaim = await window.electronAPI?.claimJobBoardRun?.({
              canvasFilePath,
              nodeId: entry.boardOwner.orchestratorNodeId,
              boardRunId: entry.boardOwner.boardRunId,
              operation: 'hidden-provider',
              autoResume: true,
              waitForRelease: false,
            });
            if (boardClaim?.success !== true || boardClaim?.ok !== true || !boardClaim?.claimToken) {
              return {
                ...entry,
                state: 'board-owner-deferred',
                error: boardClaim?.error || boardClaim?.reason || 'The Board recovery is already owned.',
              };
            }
          }
          lease = await moduleRunQueue.acquireModuleRun({
            nodeId: entry.nodeId,
            kind: 'jobsearch',
            lane: 'job-search',
            label: 'Resume saved job search',
            onQueued: ({ position }) => publishQueued(position),
            onQueueUpdate: ({ position }) => publishQueued(position),
            onStart: publishRunning,
          });
          // Do not abort an already-admitted main-process request when the
          // workspace changes. Its request carries the old exact canvas/run
          // capability; allowing it to settle keeps that old sidecar coherent
          // and avoids any generic/destructive cancellation across workspaces.
          if (cancelled) return { ...entry, state: 'cancelled' };
          const result = await window.electronAPI?.searchJobs?.(entry.request);
          if (result?.success === true) {
            publishSettled({ providerSettled: true });
            return { ...entry, state: 'provider-settled' };
          }
          publishSettled({ providerSettled: false });
          return { ...entry, state: 'provider-deferred', error: result?.error || 'The saved provider phase did not settle.' };
        } catch (error) {
          publishSettled({ providerSettled: false });
          return { ...entry, state: 'provider-deferred', error: error?.message || String(error) };
        } finally {
          lease?.release();
          if (boardClaim?.claimToken) {
            try {
              await window.electronAPI?.releaseJobBoardRun?.({
                canvasFilePath,
                nodeId: entry.boardOwner.orchestratorNodeId,
                boardRunId: entry.boardOwner.boardRunId,
                claimToken: boardClaim.claimToken,
              });
            } catch { /* renderer teardown releases the sender-owned lease */ }
          }
        }
      }));
      if (cancelled) return;
      setPlan(settled);
      for (const entry of settled) {
        EventLogger.log(`[StartupRecovery] nested ${entry.kind} id=${entry.nodeId} state=${entry.state}`);
      }
    });
    return () => { cancelled = true; };
  }, [canvasFilePath, coordinator, hydrated, moduleRunQueue, recoverySignature, updateNodeDataGlobally]);

  return plan;
}
