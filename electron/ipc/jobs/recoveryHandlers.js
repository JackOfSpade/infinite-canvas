import { ACTIVE_SOURCE_IDS, acceptProviderSearchResults, buildResolvedDescriptionWarning, consumeRecoveryBlockedUrl, filterJobsByDescriptionEvidence, getJobSourceResolveConfig, hasResolvedJobDescription, linkedInBrowserUnavailableWarning, mergeDescriptionRecoverySourceJobs, mergeResolvedDescriptionRecoveryCandidate, nextDescriptionRecoveryGuidance, overlayResolvedRecoveryRows, partitionResolvedDescriptionRecoveryCandidates, reconcileResolvedDescriptionRecovery, recoveryBlockedUrlsForSource, resolveSourceLabel, retiredListingKeys, snapshotDescriptionRecoveryJobs, sourceHealthWarningForRows } from './sourceRules.js';
import { GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE, buildPhysicalCardWalkPlan, enrichResolvedJobDescriptions, googleApplyLinksRateLimitedWarning, normalizeGoogleApplyOptions, preloadResolvedJobList, selectGoogleApplyUrl } from '../browser/manualScraper.js';
import { JOB_SEARCH_TEST_MODE } from '../../../src/utils/jobSourceScope.js';
import { RECENT_INDEED_LOGIN_MS, clearLinkedInCeiling, indeedLoginStamp, jobsTelemetry, linkedInSameIpRetryDecision, linkedinCeiling, rememberLinkedInCeiling } from './state.js';
import { admitContinuationProviderWork, assessDescriptionRecoveryCheckpoint, checkpointContinuationBeforeReply, descriptionRecoveryNotReadyWarning, descriptionRecoveryPersistenceWarning, loadDescriptionRecoveryCheckpoint, loadJobAnalysisSnapshot, requireDescriptionRecoveryCheckpointPersisted, requireSavedJobRecoveryCanvas, saveDescriptionRecoverySnapshotIfCurrent, withDescriptionRecoveryLock } from './analysisStore.js';
import { boardClosedRetirement, scoreSafeRowsWithBoardClosed } from '../officialPostingBoardClosed.js';
import { canReadFromEmployerPostings, readListingsFromEmployerPostings } from './employerPostingRead.js';
import { buildJobAnalysisSnapshot } from './scoring.js';
import { canPerformJobSourceAction, canWriteJobResolveTelemetry, jobSourceActionAuthorization, nativeChallengeTerminalDisposition, nextResolvePassTrail, recordJobSourceProgress, recordJobSourceResolvePass, recordJobSourceResumeAttempt, recordLinkedinEnrichPass, recordLinkedinResolveAttempt, recordResolveMergeOutcome, recordResumeAttemptTelemetry, recordSourceResolvedAfterGather, summarizeIndeedResumeEnrichment, syncIndeedSessionStatusFromScrape } from './telemetry.js';
import { createOfficialPostingRecoveryPassResolver } from '../officialPostingService.js';
import { dedupAgainstHistory, loadJobsHistory } from '../jobsHistory.js';
import { effectiveJobSearchWindow, getEgressIp, runCooldownProbe } from './collection.js';
import { enrichLinkedInDescriptionsBrowser } from '../../extractors/apiExtractors.js';
import { fetchIndeedListingsBrowser } from '../../extractors/indeedBrowser.js';
import { filterAppliedListings } from '../../../src/utils/applicationBundleIdentity.js';
import { filterJobsByPostedSince } from '../jobDateFilter.js';
import { filterNonEnglishJobs } from '../../../src/utils/jobLanguage.js';
import { filterProvablyOutsideCountryScope } from '../../../src/utils/jobLocation.js';
import { getRunnableJobSourceIds } from '../../../src/utils/jobPlatformSelection.js';
import { listingStateRank } from '../officialPostingFields.js';
import { loadAppliedListingKeys } from '../localAiApplication.js';
import { logger } from '../../logger.js';
import { normalizeJobCollectionLimits } from '../../../src/utils/jobCollectionLimits.js';
import { normalizeJobsMarkup, repairJobsMojibake } from '../../../src/utils/textEncoding.js';
import { openCaptchaResolveWindow, openNativeIndeedChallengeWindow } from '../browser/authWindows.js';
import { readStatusCache, runPlatformLoginFlow } from '../accounts.js';
import { reconcileGlassdoorSalaryFromDescription } from '../../../src/utils/jobSalaryReconciliation.js';
import { sourceJobKey } from '../../../src/utils/jobIdentity.js';
import { withSharedProfileLock } from '../sharedProfileLock.js';

/**
 * Apply the results of a Google apply-link retry to already-saved rows.
 *
 * Pure: it takes the resolved `from → to` redirect pairs and returns ONLY the
 * rows whose employer link it fixed — `url` from the resolved Apply-on redirect,
 * `applyOptions` from the same candidates, and the parked
 * `pendingApplyRedirects` removed. Rows without parked redirects are never
 * returned, so the hub's `replaceMatchingItems` merge leaves them untouched, and
 * `remaining` counts the rows a second rate limit stopped the reader from fixing.
 */
export function applyGoogleApplyLinkRetryResults(rows, { resolvedHrefByHref, attemptedAll = false } = {}) {
  const resolvedMap = resolvedHrefByHref instanceof Map
    ? resolvedHrefByHref
    : new Map(Object.entries(resolvedHrefByHref || {}));
  const items = [];
  let remaining = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const pending = Array.isArray(row?.pendingApplyRedirects) ? row.pendingApplyRedirects : [];
    if (pending.length === 0) continue;
    // The resolver returns candidates in the same shape it was given: an
    // unfollowed redirect keeps its own /goto href, which no Apply-on selector
    // accepts, so only genuinely read links can produce a url here.
    const candidates = pending.map(entry => ({
      label: entry?.label,
      href: resolvedMap.get(entry?.href) || entry?.href,
    }));
    const url = selectGoogleApplyUrl(candidates, row?.applySource);
    const { pendingApplyRedirects: _readRedirects, ...rest } = row;
    if (!url) {
      // With no rate limit this pass, every parked redirect was followed: a row
      // that still has no acceptable link never will, so it leaves the queue
      // (keeping its Google URL) instead of holding the warning open forever.
      if (attemptedAll) {
        items.push({ ...rest, applyOptions: normalizeGoogleApplyOptions(candidates) });
        continue;
      }
      remaining += 1;
      continue;
    }
    items.push({ ...rest, url, applyOptions: normalizeGoogleApplyOptions(candidates) });
  }
  return { items, remaining };
}

export function registerRecoveryHandlers(ctx) {
  const { handleSafe, ipcMain, retryIndeedDescriptions, retryGoogleApplyLinks, settleScrapedRowsForScoring } = ctx;
  // ── Resolve a job-source block — opens the failed scrape URL in a visible,
  // cookie-sharing browser so the user can solve a captcha or log in. Same
  // underlying primitive marketplace uses for `resolve-captcha`. When the
  // user's session cleared the bot challenge, we run the source's extractor
  // in THAT same visible window so the items the user just unlocked land
  // straight in pendingJobs — without this, "solve captcha" produced 0 jobs
  // from that source because the original headless scrape had already
  // failed, and we'd have needed a full Re-run Search to retry it.
  //
  // Returns { resolved, items } so the renderer can merge items into
  // pendingJobs and drop the warning. items is [] when no extractor is
  // available for the source (API sources can't be inline-extracted; their
  // Solve button doesn't render).
  handleSafe('resolve-job-source', async (event, { url, sourceId, nodeId, jobRunId = null, canvasFilePath, searchWindow, maxAgeDays, preferredLocation, secondTabUrl, collectionLimits, enabledSourceIds, continuationIntentId = null, continuationLeaseToken = null, careerSnapshotId = null, operationAuthority = null, parentArtifactFingerprint = null, warningCode = null, employerPostingRead = false } = {}, signal) => {
    requireSavedJobRecoveryCanvas(canvasFilePath);
    const continuationAdmission = await admitContinuationProviderWork(event, {
      canvasFilePath, nodeId, jobRunId, continuationIntentId, continuationLeaseToken,
      careerSnapshotId, operationAuthority, parentArtifactFingerprint,
    }, 'resolve-job-source');
    if (!continuationAdmission.ok) return { resolved: false, operationSuperseded: true, items: [] };
    if (!url) throw new Error('resolve-job-source requires a url');
    const normalizedCollectionLimits = normalizeJobCollectionLimits(collectionLimits);
    const activeSearchWindow = effectiveJobSearchWindow(searchWindow, maxAgeDays);
    if (!getRunnableJobSourceIds(enabledSourceIds, ACTIVE_SOURCE_IDS, normalizedCollectionLimits).includes(sourceId)) {
      return { resolved: false, disabled: true, items: [] };
    }
    logger.info(`[Jobs][${nodeId}] User requested source resolve for ${sourceId}: ${url}${secondTabUrl ? ' (2-tab)' : ''}`);

    // Google and LinkedIn recovery target an already-collected universe rather
    // than whatever first slice happens to be mounted in the visible window.
    // Never let a source card without the active run token borrow a prior
    // canvas-global snapshot to construct that universe.
    const requiresStrictDescriptionRecoverySnapshot = sourceId === 'google' || sourceId === 'linkedin';
    if (requiresStrictDescriptionRecoverySnapshot && !jobRunId) {
      const warning = descriptionRecoveryNotReadyWarning(resolveSourceLabel(sourceId), 'missing-run-id');
      logger.info(`[Jobs][${nodeId}] ${sourceId} Solve deferred: ${warning.code} (missing jobRunId)`);
      return { resolved: false, items: [], warning, nextBlockedUrl: null };
    }
    const sourceActionAuthorization = await jobSourceActionAuthorization(canvasFilePath, nodeId, jobRunId);
    if (!sourceActionAuthorization.authorized) {
      if (
        requiresStrictDescriptionRecoverySnapshot
        && sourceActionAuthorization.reason === 'provider-boundary-awaiting-final-checkpoint'
      ) {
        // This can only happen after an abnormal renderer-side exit: a normal
        // click waits in the same FIFO lane and reaches here after `gathered`.
        // Keep the card actionable and honest instead of returning a silent
        // stale/no-op while its exact post-filter recovery snapshot is absent.
        const warning = descriptionRecoveryNotReadyWarning(
          resolveSourceLabel(sourceId),
          'live-run-checkpoint-not-ready',
        );
        logger.info(`[Jobs][${nodeId}] ${sourceId} Solve deferred: ${warning.code} (provider boundary awaiting final checkpoint)`);
        return { resolved: false, items: [], warning, nextBlockedUrl: null };
      }
      logger.info(`[Jobs][${nodeId}] ${sourceId} Solve ignored: its durable run is no longer current`);
      return { resolved: false, staleRun: true, items: [], nextBlockedUrl: null };
    }

    // LinkedIn "Solve" = re-fetch descriptions, NOT log in. Descriptions come
    // from ANONYMOUS guest pages (the cookieless JSON-LD; the logged-in SPA has
    // none — probe-confirmed), so the user's LinkedIn session is irrelevant to
    // enrichment and the wall is a LinkedIn guest-limit condition, not an expired
    // login. Its key may be IP, guest context, or fingerprint/session. We therefore
    // do NOT open a login window here — that was the
    // "opens then instantly closes" the user saw: they're already logged in, so
    // /login auto-redirects to /feed and the window self-closes with nothing to
    // do. Solve just re-runs anonymous enrichment, which (via context rotation)
    // fills another batch as LinkedIn's guest quota cools down.
    const isLinkedInReEnrich = sourceId === 'linkedin';
    if (isLinkedInReEnrich) {
      // A durable Solve from another canvas must not inherit or overwrite the
      // process-local cooldown diagnostics owned by the current canvas.
      const canWriteTelemetry = () => canWriteJobResolveTelemetry(nodeId, jobRunId);
      return withDescriptionRecoveryLock({ canvasFilePath, nodeId, jobRunId, signal }, () => withSharedProfileLock(async () => {
      // Pass-start ≈ when the user clicked Solve. Stamped on the enrichment trail
      // so the idle gap before this pass (the cooldown wait) excludes the pass's
      // own multi-minute duration on a clean finish.
      const passStartedAt = Date.now();
      // Resolve-attempt telemetry — the LinkedIn branch returns directly and
      // never reaches the generic resolves[] recorder below, so without this the
      // bug report's "Captcha-resolve / Solve" section is blank for LinkedIn.
      const recordResolve = (extra) => recordLinkedinResolveAttempt(
        sourceId, extra, { nodeId, jobRunId },
      );
      // A Resolve happens after the gather stage, so it must update the source
      // trail without changing the already-completed search pipeline back to
      // active. The renderer delivery remains best-effort, as before.
      const sendProgress = (payload) => {
        const correlatedPayload = jobRunId && !payload.jobRunId
          ? { ...payload, jobRunId }
          : payload;
        recordJobSourceProgress(correlatedPayload, { updatePipeline: false, expectedNodeId: nodeId });
        if (!event.sender?.isDestroyed?.()) event.sender?.send?.('job-source-progress', correlatedPayload);
      };

      let items = [];
      try {
        const { snapshot, origin } = await loadDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId);
        const ownership = await assessDescriptionRecoveryCheckpoint({ snapshot, origin, nodeId, jobRunId, canvasFilePath });
        if (!ownership.ok) {
          const warning = ownership.reason === 'current-snapshot-unavailable'
            || ownership.reason === 'missing-run-id'
            || ownership.reason === 'missing-ownership'
            || ownership.reason === 'live-run-checkpoint-not-ready'
            ? descriptionRecoveryNotReadyWarning('LinkedIn', ownership.reason)
            : {
                code: 'description-recovery-snapshot-stale', severity: 'block',
                evidence: `The current LinkedIn recovery snapshot belongs to a different ${ownership.reason === 'hub-mismatch' ? 'hub' : 'search run'}, so it was not merged into this search.`,
                suggestion: 'Run the search again, then retry Solve from its current source card.',
              };
          logger.info(`[Jobs][${nodeId}] LinkedIn Solve rejected recovery snapshot: ${ownership.reason}`);
          return {
            resolved: false,
            items: [],
            warning,
            nextBlockedUrl: null,
          };
        }
        let snapshotRecoveryJobs = snapshotDescriptionRecoveryJobs(snapshot);
        const allLinkedInRaw = snapshotRecoveryJobs.filter(j => j.source === 'linkedin');
        if (allLinkedInRaw.length === 0) {
          return {
            resolved: false,
            items: [],
            warning: {
              code: 'description-recovery-snapshot-unavailable', severity: 'block',
              evidence: 'The current LinkedIn recovery snapshot has no source rows, so the resolver did not clear this source.',
              suggestion: 'Run the search again, then retry Solve from its current source card.',
            },
            nextBlockedUrl: null,
          };
        }
        const allLinkedIn = normalizedCollectionLimits.jobsPerPlatform == null
          ? allLinkedInRaw
          : allLinkedInRaw.slice(0, normalizedCollectionLimits.jobsPerPlatform);
        const needEnrich = filterJobsByDescriptionEvidence(allLinkedIn).dropped;
        const admitForScoring = async rows => {
          const officialResolution = await settleScrapedRowsForScoring(
            scoreSafeRowsWithBoardClosed(filterJobsByDescriptionEvidence(overlayResolvedRecoveryRows(rows, snapshotRecoveryJobs))), { signal },
          );
          // This branch publishes directly, before the generic Solve filter.
          const languageFilter = filterNonEnglishJobs(officialResolution.jobs);
          if (languageFilter.dropped.length > 0) {
            logger.info(`[Jobs][${nodeId}] LinkedIn recovery languageDropped=${languageFilter.dropped.length} — descriptions not primarily English, not scored or marked seen`);
          }
          return languageFilter.jobs;
        };
        const persistRecoveryPool = async (updatedLinkedIn) => {
          const descriptionRecoveryJobs = mergeDescriptionRecoverySourceJobs(
            snapshotRecoveryJobs,
            'linkedin',
            updatedLinkedIn,
          );
          const scoringJobs = await admitForScoring(descriptionRecoveryJobs);
          const { snapshot: nextSnapshot } = buildJobAnalysisSnapshot({
            jobs: scoringJobs,
            descriptionRecoveryJobs,
            descriptionRecoveryState: snapshot.descriptionRecoveryState,
            profile: snapshot.profile,
            careerData: snapshot.careerData,
            careerSnapshotId: snapshot.careerSnapshotId,
            operationAuthority,
            nodeId: snapshot.nodeId || nodeId,
            // FIX 12 (immediate call site): thread the ORIGINAL snapshot's
            // preference plan through this description-recovery re-save.
            // Without it, `jobPreferencePlan` is undefined here, so the
            // rebuilt snapshot's role/resolvedRoleTitles would be blank,
            // discarding the real AI-determined title list on every LinkedIn
            // description-recovery pass over a Search-Brief run.
            jobPreferences: snapshot.jobPreferences || '',
            jobPreferencePlan: snapshot.jobPreferencePlan || null,
            snapshotContext: {
              sourceHubId: snapshot.sourceHubId || nodeId,
              runId: snapshot.runId || null,
              canvasFilePath,
              resumeSummary: snapshot.resumeSummary || '',
              locationSnapshot: snapshot.locationSnapshot || null,
              sourceGatheredCount: snapshot.sourceGatheredCount
                ?? snapshot.searchFunnel?.relevanceKept
                ?? snapshot.searchFunnel?.raw
                ?? snapshot.gatheredJobCount
                ?? scoringJobs.length,
            },
          });
          requireDescriptionRecoveryCheckpointPersisted(
            await saveDescriptionRecoverySnapshotIfCurrent(nextSnapshot, {
              nodeId, jobRunId, sender: event.sender,
              continuation: continuationAdmission.continuation ? {
                intentId: continuationIntentId, leaseToken: continuationLeaseToken,
                operation: 'resolve-job-source', parentArtifactFingerprint,
              } : null,
            }),
          );
          snapshotRecoveryJobs = snapshotDescriptionRecoveryJobs(nextSnapshot);
          return scoringJobs.filter(job => job?.source === 'linkedin');
        };

        if (needEnrich.length > 0) {
          logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch: ${needEnrich.length}/${allLinkedIn.length} job(s) still without descriptions`);

          // ── Automated cooldown probe (JOB_SEARCH_PROBE_COOLDOWN) ──────────
          // Diagnostic mode: idle escalating waits on the SAME IP/browser, probing
          // a small batch after each, STOP at the first interval confirmed clean by
          // 3 consecutive probes. The immediate-retry guard below is intentionally
          // bypassed: keeping the observed IP/browser identity stable is the whole
          // point. Also triggered automatically from
          // the initial search path — no Solve click required when enabled.
          if (JOB_SEARCH_TEST_MODE.probeCooldown) {
            const waitsMs = JOB_SEARCH_TEST_MODE.probeCooldownWaitsMin.map(m => Math.round(m * 60_000));
            const saveMidProbe = async (pool) => {
              await persistRecoveryPool(pool);
            };
            const { pool: merged, foundMs, attempt, probeTotalEnriched, aborted, browserUnavailable, profileReserved, browserError } =
              await runCooldownProbe(nodeId, waitsMs, allLinkedIn, signal, sendProgress, saveMidProbe, {
                ownership: { nodeId, jobRunId },
                canWriteTelemetry,
              });
            const scoringMerged = probeTotalEnriched > 0 ? await persistRecoveryPool(merged) : await admitForScoring(merged);
            if (aborted) return { resolved: true, items: scoringMerged, replaceSourceItems: true, nextBlockedUrl: null };
            const stillEmpty = filterJobsByDescriptionEvidence(merged).dropped.length;
            if (browserUnavailable) {
              const browserWarning = linkedInBrowserUnavailableWarning({ profileReserved, browserError });
              recordResolve({ needEnrich: needEnrich.length, enrichSuccess: probeTotalEnriched, walled: false, stillEmpty, cooldownProbe: true, browserUnavailable: true });
              sendProgress({ nodeId, sourceId: 'linkedin', count: merged.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: browserWarning });
              return { resolved: true, items: scoringMerged, warning: browserWarning, replaceSourceItems: true, nextBlockedUrl: null };
            }
            recordResolve({ needEnrich: needEnrich.length, enrichSuccess: probeTotalEnriched, walled: foundMs == null, stillEmpty, cooldownProbe: true, cooldownFoundMs: foundMs });
            if (foundMs != null) {
              if (canWriteTelemetry()) clearLinkedInCeiling();
              logger.info(`[Jobs][${nodeId}] Cooldown probe FOUND: guest wall clears after ~${Math.round(foundMs / 60000)}m idle on the same IP/browser.`);
              sendProgress({ nodeId, sourceId: 'linkedin', count: merged.length, status: 'done' });
              return { resolved: true, items: scoringMerged, replaceSourceItems: true, nextBlockedUrl: null };
            }
            const maxMin = Math.round(Math.max(...waitsMs) / 60000);
            const exhaustedWarning = {
              code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: `Cooldown > ${maxMin}m`,
              evidence: `Cooldown probe exhausted: still walled after idle waits up to ${maxMin}m (${attempt} attempt(s)). ${stillEmpty} still empty.`,
              suggestion: `The cooldown is longer than ${maxMin}m, or idle alone won't clear it. Extend JOB_SEARCH_PROBE_WAITS_MIN, Reset browser session, or try a residential IP.`,
            };
            sendProgress({ nodeId, sourceId: 'linkedin', count: merged.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: exhaustedWarning });
            return { resolved: true, items: scoringMerged, warning: exhaustedWarning, replaceSourceItems: true, nextBlockedUrl: null };
          }

          // Skip only an IMMEDIATE same-IP retry. A guest ceiling can cool while
          // the user is looking at the warning, so a later Solve on the same IP
          // is a legitimate, conservative retry rather than something to block
          // forever. (Null IP = lookup failed; degrade gracefully and proceed.)
          const currentIp = await getEgressIp();
          // A prior guest ceiling must not suppress a later attempt through a
          // verified profile session: it is a different representation and may
          // be unaffected by the anonymous quota. The extractor still falls
          // back safely if the session cannot render the description.
          const resolveSessionCache = await readStatusCache();
          const preferAuthenticated = resolveSessionCache.linkedin?.connected === true;
          const sameIp = canWriteTelemetry()
            ? linkedInSameIpRetryDecision(linkedinCeiling.ip, linkedinCeiling.at, currentIp)
            : { skip: false, retryAfterMs: 0 };
          if (sameIp.skip && !preferAuthenticated) {
            const waitSeconds = Math.ceil(sameIp.retryAfterMs / 1000);
            const switchWarning = {
              code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: 'Wait or switch VPN',
              evidence: `Still on IP ${currentIp}, which just hit LinkedIn's guest ceiling. Waiting ${waitSeconds}s avoids an immediate repeat on the same IP.`,
              suggestion: `Wait ${waitSeconds}s, then click Solve to retry this IP; or switch VPN to a new working location and Solve now.`,
            };
            recordResolve({ needEnrich: needEnrich.length, enrichSuccess: 0, walled: true, skippedSameIp: true, warmIp: currentIp });
            // walled: true — this observed-IP guard skipped an immediate retry;
            // it mirrors recordResolve above (was false, which
            // made the enrichment trail contradict itself for this event).
            recordLinkedinEnrichPass({ kind: 'solve', nodeId, jobRunId, ip: currentIp, ipOk: !!currentIp, walled: true, skippedSameIp: true, attempted: 0, remainingBefore: needEnrich.length, enriched: 0, startedAt: passStartedAt });
            logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch skipped — egress IP unchanged (${currentIp}); ${waitSeconds}s cooldown remains before same-IP retry`);
            sendProgress({ nodeId, sourceId: 'linkedin', count: allLinkedIn.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: switchWarning });
            return { resolved: true, items: await admitForScoring(allLinkedIn), warning: switchWarning, replaceSourceItems: true, nextBlockedUrl: null };
          }

          sendProgress({ nodeId, sourceId: 'linkedin', status: 'searching', count: needEnrich.length, detail: 're-fetching descriptions', warning: null,
            activity: 'description-enrichment', activityCompleted: 0, activityTotal: needEnrich.length });
          const { jobs: enriched, structuralDroppedKeys = [], loginWall: walled, cancelled = false, successCount = 0, attempted = needEnrich.length, contextRotations = 0, browserGen = null, browserAgeMs = null, noDesc = 0, noDescSoftBlock = 0, noDescGenuine = 0, evalErrors = 0, navErrors = 0, noInternet = false, browserUnavailable = false, profileReserved = false, browserError = null, usedAuthenticated = false, authenticatedFallback = false } = await enrichLinkedInDescriptionsBrowser(needEnrich, signal, {
            preferAuthenticated,
            // Same silence, same fix, on the Solve recovery walk.
            onProgress: ({ completed, total }) => sendProgress({
              nodeId, sourceId: 'linkedin', status: 'searching',
              detail: `Re-fetching descriptions… ${completed}/${total}`, warning: null,
              activity: 'description-enrichment', activityCompleted: completed, activityTotal: total,
            }),
          });
          if (cancelled || signal?.aborted) {
            return { resolved: false, cancelled: true, items: [], nextBlockedUrl: null };
          }
          // Merge whatever we got this pass back into the full set (keeps prior
          // descriptions for jobs enriched before the ceiling was hit).
          const enrichedByUrl = new Map(enriched.map(j => [j.url, j]));
          const structurallyDropped = new Set(structuralDroppedKeys);
          items = allLinkedIn.filter(j => !structurallyDropped.has(sourceJobKey(j)))
            .map(j => enrichedByUrl.get(j.url) || j);
          const stillEmpty = filterJobsByDescriptionEvidence(items).dropped.length;
          let scoringItems;
          recordResolve({ needEnrich: needEnrich.length, enrichSuccess: successCount, contextRotations, walled, stillEmpty });
          // Egress-IP trail entry for this Solve. `walled` distinguishes the
          // re-walled outcome from a clean finish; comparing `ip` to the prior
          // pass records whether the observed VPN egress changed, not why the
          // guest limit did or did not clear.
          recordLinkedinEnrichPass({ kind: 'solve', nodeId, jobRunId, ip: currentIp, ipOk: !!currentIp, walled, noInternet, browserUnavailable, attempted, remainingBefore: needEnrich.length, enriched: successCount, stillEmpty, noDesc, noDescSoftBlock, noDescGenuine, evalErrors, navErrors, contextRotations, browserGen, browserAgeMs, usedAuthenticated, authenticatedFallback, startedAt: passStartedAt });
          logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch: +${successCount} description(s), ${stillEmpty} still empty (${contextRotations} ctx-rotation(s)${walled ? ', guest wall' : ''})`);

          // Persist this pass's descriptions back to the snapshot. Without this,
          // re-fetch always re-reads the SAME stale "N empty" snapshot and re-does
          // the first batch — so a retry starts from the same early rows and adds
          // nothing new (observed: two retries both read 272 empty, both re-did the
          // first jobs). Re-saving shrinks needEnrich each pass so retries actually
          // walk DEEPER into the list as LinkedIn's guest quota cools.
          if (successCount > 0) {
            try {
              scoringItems = await persistRecoveryPool(items);
            } catch (error) {
              logger.warn(`[Jobs][${nodeId}] LinkedIn re-fetch: could not persist descriptions to snapshot — ${error.message}`);
              const persistenceWarning = descriptionRecoveryPersistenceWarning(
                'LinkedIn',
                error,
                'Recovered LinkedIn descriptions could not be checkpointed, so this source was not marked complete.',
              );
              sendProgress({ nodeId, sourceId: 'linkedin', count: items.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: persistenceWarning });
              return {
                resolved: false,
                staleRun: error?.code === 'DESCRIPTION_RECOVERY_SUPERSEDED',
                items: [],
                warning: persistenceWarning,
                replaceSourceItems: false,
                nextBlockedUrl: null,
              };
            }
          } else {
            scoringItems = await admitForScoring(items);
          }

          if (browserUnavailable) {
            const browserWarning = linkedInBrowserUnavailableWarning({ profileReserved, browserError });
            recordResolve({ needEnrich: needEnrich.length, enrichSuccess: successCount, contextRotations, walled: false, stillEmpty, browserUnavailable: true });
            sendProgress({ nodeId, sourceId: 'linkedin', count: items.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: browserWarning });
            return { resolved: true, items: scoringItems, warning: browserWarning, replaceSourceItems: true, nextBlockedUrl: null };
          }
          if (noInternet) {
            // The VPN IP went offline mid-pass — every fetch failed at the network
            // layer (not a LinkedIn wall). Same remediation as a rate-limit (switch
            // VPN + Solve) but a DIFFERENT cause, so the message says the server is
            // dead, not throttled. Reuse the gating code so the Solve button +
            // pipeline pause behave identically with no renderer change. We don't
            // create an observed-IP guard here: getEgressIp may itself fail on
            // the next try, and the probe re-detects its condition regardless.
            const ipNote = currentIp ? ` (IP ${currentIp})` : '';
            const offlineWarning = {
              code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: 'No internet',
              evidence: `This VPN IP has no working internet${ipNote} — description fetches failed at the network layer${successCount > 0 ? ` after +${successCount} this pass` : ''}. ${stillEmpty} job(s) still without a description.`,
              suggestion: 'The VPN server you switched to has no connection. Switch to a DIFFERENT VPN location (confirm a web page loads), then click Solve to continue.',
            };
            sendProgress({ nodeId, sourceId: 'linkedin', count: items.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: offlineWarning });
            return { resolved: true, items: scoringItems, warning: offlineWarning, replaceSourceItems: true, nextBlockedUrl: null };
          }
          if ((walled || noDescSoftBlock > 0) && stillEmpty > 0) {
            // Got a batch but hit LinkedIn's guest ceiling again — either a hard
            // URL wall (walled) or gutted soft-block pages (noDescSoftBlock) that
            // come back empty without tripping the wall detector. Their shared
            // cause is a guest-limit condition, but its key is not inferred here.
            // Keep the warning + Solve button: the pipeline stays gated and the
            // user can wait briefly or change VPN egress, then retry until every
            // description is grabbed (or they Skip). A clean done here (the
            // old `walled`-only check) stranded the soft-blocked residual — it
            // auto-resumed scoring with jobs still empty. Remember this observed
            // IP so the next immediate retry can be deferred briefly. severity
            // 'throttle' (not 'warn') keeps the action button visible (the card
            // hides it for 'warn'/'info') and renders amber rather than block-red.
            if (canWriteTelemetry()) rememberLinkedInCeiling(currentIp || linkedinCeiling.ip);
            const ipNote = currentIp ? ` (IP ${currentIp})` : '';
            const reason = walled
              ? "LinkedIn temporarily limited description enrichment"
              : `LinkedIn served ${noDescSoftBlock} gutted (soft-blocked) page(s)`;
            const rateWarning = {
              code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: 'Wait or switch VPN',
              evidence: `${reason} after +${successCount} this pass${ipNote} — ${stillEmpty} job(s) still without a description.`,
              suggestion: 'Wait 1 minute, then click Solve to retry this IP; or switch VPN to a new working location and Solve now. A verified LinkedIn session is tried first when available.',
            };
            sendProgress({ nodeId, sourceId: 'linkedin', count: items.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: rateWarning });
            return { resolved: true, items: scoringItems, warning: rateWarning, replaceSourceItems: true, nextBlockedUrl: null };
          }
          if (canWriteTelemetry()) {
            clearLinkedInCeiling(); // finished without hitting the ceiling — reset
            // A clean LinkedIn re-fetch returns here, before the generic resolve
            // tail, so it must retire its own sources-blocked stage entry.
            recordSourceResolvedAfterGather('linkedin');
          }
          sendProgress({ nodeId, sourceId: 'linkedin', count: items.length, status: 'done' });
          return { resolved: true, items: scoringItems, replaceSourceItems: true, nextBlockedUrl: null };
        } else if (allLinkedIn.length > 0) {
          // Everything already has a description — return them so the hub merge
          // still replaces the pending set (clears the warning cleanly).
          logger.info(`[Jobs][${nodeId}] LinkedIn re-fetch: all ${allLinkedIn.length} jobs already have descriptions`);
          items = await admitForScoring(allLinkedIn);
          if (canWriteTelemetry()) {
            clearLinkedInCeiling();
            recordSourceResolvedAfterGather('linkedin');
          }
          sendProgress({ nodeId, sourceId: 'linkedin', count: allLinkedIn.length, status: 'done' });
          return { resolved: true, items, replaceSourceItems: true, nextBlockedUrl: null };
        } else {
          logger.warn(`[Jobs][${nodeId}] LinkedIn re-fetch: snapshot has no LinkedIn jobs for this hub (sourceHubId=${snapshot.sourceHubId}) — returning empty items`);
        }
      } catch (err) {
        if (signal?.aborted) {
          return { resolved: false, cancelled: true, items: [], nextBlockedUrl: null };
        }
        logger.warn(`[Jobs][${nodeId}] LinkedIn re-fetch skipped — snapshot unavailable: ${err.message}`);
        return {
          resolved: false,
          items: [],
          warning: {
            code: 'description-recovery-snapshot-unavailable', severity: 'block',
            evidence: 'The current LinkedIn description recovery snapshot could not be read, so no stale rows were merged.',
            suggestion: 'Run the search again, then retry Solve from its current source card.',
          },
          nextBlockedUrl: null,
        };
      }

      return { resolved: false, items: [], nextBlockedUrl: null };
      }, signal, `job LinkedIn description recovery:${nodeId}`));
    }

    // Use the source's ordinary list extractor in the visible window.  In
    // particular, Google must not take authWindows' no-extractor body-text
    // shortcut: a clean Google Jobs result page has enough text to satisfy that
    // shortcut, so the old omission closed Solve immediately with zero rows.
    const runGenericResolve = async () => {
    const resolveConfig = getJobSourceResolveConfig(sourceId);
    const inlineExtractorJS = resolveConfig?.extractorJS || null;
    // Google’s visible Solve window can settle on only its first ten mounted
    // cards. Keep the original post-age/history recovery universe alongside
    // that visible slice, so a 10/10 duplicate extraction cannot erase the
    // initial run’s unresolved rows or falsely unlock scoring.
    let sourceRecoverySnapshot = null;
    let sourceRecoveryJobs = [];
    const resolveGenericPostings = createOfficialPostingRecoveryPassResolver(rows =>
      settleScrapedRowsForScoring(rows, { signal }), { signal });
    // Load the recovery snapshot for ANY source whose Solve can recover
    // descriptions, not just Google: a Glassdoor panel-429 strands rows exactly
    // the same way, and without the snapshot the postprocessor below falls back
    // to re-deriving candidates from the reopened page — which re-applies age +
    // history and can discard the very listings Solve was clicked to fix.
    //
    // The hard early-returns stay GOOGLE-ONLY on purpose. For any other source a
    // stale or row-less snapshot must fall THROUGH to the ordinary resolve path;
    // returning a block warning there would let one Solve click wedge a source
    // that simply had nothing to recover.
    // Google is the only source whose Solve DEPENDS on the snapshot (its visible
    // window mounts ten cards, so without the snapshot a duplicate extraction
    // would falsely unlock scoring). For every other enrichment source the
    // snapshot is an OPTIMISATION: it lets recovery target the stranded
    // identities instead of re-deriving them from the reopened page. So a
    // missing/stale/row-less snapshot blocks only Google; anything else falls
    // through to the ordinary resolve path rather than letting one Solve click
    // wedge a source that simply had nothing to recover.
    const recoveryBlocksResolve = sourceId === 'google';
    const recoveryLabel = resolveSourceLabel(sourceId);
    let sourceRecoveryCheckpointOwned = false;
    // This is pass-local state, not a replacement for durable recovery data.
    // It is reported only as a fixed outcome so a multi-hub report can tell
    // whether the recommendation it shows actually reached the checkpoint.
    let recoveryCheckpointOutcome = 'not-applicable';
    const unusableRecoverySnapshot = (code, evidence, suggestion) => {
      sourceRecoverySnapshot = null;
      sourceRecoveryJobs = [];
      return recoveryBlocksResolve
        ? { resolved: false, items: [], warning: { code, severity: 'block', evidence, suggestion }, nextBlockedUrl: null }
        : null;
    };
    if (resolveConfig?.requiresDescriptionEnrichment) {
      let blocked = null;
      try {
        // Every description-enrichment source first tries its exact run sidecar.
        // Google requires it; Glassdoor/Zip retain their visible-window fallback
        // only when no attributable current-run checkpoint exists. Unsaved
        // canvases use the same exact-run contract in the private app-data
        // fallback directory, so a missing canvas path is not itself a failure.
        let checkpointError = null;
        let loaded;
        try {
          loaded = await loadDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId);
          sourceRecoveryCheckpointOwned = true;
          recoveryCheckpointOutcome = 'unchanged';
        } catch (error) {
          checkpointError = error;
          if (!recoveryBlocksResolve) loaded = await loadJobAnalysisSnapshot(canvasFilePath, nodeId, jobRunId);
        }
        if (!loaded) throw checkpointError || new Error('Description recovery checkpoint unavailable.');
        const { snapshot, origin } = loaded;
        const ownership = await assessDescriptionRecoveryCheckpoint({ snapshot, origin, nodeId, jobRunId, canvasFilePath });
        if (ownership.ok) {
          sourceRecoverySnapshot = snapshot;
          sourceRecoveryJobs = snapshotDescriptionRecoveryJobs(snapshot)
            .filter(job => job?.source === sourceId);
          // A challenge can happen before this source yielded any rows. The
          // exact checkpoint still owns an ordered blocked-URL queue, so let
          // the visible resolver run normally and persist that queue update.
        } else if (recoveryBlocksResolve) {
          const warning = ownership.reason === 'current-snapshot-unavailable'
            || ownership.reason === 'missing-run-id'
            || ownership.reason === 'missing-ownership'
            || ownership.reason === 'live-run-checkpoint-not-ready'
            ? descriptionRecoveryNotReadyWarning(recoveryLabel, ownership.reason)
            : {
                code: 'description-recovery-snapshot-stale',
                severity: 'block',
                evidence: `The current ${recoveryLabel} recovery snapshot belongs to a different ${ownership.reason === 'hub-mismatch' ? 'hub' : 'search run'}, so it was not merged into this search.`,
                suggestion: 'Run the search again, then retry Solve from its current source card.',
              };
          logger.info(`[Jobs][${nodeId}] ${recoveryLabel} Solve rejected recovery snapshot: ${ownership.reason}`);
          blocked = { resolved: false, items: [], warning, nextBlockedUrl: null };
        } else {
          // Snapshot-assisted matching is an optimisation for the other
          // enrichment sources. Do not use an ambiguous/old snapshot, but do
          // retain their established ordinary visible-window resolve path.
          logger.info(`[Jobs][${nodeId}] ${recoveryLabel} Solve skipped unusable recovery snapshot: ${ownership.reason}`);
        }
      } catch (error) {
        logger.warn(`[Jobs][${nodeId}] ${recoveryLabel} resolve could not read the description recovery pool: ${error?.message || error}`);
        blocked = recoveryBlocksResolve
          ? {
              resolved: false,
              items: [],
              warning: descriptionRecoveryNotReadyWarning(recoveryLabel, 'current-snapshot-unavailable'),
              nextBlockedUrl: null,
            }
          : unusableRecoverySnapshot(
              'description-recovery-snapshot-unavailable',
              `${recoveryLabel}’s current-run description recovery snapshot could not be read, so no stale rows were merged.`,
              'Run the search again, then retry Solve from its current source card.',
            );
      }
      if (blocked) {
        recordJobSourceResolvePass(sourceId, {
          outcome: 'rejected',
          warning: blocked.warning,
          checkpoint: 'not-ready',
        }, { nodeId, jobRunId });
      }
      if (blocked) return blocked;
    }
    // Google's apply-link reader stopped part-way through the description pass:
    // those rows are parked with the redirects it never read. Retry re-reads ONLY
    // those /goto links — no listing is scraped again — and a second rate limit
    // keeps the rows fixed so far and restarts the same wait. The checkpoint
    // above already proved ownership for Google, so an unattributable snapshot
    // was refused before anything here runs.
    // Only a Solve that names the rate-limit warning takes this link-only path
    // (the card and Solve all both send warningCode); every other Google block,
    // and an unnamed caller, keeps its own visible-window scrape.
    const wantsGoogleApplyLinkRetry = sourceId === 'google'
      && warningCode === GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE;
    const pendingApplyRedirectRows = wantsGoogleApplyLinkRetry
      ? sourceRecoveryJobs.filter(row => row?.source === 'google'
        && Array.isArray(row?.pendingApplyRedirects) && row.pendingApplyRedirects.length > 0)
      : [];
    if (pendingApplyRedirectRows.length > 0) {
      const pendingRedirects = pendingApplyRedirectRows.flatMap(row => row.pendingApplyRedirects);
      const retried = await withSharedProfileLock(
        () => retryGoogleApplyLinks(pendingRedirects),
        signal,
        'Google apply-link retry',
      );
      const resolvedHrefByHref = new Map();
      for (const link of Array.isArray(retried?.links) ? retried.links : []) {
        if (link?.from && link?.to && link.from !== link.to) resolvedHrefByHref.set(link.from, link.to);
      }
      const { items: fixedRows, remaining } = applyGoogleApplyLinkRetryResults(pendingApplyRedirectRows, {
        resolvedHrefByHref,
        attemptedAll: retried?.rateLimited !== true,
      });
      recordJobSourceResolvePass(sourceId, {
        outcome: 'completed',
        warning: remaining === 0
          ? null
          : { code: GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE, severity: 'block' },
        checkpoint: 'unchanged',
        targeted: pendingApplyRedirectRows.length,
        attempted: pendingRedirects.length,
        recovered: fixedRows.length,
        unavailable: remaining,
      }, { nodeId, jobRunId });
      if (remaining === 0) {
        return { resolved: true, items: fixedRows, replaceMatchingItems: true, warning: null };
      }
      return {
        resolved: true,
        items: fixedRows,
        replaceMatchingItems: true,
        warning: googleApplyLinksRateLimitedWarning({
          url,
          readLinks: Number.isFinite(retried?.read) ? retried.read : 0,
          capturedLinks: fixedRows.length,
          pendingRows: remaining,
        }),
      };
    }
    const persistSourceRecoveryJobs = async (
      recoveryJobs,
      descriptionRecoveryState = sourceRecoverySnapshot?.descriptionRecoveryState,
    ) => {
      if (!sourceRecoverySnapshot || !sourceRecoveryCheckpointOwned) return;
      const descriptionRecoveryJobs = mergeDescriptionRecoverySourceJobs(
        snapshotDescriptionRecoveryJobs(sourceRecoverySnapshot), sourceId, recoveryJobs,
      );
      const resolvedJobs = (await resolveGenericPostings(scoreSafeRowsWithBoardClosed(filterJobsByDescriptionEvidence(descriptionRecoveryJobs)))).jobs;
      // Keep the durable scoring snapshot on the same admission policy as the
      // reply below; retain all rows only in the separate recovery pool.
      const scoringJobs = filterNonEnglishJobs(resolvedJobs).jobs;
      const { snapshot: nextSnapshot } = buildJobAnalysisSnapshot({
        jobs: scoringJobs,
        descriptionRecoveryJobs,
        descriptionRecoveryState,
        profile: sourceRecoverySnapshot.profile,
        careerData: sourceRecoverySnapshot.careerData,
        careerSnapshotId: sourceRecoverySnapshot.careerSnapshotId,
        operationAuthority,
        nodeId: sourceRecoverySnapshot.nodeId || nodeId,
        // FIX 12 (immediate call site): same reasoning as the LinkedIn
        // recovery rebuild above — without the original plan, the rebuilt
        // snapshot's role/resolvedRoleTitles would drop the real
        // AI-determined title list.
        jobPreferences: sourceRecoverySnapshot.jobPreferences || '',
        jobPreferencePlan: sourceRecoverySnapshot.jobPreferencePlan || null,
        snapshotContext: {
          sourceHubId: sourceRecoverySnapshot.sourceHubId || nodeId,
          runId: sourceRecoverySnapshot.runId || null,
          canvasFilePath,
          resumeSummary: sourceRecoverySnapshot.resumeSummary || '',
          locationSnapshot: sourceRecoverySnapshot.locationSnapshot || null,
          sourceGatheredCount: sourceRecoverySnapshot.sourceGatheredCount
            ?? sourceRecoverySnapshot.searchFunnel?.relevanceKept
            ?? sourceRecoverySnapshot.searchFunnel?.raw
            ?? sourceRecoverySnapshot.gatheredJobCount
            ?? scoringJobs.length,
        },
      });
      try {
        const persisted = requireDescriptionRecoveryCheckpointPersisted(
          await saveDescriptionRecoverySnapshotIfCurrent(nextSnapshot, {
            nodeId, jobRunId, sender: event.sender,
            continuation: continuationAdmission.continuation ? {
              intentId: continuationIntentId, leaseToken: continuationLeaseToken,
              operation: 'resolve-job-source', parentArtifactFingerprint,
            } : null,
          }),
        );
        sourceRecoverySnapshot = nextSnapshot;
        sourceRecoveryJobs = snapshotDescriptionRecoveryJobs(nextSnapshot).filter(job => job?.source === sourceId);
        recoveryCheckpointOutcome = 'saved';
        return persisted;
      } catch (error) {
        recoveryCheckpointOutcome = 'failed';
        throw error;
      }
    };
    // The normal manual-scrape path expands Glassdoor list rows into full detail
    // descriptions before returning them. A captcha/review-gate resolve used to
    // skip that step, so the DOM fallback's intentionally-empty `snippet` fields
    // were scored and persisted. Enrich rows that survive age, history, and
    // applied-job filters while the unlocked visible browser
    // still owns the authenticated profile.
    // Run source detail expansion while this browser still owns the freshly
    // cleared session. This is intentionally source-generic: Glassdoor is the
    // urgent case because its DOM-card fallback has blank snippets, but any
    // resolver source with a configured detail expander must not bypass the
    // normal search's description-first pipeline.
    const inlineItemsPostprocessor = resolveConfig?.requiresDescriptionEnrichment
      ? async ({ page, items: rawItems }) => {
          // Google initially mounts only ten cards in a fresh visible session.
          // Reveal and re-extract its full provider list before choosing recovery
          // targets; otherwise every Solve repeats the same first slice forever.
          const providerRawItems = sourceId === 'google' && sourceRecoveryJobs.length > 0
            ? await preloadResolvedJobList(page, sourceId, inlineExtractorJS, signal)
            : rawItems;
          const tagged = (Array.isArray(providerRawItems) ? providerRawItems : []).map(j => ({ ...j, source: sourceId }));
          // Repair recovered provider text before limiting and enrichment.
          repairJobsMojibake(tagged);
          normalizeJobsMarkup(tagged);
          let providerRows = acceptProviderSearchResults(tagged);
          if (normalizedCollectionLimits.jobsPerPlatform != null) {
            providerRows = providerRows.slice(0, normalizedCollectionLimits.jobsPerPlatform);
          }
          const relevanceDropped = 0;
          let candidates;
          let unavailableRecoveryRows = [];
          if (sourceRecoveryJobs.length > 0) {
            // The recovery snapshot is already the current run's post-age,
            // post-history universe. Target its unresolved identities directly;
            // reapplying history here discards exactly the rows Solve must fix.
            //
            // Source-generic, not Google-only. A Glassdoor panel-429 strands
            // rows exactly the same way, and the `else` branch below re-derives
            // candidates by re-running age + history over whatever the reopened
            // page happens to show — which can drop the very listings the user
            // clicked Solve to recover. Note the reach is still bounded by what
            // the reopened session has loaded: rows stranded deep in a long walk
            // are matched only once their page is present, so a Solve pass
            // recovers what is visible and leaves the rest for a later run
            // (they are never written to seen-history, so they stay eligible).
            const recoverySelection = partitionResolvedDescriptionRecoveryCandidates(
              sourceRecoveryJobs, sourceId, providerRows,
            );
            candidates = recoverySelection.candidates;
            unavailableRecoveryRows = recoverySelection.unavailable;
          } else {
            candidates = filterJobsByPostedSince(providerRows, activeSearchWindow.startTimestamp);
            if (canvasFilePath && candidates.length > 0) {
              const history = await loadJobsHistory(canvasFilePath);
              candidates = dedupAgainstHistory(candidates, history).kept;
              try {
                const applied = filterAppliedListings(candidates, await loadAppliedListingKeys(canvasFilePath));
                candidates = applied.kept;
                if (applied.removed > 0) {
                  logger.info(`[Jobs][${nodeId}] Applied-listing filter: dropped ${applied.removed} listing(s) already applied to`);
                }
              } catch (error) {
                logger.warn(`[Jobs][${nodeId}] Applied-listing filter unavailable: ${error?.message || error}`);
              }
            }
          }
          if (candidates.length === 0) {
            const recovery = reconcileResolvedDescriptionRecovery(sourceRecoveryJobs, sourceId, []);
            const guidanceOutcome = nextDescriptionRecoveryGuidance(
              sourceRecoverySnapshot?.descriptionRecoveryState?.[sourceId],
              {
                unavailableRows: unavailableRecoveryRows,
                providerRowsLoaded: providerRows.length,
                attempted: 0,
                recovered: 0,
                empty: recovery.emptyRows.length,
                completeTotal: recovery.completeRows.length,
              },
            );
            let persistenceWarning = null;
            if (sourceRecoveryCheckpointOwned && unavailableRecoveryRows.length > 0) {
              try {
                await persistSourceRecoveryJobs(recovery.recoveryJobs, {
                  ...(sourceRecoverySnapshot?.descriptionRecoveryState || {}),
                  [sourceId]: { ...(sourceRecoverySnapshot?.descriptionRecoveryState?.[sourceId] || {}), ...guidanceOutcome.state },
                });
              } catch (error) {
                logger.warn(`[Jobs][${nodeId}] ${resolveSourceLabel(sourceId)} resolve could not persist its retry recommendation: ${error?.message || error}`);
                persistenceWarning = descriptionRecoveryPersistenceWarning(
                  resolveSourceLabel(sourceId),
                  error,
                  `${resolveSourceLabel(sourceId)}’s latest no-progress check could not be checkpointed, so the retry/skip recommendation was not advanced.`,
                );
              }
            }
            const unavailableWarning = unavailableRecoveryRows.length > 0 && providerRows.length > 0
              ? {
                  code: 'description-listing-unavailable', severity: 'block',
                  evidence: `${unavailableRecoveryRows.length} unresolved ${resolveSourceLabel(sourceId)} listing(s) were not present in the currently loaded provider results, so this Solve pass had no matching card to open.`,
                  suggestion: `The listing may have expired, or it may sit deeper in the results than this pass loaded. Deferred listings are not recorded as seen, so a later run can still collect them.`,
                  recoveryGuidance: guidanceOutcome.guidance,
                }
              : null;
            const warning = persistenceWarning || buildResolvedDescriptionWarning(
              sourceId, unavailableWarning, recovery.completeRows, recovery.emptyRows,
            );
            return {
              // A visible duplicate slice must never clear an older unresolved
              // source pool just because history/filtering left nothing new to
              // click in this window.
              items: recovery.completeRows,
              warning,
              meta: {
                attempted: 0, targeted: 0, enriched: 0, succeeded: 0,
                completeTotal: recovery.completeRows.length,
                empty: recovery.emptyRows.length, relevanceDropped,
                providerRowsLoaded: providerRows.length,
                unavailable: unavailableRecoveryRows.length,
                recoveryRecommendation: guidanceOutcome.guidance.recommendation,
                consecutiveNoMatchPasses: guidanceOutcome.guidance.consecutiveNoMatchPasses,
                unavailableSamples: unavailableRecoveryRows.slice(0, 5).map(job => ({ title: job.title, url: job.url })),
                emptySamples: recovery.emptyRows.slice(0, 5).map(job => ({ title: job.title, url: job.url })),
                relevanceRejected: [],
              },
            };
          }

          const walkPlan = buildPhysicalCardWalkPlan(providerRows, candidates);
          const expanded = await enrichResolvedJobDescriptions(page, candidates, sourceId, signal, walkPlan);
          const enhanced = Array.isArray(expanded?.jobs) ? expanded.jobs : [];
          const byKey = new Map(enhanced.map(job => [sourceJobKey(job), job]));
          // Account against the candidate list, rather than only `enhanced`:
          // the expander may omit an expired/null row altogether, and that must
          // be visible as an incomplete description rather than disappearing
          // from the attempt/success/empty reconciliation.
          const completeRows = [];
          const emptyRows = [];
          for (const candidate of candidates) {
            const row = byKey.get(sourceJobKey(candidate));
            if (hasResolvedJobDescription(row)) {
              completeRows.push(mergeResolvedDescriptionRecoveryCandidate(candidate, row, sourceId));
            }
            else emptyRows.push(candidate);
          }

          const recovery = reconcileResolvedDescriptionRecovery(
            sourceRecoveryJobs,
            sourceId,
            [...completeRows, ...emptyRows],
          );
          const resolvedCompleteRows = sourceRecoveryJobs.length > 0 ? recovery.completeRows : completeRows;
          const resolvedEmptyRows = sourceRecoveryJobs.length > 0 ? recovery.emptyRows : emptyRows;
          const guidanceOutcome = nextDescriptionRecoveryGuidance(
            sourceRecoverySnapshot?.descriptionRecoveryState?.[sourceId],
            {
              unavailableRows: unavailableRecoveryRows,
              emptyRows: resolvedEmptyRows,
              providerRowsLoaded: providerRows.length,
              attempted: expanded?.attemptedCount ?? candidates.length,
              recovered: completeRows.length,
              empty: resolvedEmptyRows.length,
              completeTotal: resolvedCompleteRows.length,
            },
          );
          let persistenceWarning = null;
          if (sourceRecoveryJobs.length > 0) {
            try {
              await persistSourceRecoveryJobs(recovery.recoveryJobs, {
                ...(sourceRecoverySnapshot?.descriptionRecoveryState || {}),
                [sourceId]: { ...(sourceRecoverySnapshot?.descriptionRecoveryState?.[sourceId] || {}), ...guidanceOutcome.state },
              });
            } catch (error) {
              logger.warn(`[Jobs][${nodeId}] ${resolveSourceLabel(sourceId)} resolve could not persist the description recovery pool: ${error?.message || error}`);
              persistenceWarning = descriptionRecoveryPersistenceWarning(
                resolveSourceLabel(sourceId),
                error,
                `Recovered ${resolveSourceLabel(sourceId)} descriptions could not be checkpointed, so this source was not marked complete.`,
              );
            }
          }

          const expansionWarning = expanded?.descError || expanded?.descWarning || null;
          const unavailableWarning = unavailableRecoveryRows.length > 0 && providerRows.length > 0
            ? {
                ...(expansionWarning || {}),
                code: expansionWarning?.code || 'description-listing-unavailable',
                severity: 'block',
                evidence: `${expansionWarning?.evidence ? `${expansionWarning.evidence} ` : ''}${unavailableRecoveryRows.length} unresolved ${resolveSourceLabel(sourceId)} listing(s) were not present in the currently loaded provider results and had no matching card to open.`,
                suggestion: expansionWarning?.suggestion || 'The missing listing may have expired, or it may sit deeper in the results than this pass loaded. Deferred listings are not recorded as seen, so a later run can still collect them.',
                recoveryGuidance: guidanceOutcome.guidance,
              }
            // The found-but-unrecovered path needs the guidance too, or the
            // stall streak has no way to reach the message the user reads.
            // Only attach it when rows are actually outstanding: with none,
            // buildResolvedDescriptionWarning returns its root warning as-is,
            // and a synthesized object here would invent a warning where the
            // pass genuinely produced none.
            : (resolvedEmptyRows.length > 0
              ? { ...(expansionWarning || {}), recoveryGuidance: guidanceOutcome.guidance }
              : expansionWarning);
          const warning = persistenceWarning || buildResolvedDescriptionWarning(
            sourceId,
            unavailableWarning,
            resolvedCompleteRows,
            resolvedEmptyRows,
          );

          return {
            // Crucial: do not merge the original list card when detail expansion
            // failed. The warning keeps the source actionable (retryable when the
            // failure can be retried, Skip-only for a terminal hard block); only
            // full JD rows may cross the resolver boundary into pendingJobs/scoring.
            items: resolvedCompleteRows,
            warning,
            meta: {
              attempted: expanded?.attemptedCount ?? candidates.length,
              targeted: candidates.length,
              enriched: completeRows.length,
              succeeded: completeRows.length,
              completeTotal: resolvedCompleteRows.length,
              empty: resolvedEmptyRows.length,
              relevanceDropped,
              providerRowsLoaded: providerRows.length,
              unavailable: unavailableRecoveryRows.length,
              recoveryRecommendation: guidanceOutcome.guidance.recommendation,
              consecutiveNoMatchPasses: guidanceOutcome.guidance.consecutiveNoMatchPasses,
              consecutiveNoProgressPasses: guidanceOutcome.guidance.consecutiveNoProgressPasses,
              recoveryStalled: guidanceOutcome.guidance.stalled,
              unavailableSamples: unavailableRecoveryRows.slice(0, 5).map(job => ({ title: job.title, url: job.url })),
              relevanceRejected: [],
              emptySamples: resolvedEmptyRows.slice(0, 5).map(job => ({ title: job.title, url: job.url })),
            },
          };
        }
      : null;

    // Skip on a platform that kept refusing descriptions: no window is opened.
    // The listings still unread are looked up on each employer's own site by
    // the one posting finder, and the ones it reads are saved exactly as a
    // browser pass saves the cards it opened.
    const readRecoveryRowsFromEmployerPostings = async () => {
      const unreadRows = sourceRecoveryCheckpointOwned
        ? filterJobsByDescriptionEvidence(sourceRecoveryJobs).dropped.filter(job => listingStateRank(job) < 3)
        : [];
      const outcome = await readListingsFromEmployerPostings(unreadRows, { signal, nodeId });
      const readRows = outcome.read.map(({ candidate, row }) => mergeResolvedDescriptionRecoveryCandidate(candidate, row, sourceId));
      const recovery = reconcileResolvedDescriptionRecovery(sourceRecoveryJobs, sourceId, readRows);
      let warning = null;
      if (readRows.length > 0) {
        try {
          await persistSourceRecoveryJobs(recovery.recoveryJobs);
        } catch (error) {
          logger.warn(`[Jobs][${nodeId}] ${recoveryLabel} employer-posting read could not be saved: ${error?.message || error}`);
          warning = descriptionRecoveryPersistenceWarning(
            recoveryLabel,
            error,
            `${recoveryLabel} listings read from employer postings could not be checkpointed, so they were not added.`,
          );
        }
      }
      // Listings neither the platform nor the employer's site gave up keep the
      // platform paused, so the Skip that asked for this read still decides.
      if (!warning && recovery.emptyRows.length > 0) {
        warning = {
          code: 'description-listing-unavailable', severity: 'block', shortLabel: 'Skip recommended',
          evidence: `${readRows.length} of ${outcome.attempted} unread ${recoveryLabel} listing(s) were read from the employers' own postings. ${recovery.emptyRows.length} still have no description.`,
          suggestion: 'Skip to continue without them. They stay owed, so a later scan opens them if they turn up again.',
        };
      }
      logger.info(`[Jobs][${nodeId}] ${recoveryLabel} employer-posting read: ${unreadRows.length} unread, ${outcome.attempted} looked up, ${readRows.length} read (${Object.entries(outcome.outcomes).map(([code, count]) => `${code}=${count}`).join(', ') || 'none'})`);
      return {
        resolved: true,
        items: warning ? [] : recovery.completeRows,
        warning,
        diag: {
          postprocessOutcome: 'ok',
          postprocessMeta: {
            employerPostingRead: true,
            attempted: outcome.attempted, targeted: unreadRows.length,
            enriched: readRows.length, succeeded: readRows.length,
            completeTotal: recovery.completeRows.length, empty: recovery.emptyRows.length,
          },
        },
      };
    };
    const readsEmployerPostings = employerPostingRead === true && canReadFromEmployerPostings(sourceId);
    if (employerPostingRead === true && !readsEmployerPostings) return { resolved: false, items: [], nextBlockedUrl: null };
    if (!readsEmployerPostings) logger.info(`[Jobs][${nodeId}] Opening resolve window for ${sourceId}: ${url}${secondTabUrl ? ' (2-tab)' : ''}`);
    let result;
    if (readsEmployerPostings) result = await readRecoveryRowsFromEmployerPostings();
    else try {
      result = await withSharedProfileLock(() => openCaptchaResolveWindow(
        url,
        event.sender,
        signal,
        inlineExtractorJS,
        secondTabUrl || null,
        inlineItemsPostprocessor,
      ), signal, `job source resolve:${sourceId}`);
    } catch (error) {
      // `handleSafe` intentionally preserves this throw as the IPC failure.
      // Still retain the terminal Solve state in the compact source/run receipt:
      // before this guard, a launch/navigation/postprocessor exception was the
      // one outcome missing from the pass trail. Do not retain error text here
      // (it can include a URL or provider text); the fixed code is enough to
      // distinguish it from a blocked-but-returned visible window.
      if (!signal?.aborted) {
        recordJobSourceResolvePass(sourceId, {
          outcome: 'failed',
          warning: { code: 'description-detail-error', severity: 'block' },
          checkpoint: recoveryCheckpointOutcome,
        }, { nodeId, jobRunId });
      }
      throw error;
    }
    const resolverNeedsDescriptions = !!resolveConfig?.requiresDescriptionEnrichment;
    const postprocessOutcome = result?.diag?.postprocessOutcome || null;
    const rawResolvedItems = Array.isArray(result?.items) ? result.items.map(j => ({ ...j, source: sourceId })) : [];
    // authWindows intentionally preserves raw rows when the source-specific
    // postprocessor throws so the caller can report an actionable failure. Do
    // not let that recovery convenience cross the scoring boundary with blank
    // DOM list cards: only already-description-complete rows may survive it.
    const extractedRaw = resolverNeedsDescriptions && postprocessOutcome === 'failed'
      ? rawResolvedItems.filter(hasResolvedJobDescription)
      : rawResolvedItems;
    // Match normal-search admission order for every resolver source: normalize
    // provider text, then preserve every returned result.
    repairJobsMojibake(extractedRaw);
    normalizeJobsMarkup(extractedRaw);
    const admittedRows = acceptProviderSearchResults(extractedRaw);
    // Same conservative country backstop as the main search: a recovered row
    // that affirmatively names a different country never reaches scoring.
    const resolveSnapshotLocation = sourceRecoverySnapshot?.locationSnapshot?.searchLocation;
    const resolveLocation = String(
      preferredLocation || (typeof resolveSnapshotLocation === 'string' ? resolveSnapshotLocation : ''),
    ).trim();
    const extracted = filterProvablyOutsideCountryScope(admittedRows, resolveLocation).jobs;
    const enrichmentMeta = result?.diag?.postprocessMeta || null;
    const relevanceDropped = 0;
    const relevanceRejected = [];

    // Run the SAME age + history dedup the headless search path applies.
    // Without it, this path returned raw items, so every job the user already
    // saw on a prior run re-appeared (and got re-scored) each time they
    // re-solved a source's captcha. This path now only applies to browser-backed
    // sources; Indeed runs through its own browser launcher and does not use
    // resolve windows.
    const ageFiltered = filterJobsByPostedSince(extracted, activeSearchWindow.startTimestamp);
    const ageDropped = extracted.length - ageFiltered.length;
    // The deterministic pinned-title gate is gone; age-filtered rows flow
    // straight into history dedup, matching the main search path.
    let items = ageFiltered;
    let historyDropped = 0;
    let historyDropSamples = [];
    if (canvasFilePath) {
      const history = await loadJobsHistory(canvasFilePath);
      const deduped = dedupAgainstHistory(ageFiltered, history);
      items = deduped.kept;
      historyDropped = deduped.removed;
      historyDropSamples = deduped.samples || [];
      try {
        const applied = filterAppliedListings(items, await loadAppliedListingKeys(canvasFilePath));
        items = applied.kept;
        if (applied.removed > 0) {
          historyDropped += applied.removed;
          logger.info(`[Jobs][${nodeId}] Applied-listing filter: dropped ${applied.removed} listing(s) already applied to`);
        }
      } catch (error) {
        logger.warn(`[Jobs][${nodeId}] Applied-listing filter unavailable: ${error?.message || error}`);
      }
    }
    items = normalizedCollectionLimits.jobsPerPlatform == null
      ? items
      : items.slice(0, normalizedCollectionLimits.jobsPerPlatform);
    // Mirror the main search's final text cleanup and majority-English filter.
    // Resolve rows otherwise bypassed the single normalization chokepoint and
    // could carry raw markup or mojibake into scoring, cards, history, and
    // generated application documents.
    repairJobsMojibake(items);
    normalizeJobsMarkup(items);
    items = items.map(reconcileGlassdoorSalaryFromDescription);
    const resolveHealthWarning = sourceHealthWarningForRows(sourceId, items, nodeId);
    const descriptionEvidence = filterJobsByDescriptionEvidence(items);
    const officialResolution = await resolveGenericPostings(
      overlayResolvedRecoveryRows(scoreSafeRowsWithBoardClosed(descriptionEvidence), sourceRecoverySnapshot?.jobs));
    items = officialResolution.jobs;
    const languageFilter = filterNonEnglishJobs(items);
    items = languageFilter.jobs;
    if (languageFilter.dropped.length > 0) {
      logger.info(`[Jobs][${nodeId}] Resolve dropped ${languageFilter.dropped.length} listing(s) whose descriptions are not primarily English — not scored or marked seen`);
    }
    // A successful challenge clear does not make a list-card stub score-safe.
    // Retain the actionable source warning when a detail pass still left rows
    // without evidence, rather than returning `resolved: true` and letting the
    // renderer silently clear the source card.
    // Board-closed rows are terminal (kept by the official-posting pass or gone),
    // never "still lack a full description": no further Solve can recover them.
    const resolveDescriptionWarning = buildResolvedDescriptionWarning(
      sourceId,
      result?.warning || null,
      items,
      descriptionEvidence.dropped.filter(job => listingStateRank(job) < 3),
    );
    const resolveWarning = resolveDescriptionWarning || resolveHealthWarning;

    logger.info(
      `[Jobs][${nodeId}] Resolve window closed for ${sourceId}; auto-detected=${result.resolved}; ` +
      `${enrichmentMeta ? 'score-safe-returned' : 'inline-extracted'}=${extractedRaw.length}, relevanceDropped=${relevanceDropped}, ageDropped=${ageDropped}, historyDropped=${historyDropped}, descriptionEvidenceDropped=${descriptionEvidence.dropped.length}, languageDropped=${languageFilter.dropped.length}, new=${items.length}` +
      `${enrichmentMeta ? `, detail attempted=${enrichmentMeta.attempted || 0}, enriched=${enrichmentMeta.enriched || 0}, empty=${enrichmentMeta.empty || 0}` : ''}`
    );
    // Keyed by sourceId so a multi-source recovery keeps every resolve;
    // re-resolving the same source replaces its entry (latest wins).
    const canWriteTelemetry = () => canWriteJobResolveTelemetry(nodeId, jobRunId);
    // Keep a separate, source/run-owned record of each generic Solve. The
    // existing `resolves[sourceId]` object intentionally remains latest-wins;
    // it cannot answer a retry-loop question when more than one current hub is
    // present in a FULL report. Do not pass samples, URLs, evidence, or other
    // listing-bearing values into this strict normalizer.
    const recordGenericResolvePass = (outcome, warning, checkpoint = recoveryCheckpointOutcome) => recordJobSourceResolvePass(
      sourceId,
      {
        outcome,
        warning,
        providerRowsLoaded: enrichmentMeta?.providerRowsLoaded,
        targeted: enrichmentMeta?.targeted,
        attempted: enrichmentMeta?.attempted,
        recovered: enrichmentMeta?.succeeded ?? enrichmentMeta?.enriched,
        completeTotal: enrichmentMeta?.completeTotal,
        empty: enrichmentMeta?.empty,
        unavailable: enrichmentMeta?.unavailable,
        consecutiveNoMatchPasses: enrichmentMeta?.consecutiveNoMatchPasses,
        consecutiveNoProgressPasses: enrichmentMeta?.consecutiveNoProgressPasses,
        recommendation: enrichmentMeta?.recoveryRecommendation,
        checkpoint,
      },
      { nodeId, jobRunId },
    );
    if (canWriteTelemetry()) {
      const priorResolveMergeNet = Number(jobsTelemetry.resolves[sourceId]?.cumulativeMergeNet) || 0;
      jobsTelemetry.resolves[sourceId] = {
      ts: Date.now(),
      runId: jobRunId || null,
      resolved: !!result.resolved,
      cumulativeMergeNet: priorResolveMergeNet,
      hasMergeTelemetry: jobsTelemetry.resolves[sourceId]?.hasMergeTelemetry === true,
      passTimestamps: nextResolvePassTrail(jobsTelemetry.resolves[sourceId]),
      extracted: extractedRaw.length,
      relevanceDropped,
      relevanceRejected,
      ageDropped,
      historyDropped,
      historyDropSamples,
      kept: items.length,
      officialPosting: officialResolution.officialPosting,
      officialDedupDropped: officialResolution.officialDedupDropped,
      languageDropped: languageFilter.dropped.length,
      descriptionEvidenceDropped: {
        total: descriptionEvidence.dropped.length,
        deferred: descriptionEvidence.quality.deferred,
        empty: descriptionEvidence.quality.empty,
        short: descriptionEvidence.quality.short,
        bySource: descriptionEvidence.quality.bySource,
        samples: descriptionEvidence.quality.samples,
      },
      // Why a 0-extract happened: how the window closed, what the extractor saw,
      // and the page state — so "inline-extracted 0 → new 0" stops being an
      // unexplained dead end in the bug report (see openCaptchaResolveWindow).
      diag: result.diag || null,
      enrichment: enrichmentMeta,
      warning: resolveWarning ? { code: resolveWarning.code, severity: resolveWarning.severity } : null,
      };
    }
    // Preserve the original search funnel. A Solve reopens a page that the
    // initial scrape already counted; adding its raw/retained rows here made a
    // 119-row Google result look like 129 provider rows even when the renderer
    // accepted zero new jobs. The resolve funnel below records the recovery
    // attempt; only the renderer has the cross-source dedup evidence needed to
    // describe a real queue contribution.
    if (canWriteTelemetry() && jobsTelemetry.search && (!jobsTelemetry.nodeId || jobsTelemetry.nodeId === nodeId)) {
      const bySource = jobsTelemetry.search.bySource || (jobsTelemetry.search.bySource = {});
      const prior = bySource[sourceId] || {};
      bySource[sourceId] = {
        ...prior,
        warning: resolveWarning ? {
          code: resolveWarning.code,
          severity: resolveWarning.severity,
          evidence: resolveWarning.evidence ? String(resolveWarning.evidence).slice(0, 700) : null,
        } : null,
        resolveFunnel: {
          extracted: extractedRaw.length,
          ageDropped,
          historyDropped,
          descriptionEvidenceDropped: descriptionEvidence.dropped.length,
          languageDropped: languageFilter.dropped.length,
          kept: items.length,
        },
      };
    }
    // Resolves run after the search phase. Update the per-source event trail so
    // diagnostics reflect the final card state, without reviving the completed
    // gather pipeline. The renderer event remains best-effort, matching the
    // LinkedIn Solve branch above.
    const resolveStatus = resolveWarning?.severity === 'info'
      ? 'skipped'
      : (resolveWarning?.severity === 'block' || resolveWarning?.severity === 'throttle')
        ? 'error' : 'done';
    const resolveProgress = {
      nodeId,
      sourceId,
      jobRunId,
      status: resolveStatus,
      count: items.length,
      url,
      warning: resolveWarning,
      completed: 1,
      total: 1,
    };
    recordJobSourceProgress(resolveProgress, { updatePipeline: false, expectedNodeId: nodeId });
    if (!event.sender?.isDestroyed?.()) event.sender?.send?.('job-source-progress', resolveProgress);
    // Multi-query sequential solve: if this source had more than one blocked query,
    // consume the exact checkpoint-owned queue first. That queue survives a
    // restart or another canvas claiming process-global diagnostics; telemetry
    // remains only a backward-compatible same-process fallback.
    let checkpointRemainingUrls = null;
    // An employer-posting read opened no blocked query, so the queue is untouched.
    if (sourceRecoveryCheckpointOwned && !readsEmployerPostings) {
      const queuedUrls = recoveryBlockedUrlsForSource(sourceRecoverySnapshot?.descriptionRecoveryState, sourceId);
      if (queuedUrls.length > 0) {
        const consumedQueue = consumeRecoveryBlockedUrl(
          sourceRecoverySnapshot?.descriptionRecoveryState,
          sourceId,
          url,
        );
        checkpointRemainingUrls = consumedQueue.remaining;
        try {
          await persistSourceRecoveryJobs(sourceRecoveryJobs, {
            ...consumedQueue.state,
          });
        } catch (error) {
          logger.warn(`[Jobs][${nodeId}] ${recoveryLabel} resolve could not persist the remaining blocked-query order: ${error?.message || error}`);
          // This pass returns no rows, so its count of rows handed to the
          // card is zero. Left at the pre-failure value, the report's completion
          // check counts rows the card never received as recovered.
          if (canWriteTelemetry() && jobsTelemetry.resolves?.[sourceId]) {
            jobsTelemetry.resolves[sourceId] = { ...jobsTelemetry.resolves[sourceId], resolved: false, kept: 0 };
          }
          const warning = descriptionRecoveryPersistenceWarning(
            recoveryLabel,
            error,
            `${recoveryLabel} cleared a blocked query but could not checkpoint the remaining query order.`,
          );
          recordGenericResolvePass('failed', warning, 'failed');
          return {
            resolved: false,
            staleRun: error?.code === 'DESCRIPTION_RECOVERY_SUPERSEDED',
            items: [],
            warning,
            nextBlockedUrl: null,
          };
        }
      }
    }
    const remaining = checkpointRemainingUrls ?? (canWriteTelemetry()
      ? (jobsTelemetry.sourceBlockedUrls?.[sourceId] || []).filter(u => u !== url)
      : []);
    if (!readsEmployerPostings && canWriteTelemetry() && jobsTelemetry.sourceBlockedUrls) jobsTelemetry.sourceBlockedUrls[sourceId] = remaining;
    const nextBlockedUrl = readsEmployerPostings ? null : remaining[0] || null;
    if (nextBlockedUrl) logger.info(`[Jobs][${nodeId}] Next blocked URL for ${sourceId}: ${nextBlockedUrl}`);
    recordGenericResolvePass(
      resolveWarning?.severity === 'block' || resolveWarning?.severity === 'throttle'
        ? 'blocked'
        : (result?.resolved === false ? 'failed' : 'completed'),
      resolveWarning,
    );
    // The gather stage stamped `sources-blocked` with this source still waiting
    // on a user decision. A pass that resolved it with no remaining block
    // warning and no queued blocked query retires that stage; otherwise every
    // later report keeps calling a finished run INDETERMINATE.
    if (canWriteTelemetry()
      && result?.resolved !== false
      && resolveWarning?.severity !== 'block'
      && resolveWarning?.severity !== 'throttle'
      && !readsEmployerPostings
      && remaining.length === 0) {
      recordSourceResolvedAfterGather(sourceId);
    }
    // JobSourceCardNode's onResolved handler already reads `warning` off this
    // return to re-derive the hub's ScrapeWarningsPanel.
    return {
      resolved: !!result.resolved,
      items,
      warning: resolveWarning,
      nextBlockedUrl,
      // Additive, for the renderer's one-press blocked-query walk: how many
      // queued queries are still outstanding AFTER this pass, so the card can
      // say "query 3 of 7" and bound its own walk against a real number rather
      // than a guess. Older renderers ignore it; no migration needed.
      remainingBlockedCount: readsEmployerPostings ? 0 : remaining.length,
      attemptedBlockedUrl: readsEmployerPostings ? null : url,
      ...(readsEmployerPostings ? { employerPostingRead: { ...(enrichmentMeta || {}) } } : {}),
      // Google recovery returns the complete score-safe source subset from its
      // checkpoint, not an incremental provider page. Replacement semantics
      // keep repeated Solve attempts from inflating source/gathered counts when
      // the returned complete rows were already pending.
      // Google-only by design: it re-extracts its FULL provider list via
      // preloadResolvedJobList, so its pass legitimately replaces the source's
      // items. Other sources recover a visible subset and must merge, not
      // replace, or an unreached page would look like it vanished.
      replaceSourceItems: sourceId === 'google' && !!sourceRecoverySnapshot,
      // Append semantics: this pass adds recovered rows, it does not restate the
      // source's full set. Reporting every evidence drop as removed deleted
      // listings an earlier Solve had already completed — see retiredListingKeys.
      removedItemKeys: retiredListingKeys(descriptionEvidence.dropped, boardClosedRetirement(officialResolution)),
    };
    };
    // Every generic Solve may now consume an exact checkpoint-owned URL queue,
    // not only Google. Serialize its full read/visible-browser/write lifetime
    // per hub/run so two clicks cannot both consume the same queued query.
    return withDescriptionRecoveryLock({ canvasFilePath, nodeId, jobRunId, signal }, runGenericResolve);
  }, { beforeReply: checkpointContinuationBeforeReply('resolve-job-source'), captureListingLiveness: true });

  // Resume an Indeed scrape that was interrupted by a login-wall mid-pagination.
  // The user re-authenticates via Settings, then clicks Continue on the source
  // card. Runs only the remaining queries starting from the challenged page so
  // we don't repeat work already captured in pendingJobs.
  handleSafe('resume-job-source', async (event, { sourceId, nodeId, jobRunId = null, canvasFilePath, searchWindow, maxAgeDays, preferredLocation, resumeState, collectionLimits, enabledSourceIds, continuationIntentId = null, continuationLeaseToken = null, careerSnapshotId = null, operationAuthority = null, parentArtifactFingerprint = null } = {}, signal) => {
    requireSavedJobRecoveryCanvas(canvasFilePath);
    const continuationAdmission = await admitContinuationProviderWork(event, {
      canvasFilePath, nodeId, jobRunId, continuationIntentId, continuationLeaseToken,
      careerSnapshotId, operationAuthority, parentArtifactFingerprint,
    }, 'resume-job-source');
    if (!continuationAdmission.ok) return { resolved: false, operationSuperseded: true, items: [] };
    if (sourceId !== 'indeed') throw new Error('resume-job-source only supports indeed');
    if (!(await canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId))) {
      logger.info(`[Jobs][${nodeId}] Indeed Continue ignored: its durable run is no longer current`);
      return { resolved: false, staleRun: true, items: [] };
    }
    const canWriteTelemetry = () => canWriteJobResolveTelemetry(nodeId, jobRunId);
    // `observed` carries only fixed, enumerated observations for the durable
    // receipt (today: the native verification window's terminal value). It is
    // deliberately separate from `detail`, which is free-form prose for the
    // live trail and can embed an osascript error string or a poll summary.
    const recordResumeAttempt = (attemptSourceId, mode, outcome, detail, observed = null) => {
      recordResumeAttemptTelemetry(attemptSourceId, mode, outcome, detail, { nodeId, jobRunId });
      // Durable per-source/run twin of the line above, recorded HERE rather
      // than at each branch so every present and future call site in this
      // handler is covered by construction. The live trail alone could not
      // answer this incident: it is wiped by this hub's next search, and a
      // report with more than one current Job Search hub drops that whole
      // surface, so three Continue clicks left no retrievable record at all.
      recordJobSourceResumeAttempt(attemptSourceId, {
        mode,
        outcome,
        nativeResult: observed?.nativeResult,
      }, { nodeId, jobRunId });
    };
    const normalizedCollectionLimits = normalizeJobCollectionLimits(collectionLimits);
    const activeSearchWindow = effectiveJobSearchWindow(searchWindow, maxAgeDays);
    const ageDays = activeSearchWindow.providerLookbackDays;
    // The mode a "Continue"/"Log in"/"Solve" click was showing when the user
    // acted, kept for the resumeAttempts trail below even once a branch clears
    // it off effectiveResumeState. Branches that fall through into the generic
    // resume further down (e.g. a successful native login, see the comment at
    // its recordResumeAttempt call below) deliberately let the final resume
    // record its own trail entry too, so the trail reads e.g.
    // "logged-in -> resolved" instead of collapsing to one line.
    const attemptMode = resumeState?.mode || 'resume';
    if (!getRunnableJobSourceIds(enabledSourceIds, ACTIVE_SOURCE_IDS, normalizedCollectionLimits).includes(sourceId)) {
      recordResumeAttempt(sourceId, attemptMode, 'blocked', 'source disabled');
      return { resolved: false, disabled: true, items: [] };
    }
    if (resumeState?.mode === 'retry-descriptions') {
      const retryRows = Array.isArray(resumeState.jobs) ? resumeState.jobs : [];
      if (retryRows.length === 0) {
        recordResumeAttempt(sourceId, attemptMode, 'blocked', 'no descriptions to retry');
        return { resolved: false, items: [] };
      }
      logger.info(`[Jobs][${nodeId}] Retrying ${retryRows.length} exact Indeed description(s)`);
      const retried = await withSharedProfileLock(() => retryIndeedDescriptions(retryRows, signal), signal, 'job Indeed description retry');
      const retriedItems = Array.isArray(retried.jobs) ? retried.jobs : retryRows;
      repairJobsMojibake(retriedItems);
      normalizeJobsMarkup(retriedItems);
      const descriptionEvidence = filterJobsByDescriptionEvidence(retriedItems);
      const officialResolution = await settleScrapedRowsForScoring(scoreSafeRowsWithBoardClosed(descriptionEvidence), { signal });
      let items = officialResolution.jobs;
      const boardClosedOutcome = boardClosedRetirement(officialResolution);
      const retriedUnavailable = Array.isArray(retried.unavailable) ? retried.unavailable : [];
      const retriedBoardClosedKept = retriedUnavailable.filter(item => boardClosedOutcome.keptKeys.has(item?.key)).length;
      // Use the recovered final description before exposing score-ready rows.
      const languageFilter = filterNonEnglishJobs(items);
      items = languageFilter.jobs;
      if (languageFilter.dropped.length > 0) {
        logger.info(`[Jobs][${nodeId}] Description retry dropped ${languageFilter.dropped.length} listing(s) whose descriptions are not primarily English — not scored or marked seen`);
      }
      if (canWriteTelemetry()) {
        const priorResolveMergeNet = Number(jobsTelemetry.resolves.indeed?.cumulativeMergeNet) || 0;
        jobsTelemetry.resolves.indeed = {
        ts: Date.now(),
        runId: jobRunId || null,
        kind: 'description-retry',
        cumulativeMergeNet: priorResolveMergeNet,
        hasMergeTelemetry: jobsTelemetry.resolves.indeed?.hasMergeTelemetry === true,
        extracted: officialResolution.jobs.length,
        kept: items.length,
        languageDropped: languageFilter.dropped.length,
        descriptionEvidenceDropped: descriptionEvidence.dropped.length,
        attemptedDescriptions: retried.attempted || 0,
        recoveredDescriptions: retried.recovered || 0,
        remainingDescriptions: retried.remaining || 0,
        // Indeed's "gone" page is a board verdict now: only the rows the
        // official-posting pass did not keep were removed. The kept ones are counted apart.
        unavailableDescriptions: retriedUnavailable.filter(item =>
          !boardClosedOutcome.keptKeys.has(item?.key) && !boardClosedOutcome.deferredKeys.has(item?.key)),
        ...(retriedBoardClosedKept > 0 ? { boardClosedKept: retriedBoardClosedKept } : {}),
        challengeReason: retried.challengeReason || null,
        };
      }
      const retryDetail = `${items.length} description(s) recovered of ${retried.attempted || 0} attempted; descriptionEvidenceDropped=${descriptionEvidence.dropped.length}, languageDropped=${languageFilter.dropped.length}`;
      recordResumeAttempt(sourceId, attemptMode, 'resolved', retryDetail);
      const retryProgress = {
        nodeId,
        sourceId,
        jobRunId,
        status: 'done',
        count: items.length,
        warning: null,
        completed: 1,
        total: 1,
        detail: `description retry: ${retryDetail}`,
      };
      recordJobSourceProgress(retryProgress, { updatePipeline: false, expectedNodeId: nodeId });
      if (!event.sender?.isDestroyed?.()) event.sender?.send?.('job-source-progress', retryProgress);
      return {
        resolved: true,
        items,
        replaceMatchingItems: true,
        // `retried.unavailable` is an explicit observation — Indeed served a
        // "this job is no longer available" page. That is a BOARD verdict now: the
        // row retires only if the official-posting pass did not keep it (a kept
        // board-closed row is in `items`, replaced in place), so kept keys are
        // subtracted. The evidence drops go through the same retirement
        // filter the append paths use, for a reason replaceMatchingItems does
        // not cover: this pass can stop early. retryIndeedJobDescriptions breaks
        // out of its loop on the first challenge signal, so every target it
        // never opened comes back exactly as it went in — still description-less
        // — and lands in the drop set. replaceMatchingItems only protects rows
        // whose keys are present in `items`, and an unreached row is by
        // definition absent from it, so deriving removedItemKeys from the whole
        // drop set deleted listings this retry never even attempted. See
        // retiredListingKeys.
        removedItemKeys: [...new Set([
          ...retriedUnavailable.map(item => item?.key),
          ...retiredListingKeys(descriptionEvidence.dropped, boardClosedOutcome),
        ].filter(key => key && !boardClosedOutcome.keptKeys.has(key) && !boardClosedOutcome.deferredKeys.has(key)))],
      };
    }
    let effectiveResumeState = resumeState || {};
    // Whether a real Chrome window has owned the screen since the ownership
    // check at the top of this handler. Both native branches below hand the
    // shared profile to a window the user can leave open for an unbounded
    // stretch of wall-clock time; see this flag's one reader, just above the
    // resume scrape.
    let nativeWindowSettled = false;
    // "Continue" used to just re-run the same failing scrape: a logged-out
    // Indeed session redirects to its sign-in page, which flashed onscreen for
    // a second or two inside the "Job Collector / Checking session… /
    // Verifying login…" overlay and closed again before the user could do
    // anything with it — there was no way to actually log in from the card.
    // This branch is what gives the user a real, usable window: it opens
    // native Chrome (real macOS Keychain — see BUG 3, the reason the scrape
    // browser's mock-keychain profile could never read back a login done any
    // other way) and only falls through to the resume once that login is
    // confirmed connected.
    if (effectiveResumeState.mode === 'native-login') {
      // withSharedProfileLock is FIFO, so a second card's "Log in" click queues
      // BEHIND the first one's whole window lifetime — by the time it runs,
      // accounts.js's activeLoginFlows single-flight entry has already been
      // deleted and it would open a redundant second window seconds after the
      // user finished logging in. Dedupe on a login this process just completed
      // instead of on the disk cache, which is exactly the thing that can be
      // stale (a stale connected:true is what produced this bug in the first
      // place, so it must never be allowed to skip the window on its own).
      // Deliberately NOT fenced by canWriteTelemetry(): this stamp and its read
      // are a browser-resource decision about the single shared Chrome profile,
      // not a diagnostics write. A card restored from its durable manifest is
      // authorized by canPerformJobSourceAction (from disk) yet legitimately
      // does not own the in-process telemetry, so fencing left the stamp
      // unwritten, disarmed the dedupe process-wide, and opened a redundant
      // second native login window seconds after the user finished signing in.
      // The trail entry below stays fenced — inside recordResumeAttemptTelemetry,
      // which is the correct layer for it.
      if (Date.now() - indeedLoginStamp.confirmedAt < RECENT_INDEED_LOGIN_MS) {
        logger.info(`[Jobs][${nodeId}] Indeed login already completed ${Math.round((Date.now() - indeedLoginStamp.confirmedAt) / 1000)}s ago — resuming without opening a second window`);
        recordResumeAttempt(sourceId, attemptMode, 'logged-in', 'reused the login completed moments earlier');
        effectiveResumeState = { ...effectiveResumeState, mode: null };
      }
    }
    if (effectiveResumeState.mode === 'native-login') {
      logger.info(`[Jobs][${nodeId}] Opening native Chrome login for Indeed (resuming a needs-login card)`);
      let loginResult;
      try {
        // Accounts registers its same-platform single-flight BEFORE acquiring
        // the profile FIFO. Calling it directly lets a simultaneous Settings
        // login adopt this promise while it waits; wrapping it here would hide
        // that entry until after the first window closes and open a redundant
        // sequential login window.
        loginResult = await runPlatformLoginFlow('indeed', event.sender, { signal });
      } catch (error) {
        recordResumeAttempt(sourceId, attemptMode, 'error', error?.message || String(error));
        return {
          resolved: false, items: [],
          warning: {
            code: 'needs-login', severity: 'block',
            actionLabel: 'Log in',
            evidence: `Native Indeed login failed to open: ${error?.message || error}`,
            suggestion: 'Close any other open Chrome login window and click Log in again.',
            resumeState: effectiveResumeState,
          },
        };
      }
      // `inconclusive` means the flow never established anything — most often
      // openLoginWindow threw before a window opened (another visible window
      // already holds the shared-profile reservation) and accounts.js preserved
      // the PRIOR cached verdict rather than overwriting it. That prior value
      // can be the very stale connected:true that sent us here, so treating it
      // as a fresh login would record "logged-in", re-run the identical scrape,
      // hit the identical wall, and bury the real cause (nothing ever opened).
      if (!loginResult?.connected || loginResult?.inconclusive) {
        recordResumeAttempt(sourceId, attemptMode, 'login-failed', loginResult?.inconclusive
          ? `login window could not run: ${loginResult?.reason || 'inconclusive'}`
          : (loginResult?.reason || 'not connected'));
        return {
          resolved: false, items: [],
          warning: {
            code: 'needs-login', severity: 'block',
            actionLabel: 'Log in',
            evidence: loginResult?.reason || 'Indeed login window closed without a confirmed connection.',
            suggestion: 'Complete the sign-in in the Chrome window, then click Log in again.',
            resumeState: effectiveResumeState,
          },
        };
      }
      // This intentionally records a second trail entry below: a successful
      // login is only half the story. The scrape that follows records its own
      // entry, so the trail reads "logged-in → resolved" or the far more
      // diagnostic "logged-in → blocked (warning: needs-login)" — a login
      // that reports success and STILL leaves the scrape logged out is
      // exactly the failure this whole change exists to make visible.
      recordResumeAttempt(sourceId, attemptMode, 'logged-in', loginResult?.reason || 'native login confirmed connected');
      // Unfenced for the same reason as the read above: a shared-profile fact,
      // not telemetry. Do not reintroduce a run fence here.
      indeedLoginStamp.confirmedAt = Date.now();
      nativeWindowSettled = true;
      effectiveResumeState = { ...effectiveResumeState, mode: null };
    }
    if (effectiveResumeState.mode === 'native-challenge') {
      const challengeUrl = String(effectiveResumeState.challengeUrl || '');
      if (!challengeUrl) {
        recordResumeAttempt(sourceId, attemptMode, 'blocked', 'no challengeUrl in resume state');
        return { resolved: false, items: [] };
      }
      logger.info(`[Jobs][${nodeId}] Handing Indeed challenge to native Chrome: ${challengeUrl}`);
      let nativeResult;
      try {
        // Keep the job-side browser queue exclusive while real Chrome owns the
        // shared profile; the helper itself transfers/resolves the reservation.
        nativeResult = await withSharedProfileLock(() => openNativeIndeedChallengeWindow(challengeUrl, event.sender, { challengeObserved: true, signal }), signal, 'job Indeed native challenge');
      } catch (error) {
        recordResumeAttempt(sourceId, attemptMode, 'error', error?.message || String(error), { nativeResult: 'launch-error' });
        return {
          resolved: false, items: [],
          warning: {
            code: 'scrape-failed', severity: 'block',
            evidence: `Could not open native Indeed verification: ${error?.message || error}`,
            suggestion: 'Close other Chrome login windows and click Continue again.',
            resumeState: effectiveResumeState,
          },
        };
      }
      const nativeOutcome = String(nativeResult?.result || '');
      // Already an observation-only sentence built by the window itself (poll
      // counts, poll errors, and whether an indeed.com tab was ever visible).
      // Carry it verbatim into the warning; never let the copy around it assert
      // a cause the observer did not actually see.
      const pollSummary = String(nativeResult?.pollEvidenceSummary || '').trim();
      // recordResumeAttemptTelemetry slices `detail` at 200 characters and the
      // summary can embed a 200-character osascript error, so the trail gets a
      // self-marked short form rather than a silently amputated tail. The
      // warning above keeps the full text.
      const pollSummaryForTrail = pollSummary.length > 90 ? `${pollSummary.slice(0, 90)}… (truncated; see warning)` : pollSummary;
      // The split itself lives in nativeChallengeTerminalDisposition so the
      // shipped decision is the thing under test, not a restatement of it.
      const nativeDisposition = nativeChallengeTerminalDisposition(nativeOutcome);
      if (nativeDisposition === 'blocked') {
        recordResumeAttempt(sourceId, attemptMode, 'blocked', `native challenge ended ${nativeOutcome}${pollSummaryForTrail ? `; ${pollSummaryForTrail}` : ''}`, { nativeResult: nativeOutcome });
        return {
          resolved: false, items: [],
          warning: {
            code: 'scrape-failed', severity: 'block',
            evidence: `Native Indeed verification ended ${nativeOutcome}.${pollSummary ? ` Observer: ${pollSummary}.` : ''}`,
            suggestion: nativeOutcome === 'hard-block'
              ? 'Indeed returned a non-interactive block. Wait before retrying, or use a different network/session.'
              : 'Complete the check in the real Chrome window, then click Continue again.',
            resumeState: effectiveResumeState,
          },
        };
      }
      if (nativeDisposition !== 'cleared') {
        // Inconclusive, not negative — see NATIVE_CHALLENGE_OBSERVED_NEGATIVES.
        // Fall through to the resume scrape and let it decide: if the profile is
        // still walled it returns its own challenge/needs-login warning, and if
        // the user's verification really did land the rows simply arrive.
        // Recorded as a distinct outcome so the trail can tell "cleared then
        // resumed" apart from "no clearance observed, probed anyway"; the scrape
        // below records its own entry, the same two-line pattern the native-login
        // branch uses ("logged-in -> resolved").
        // `nativeResult` is the enum half of the same observation: an empty or
        // unrecognised terminal normalizes to 'unknown' rather than being
        // dropped, because "the window reported nothing we recognise" is
        // exactly the state that produced this incident.
        recordResumeAttempt(sourceId, attemptMode, 'unverified', `native challenge ended ${nativeOutcome || 'with no reported result'}; probing with the resume scrape${pollSummaryForTrail ? `; ${pollSummaryForTrail}` : ''}`, { nativeResult: nativeOutcome || 'unknown' });
      } else {
        // The affirmative half of the same distinction. Without this line the
        // trail showed nothing at all for a window that DID report a clean
        // first-party tab, so a report could not tell a user's successful
        // verification apart from a Continue click that never reached the
        // window — and 'cleared' would never appear in the durable receipt.
        recordResumeAttempt(sourceId, attemptMode, 'cleared', `native challenge ended cleared${pollSummaryForTrail ? `; ${pollSummaryForTrail}` : ''}`, { nativeResult: 'cleared' });
      }
      nativeWindowSettled = true;
      effectiveResumeState = { ...effectiveResumeState, mode: null };
    }
    if (effectiveResumeState.mode === 'retry-later') {
      // A non-interactive block has no login/captcha for the user to clear —
      // re-running IS the retry they asked for. Log it explicitly so a bug
      // report shows this was a deliberate immediate retry, not a silent
      // no-op that happens to look identical to one.
      logger.info(`[Jobs][${nodeId}] Retrying Indeed after a non-interactive block (mode=retry-later)`);
    }
    // A native window can own the screen for the full five-minute ceiling, and
    // the run that authorized this click can retire inside it: the user gives up,
    // closes the window, and starts a fresh search on this same hub, which writes
    // a new jobRunId over this run's manifest. Nothing further down would notice.
    // The resume would queue on the FIFO shared-profile lock, run a COMPLETE
    // Indeed pass for a retired run, delay the new search by exactly that pass,
    // and emit job-source-progress under a token the renderer discards. Re-read
    // the same durable manifest the handler entry checked — it is the only input
    // that can have changed while the window was up.
    if (nativeWindowSettled && !(await canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId))) {
      logger.info(`[Jobs][${nodeId}] Indeed resume abandoned after the native window settled: its durable run is no longer current`);
      return { resolved: false, staleRun: true, items: [] };
    }
    const { remainingQueries, startPage = 0 } = effectiveResumeState;
    if (!Array.isArray(remainingQueries) || remainingQueries.length === 0) {
      recordResumeAttempt(sourceId, attemptMode, 'blocked', 'no remaining queries in resume state');
      return { resolved: false, items: [] };
    }
    // Only the extractor-authored fixed-width numeric vector is accepted.
    // Omit malformed/legacy metadata so the extractor takes its conservative
    // one-page-per-query resume path rather than reallocating Auto depth.
    const resumePageBudgets = Array.isArray(effectiveResumeState.pageBudgets)
      && effectiveResumeState.pageBudgets.length === remainingQueries.length
      && effectiveResumeState.pageBudgets.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000)
      ? effectiveResumeState.pageBudgets.slice()
      : null;
    const resumeStartPages = Array.isArray(effectiveResumeState.startPages)
      && effectiveResumeState.startPages.length === remainingQueries.length
      ? effectiveResumeState.startPages.map(page => Math.max(0, Math.floor(Number(page) || 0)))
      : remainingQueries.map((_query, index) => index === 0 ? Math.max(0, Math.floor(Number(startPage) || 0)) : 0);
    // A filtered automatic recovery may contain only q2/q3 of the original
    // plan. Keep those original durable ledger indexes through an interactive
    // login/challenge continuation; malformed legacy state falls back to the
    // continuation's local order rather than trusting arbitrary values.
    const resumeQueryIndexes = Array.isArray(effectiveResumeState.queryIndexes)
      && effectiveResumeState.queryIndexes.length === remainingQueries.length
      && effectiveResumeState.queryIndexes.every(index => Number.isSafeInteger(index) && index >= 0)
      ? effectiveResumeState.queryIndexes.slice()
      : remainingQueries.map((_query, index) => index);
    const location = String(preferredLocation || '').trim();
    logger.info(`[Jobs][${nodeId}] Resuming Indeed: ${remainingQueries.length} remaining queries from pages [${resumeStartPages.map(page => page + 1).join(', ')}] (location=${location || 'none'})`);
    // Same shared-profile lock — a "Continue" click could land while a full
    // search is still scraping; serialize this Indeed browser against them.
    const result = await withSharedProfileLock(() => fetchIndeedListingsBrowser(
      remainingQueries, signal, ageDays, null, null, resumeStartPages, null, location,
      normalizedCollectionLimits, resumePageBudgets, true, resumeQueryIndexes, activeSearchWindow.startTimestamp,
    ), signal, 'job Indeed resume scrape');
    // Observation of the session this resumed scrape actually ran with (see
    // BUG 3/4), plus BUG 5's cache truth check — a warning proving the
    // session is dead must downgrade the cached "connected" status.
    await syncIndeedSessionStatusFromScrape(result?.sessionDiagnostics, result?.warning, {
      telemetryOwnership: { nodeId, jobRunId },
    });
    const extracted = Array.isArray(result?.items) ? result.items.map(j => ({ ...j, source: sourceId })) : [];
    // Raw source-returned rows stay distinct from the subset that clears the
    // history/description gates below. This value is also returned to the
    // renderer so its collected counter remains in the same dimension as the
    // initial search's `gatheredCount`.
    const gathered = Math.max(0, Number(extracted.length) || 0);
    // Same conservative country backstop as the main search path.
    const countryScope = filterProvablyOutsideCountryScope(extracted, location);
    if (countryScope.dropped > 0) {
      logger.info(`[Jobs][${nodeId}] Resume country scope dropped ${countryScope.dropped} listing(s) outside ${location}`);
    }
    const ageFiltered = filterJobsByPostedSince(countryScope.jobs, activeSearchWindow.startTimestamp);
    const ageDropped = countryScope.jobs.length - ageFiltered.length;
    // The deterministic pinned-title gate is gone; age-filtered rows flow
    // straight into history dedup, matching the main search path.
    let items = ageFiltered;
    let historyDropped = 0;
    let historyDropSamples = [];
    if (canvasFilePath) {
      const history = await loadJobsHistory(canvasFilePath);
      const deduped = dedupAgainstHistory(ageFiltered, history);
      items = deduped.kept;
      historyDropped = deduped.removed;
      historyDropSamples = deduped.samples || [];
      try {
        const applied = filterAppliedListings(items, await loadAppliedListingKeys(canvasFilePath));
        items = applied.kept;
        if (applied.removed > 0) {
          historyDropped += applied.removed;
          logger.info(`[Jobs][${nodeId}] Applied-listing filter: dropped ${applied.removed} listing(s) already applied to`);
        }
      } catch (error) {
        logger.warn(`[Jobs][${nodeId}] Applied-listing filter unavailable: ${error?.message || error}`);
      }
    }
    items = normalizedCollectionLimits.jobsPerPlatform == null
      ? items
      : items.slice(0, normalizedCollectionLimits.jobsPerPlatform);
    // Keep the recovery path on the same last-mile contract as a normal search:
    // source text must be clean and complete before it reaches scoring, cards,
    // or the seen-history writer. A native challenge resume used to skip all of
    // these chokepoints and could score a blank DOM/list-card row.
    repairJobsMojibake(items);
    normalizeJobsMarkup(items);
    const resumeHealthWarning = sourceHealthWarningForRows(sourceId, items, nodeId);
    const descriptionEvidence = filterJobsByDescriptionEvidence(items);
    const officialResolution = await settleScrapedRowsForScoring(scoreSafeRowsWithBoardClosed(descriptionEvidence), { signal });
    items = officialResolution.jobs;
    // Keep the resumed scoring queue on the same majority-English policy.
    const languageFilter = filterNonEnglishJobs(items);
    items = languageFilter.jobs;
    if (languageFilter.dropped.length > 0) {
      logger.info(`[Jobs][${nodeId}] Indeed resume dropped ${languageFilter.dropped.length} listing(s) whose descriptions are not primarily English — not scored or marked seen`);
    }
    const enrichment = {
      ...(result?.enrichment || result?.enrichmentMeta || {}),
      residualAttempts: summarizeIndeedResumeEnrichment(extracted),
    };
    const resolved = items.length > 0 || !result?.warning;
    const warning = result?.warning || resumeHealthWarning;
    const funnelDetail = `extracted=${extracted.length}, countryScopeDropped=${countryScope.dropped}, ageDropped=${ageDropped}, historyDropped=${historyDropped}, descriptionEvidenceDropped=${descriptionEvidence.dropped.length}, languageDropped=${languageFilter.dropped.length}, new=${items.length}`;
    logger.info(`[Jobs][${nodeId}] Indeed resume complete: ${funnelDetail}`);

    // Resume occurs after the original search already wrote its final source
    // summary. Advance that summary with the rows actually gathered now (and
    // clear/replace the original warning) so the bug report cannot call a
    // successful post-challenge pass a zero-result source.
    if (canWriteTelemetry() && jobsTelemetry.search && (!jobsTelemetry.nodeId || jobsTelemetry.nodeId === nodeId)) {
      const bySource = jobsTelemetry.search.bySource || (jobsTelemetry.search.bySource = {});
      const prior = bySource[sourceId] || {};
      // Keep the source funnel in a single dimension: `count` is the number of
      // source rows admitted before the history/evidence gates, so a resumed
      // page must add every extracted row, not only its score-ready
      // survivors. The latter remains a separate `kept`/renderer queue fact.
      bySource[sourceId] = {
        ...prior,
        providerGathered: Math.max(0, Number(prior.providerGathered ?? prior.gathered ?? prior.count) || 0) + gathered,
        count: Math.max(0, Number(prior.count) || 0) + gathered,
        // `unique` means "unique survivors of the dedup" (age-filtered, before
        // history dedup) — the report divides count/unique to conclude that a
        // source re-served clamped pages.
        unique: Math.max(0, Number(prior.unique) || 0) + Math.max(0, ageFiltered.length),
        enrichment,
        warning: warning ? {
          code: warning.code,
          severity: warning.severity,
          evidence: warning.evidence ? String(warning.evidence).slice(0, 700) : null,
        } : null,
        resumeFunnel: {
          extracted: gathered,
          ageDropped,
          historyDropped,
          descriptionEvidenceDropped: descriptionEvidence.dropped.length,
          languageDropped: languageFilter.dropped.length,
          kept: items.length,
        },
      };
    }

    // The original gather pipeline is terminal by the time Continue runs. Keep
    // its terminal state intact while recording the source card's actual resume
    // result in the durable event trail and live renderer progress.
    const resumeStatus = warning?.severity === 'info' ? 'skipped' : warning ? 'error' : 'done';
    const resumeProgress = {
      nodeId,
      sourceId,
      jobRunId,
      status: resumeStatus,
      // This mirrors the initial source-card count: raw rows collected before
      // the downstream role/evidence gates, not only the score-ready subset.
      count: gathered,
      warning,
      completed: 1,
      total: 1,
      detail: `resume: ${funnelDetail}`,
    };
    recordJobSourceProgress(resumeProgress, { updatePipeline: false, expectedNodeId: nodeId });
    if (!event.sender?.isDestroyed?.()) event.sender?.send?.('job-source-progress', resumeProgress);

    if (canWriteTelemetry()) {
      const priorResolveMergeNet = Number(jobsTelemetry.resolves[sourceId]?.cumulativeMergeNet) || 0;
      jobsTelemetry.resolves[sourceId] = {
      ts: Date.now(),
      runId: jobRunId || null,
      kind: 'source-resume',
      resolved,
      cumulativeMergeNet: priorResolveMergeNet,
      hasMergeTelemetry: jobsTelemetry.resolves[sourceId]?.hasMergeTelemetry === true,
      passTimestamps: nextResolvePassTrail(jobsTelemetry.resolves[sourceId]),
      extracted: extracted.length,
      relevanceDropped: 0,
      relevanceRejected: [],
      ageDropped,
      historyDropped,
      historyDropSamples,
      kept: items.length,
      languageDropped: languageFilter.dropped.length,
      descriptionEvidenceDropped: {
        total: descriptionEvidence.dropped.length,
        deferred: descriptionEvidence.quality.deferred,
        empty: descriptionEvidence.quality.empty,
        short: descriptionEvidence.quality.short,
        bySource: descriptionEvidence.quality.bySource,
        samples: descriptionEvidence.quality.samples,
      },
      enrichment,
      warning: warning ? { code: warning.code, severity: warning.severity } : null,
      };
    }
    recordResumeAttempt(sourceId, attemptMode, resolved ? 'resolved' : 'blocked', warning?.code ? `warning: ${warning.code}; ${funnelDetail}` : funnelDetail);
    return {
      resolved,
      items,
      // The renderer owns the score-ready merge, but its visible collected
      // counter must retain this raw source-returned dimension. In the real
      // 307 + 90 resume case, only 8 rows are score-ready while all 90 were
      // still collected and must be reflected in the 397 total.
      gatheredCount: gathered,
      warning,
      // Append semantics, same as the generic resolve return: a resumed page
      // contributes rows, so only an explicitly retired listing may retire one
      // the renderer already holds. See retiredListingKeys.
      removedItemKeys: retiredListingKeys(descriptionEvidence.dropped, boardClosedRetirement(officialResolution)),
    };
  }, { beforeReply: checkpointContinuationBeforeReply('resume-job-source'), captureListingLiveness: true });

  // Renderer calls this after it merges captcha-resolve items into pendingJobs.
  // The IPC-side `resolve-job-source` only knows about history-dedup; the
  // renderer does a replace-and-dedup (drops same-source existing jobs, then
  // deduplicates incoming items against the remainder). Without this update the
  // bug report shows "new: N" from the IPC side, which can overstate the actual
  // contribution when the resolver re-opened the same page as the initial scrape
  // (kept=11 from IPC but pendingJobs 28→28 because 11 replaced 11).
  ipcMain.handle('record-resolve-merge', (_event, { sourceId, nodeId = null, jobRunId = null, replacedExisting, fresh, pendingBefore, pendingAfter } = {}) => {
    return recordResolveMergeOutcome(
      sourceId,
      { replacedExisting, fresh, pendingBefore, pendingAfter },
      { nodeId, jobRunId },
    );
  });
}
