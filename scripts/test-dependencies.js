// Shared imports for the deterministic test groups. Keep application imports here so
// individual area files declare only the bindings their tests actually exercise.
export { default as fs } from 'node:fs';
export { default as path } from 'node:path';
export { runJobApiProbe } from './run-api-tests.js';
export { __discardJobAnalysisSnapshotForTests, __getJobAnalysisRetirementStateForTests, __saveJobAnalysisSnapshotForTests, buildResolvedDescriptionWarning, buildRoleFamilyBatchResearchPrompt, getJobSourceResolveConfig, mergeRecoveredScoreRows, packCompensationAssessmentBatches, packCompensationResearchBatches, planPartialScoreRecovery, planRoleFamilyAssessmentBatches, planRoleFamilyResearchBatches, reconcileSearchFunnel, validateJobScoringSubmission } from '../electron/ipc/jobs.js';
export { JSDOM } from 'jsdom';
export * as PDFLib from 'pdf-lib';
export { PDFDocument } from 'pdf-lib';
export { EBAY_ACTIVE_EXTRACTOR, EBAY_SOLD_EXTRACTOR, MERCARI_SOLD_EXTRACTOR, POSHMARK_SOLD_EXTRACTOR, SWAPPA_SOLD_EXTRACTOR, priceChartingQuery } from '../electron/extractors/marketplace.js';
export { GLASSDOOR_EXTRACTOR, GOOGLE_JOBS_EXTRACTOR } from '../electron/extractors/jobs.js';
export { __analysisPathsForCurrentRequestForTests, __canPerformJobSourceActionForTests, __canWriteJobResolveTelemetryForTests, __consumeRecoveryBlockedUrlForTests, __createDescriptionRecoveryCheckpointForTests, __discardOwnedJobRunForTests, __formatJobAnalysisPromptForTests, __getJobsTelemetryForReportForTests, __loadDescriptionRecoveryCheckpointForTests, __loadJobAnalysisSnapshotForTests, __queryFanOutForTests, __recordJobSourceResolvePassForTests, __recordResumeAttemptForTests, __removeDescriptionRecoveryCheckpointForTests, __resetJobsTelemetryForTests, __restoreJobsTelemetryIfCurrentRunForTests, __saveDescriptionRecoverySnapshotIfCurrentForTests, applyFinalJobTitleRelevanceGate, assessDescriptionRecoverySnapshotOwnership, authenticatedIndeedScrapeStatus, buildJobAnalysisSnapshot, buildJobRunCompletionReceipt, buildJobTasks, calibratedScoreForJob, canRecoverGatheredRunDirectly, careerInputFingerprint, careerProfileFingerprint, chunkScoringBatches, compensationAssessmentCacheMatchesResearch, compensationResearchFingerprint, createDescriptionRecoveryMutex, extractExecutedGoogleQueryStrings, getJobsTelemetry, glassdoorPostedBucket, indeedWarningRequiresManualVerification, inspectJobBoardRoleByIndex, isLiveDescriptionRecoveryRun, JOB_DESCRIPTION_EVIDENCE_MIN_CHARS, linkedInBrowserUnavailableWarning, linkedInSameIpRetryDecision, listDescriptionRecoveryCheckpointsSync, mergeDescriptionRecoverySourceJobs, mergeResolvedDescriptionRecoveryCandidate, nativeChallengeTerminalDisposition, nextDescriptionRecoveryGuidance, normalizeJobBoardRoleByIndex, orderedBlockedManualSourceUrls, parseCompensationResearchSections, partitionResolvedDescriptionRecoveryCandidates, prepareLiveScoringResults, reconcileResolvedDescriptionRecovery, reconcileTitleRelevanceFunnel, recordJobSourceProgress, recordJobsBoardScope, recordJobsSourceScope, recordLinkedinResolveAttempt, recordResolveMergeOutcome, refreshManualSourceUrlIndex, runRewindableGroundedHandoff, snapshotDescriptionRecoveryJobs, summarizeScoringInputQuality, validateCompensationEvidenceBatchSubmission, validateCompensationEvidenceSubmission, validateExactResumeRun, validateJobBoardRoleTaxonomy, validateRoleFamilyExperienceBandsBatchSubmission, validateRoleFamilyExperienceBandsSubmission } from '../electron/ipc/jobs.js';
export { getJobSearchTransientKeysForSave, JOBBOARD_TRANSIENT_KEYS, SELLHUB_TRANSIENT_KEYS, TRANSIENT_PROCESSING_HUB_STATES } from '../src/utils/persistenceTransientState.js';
export { jobTitleCompanyKey, jobTitleCompanyUrlKey, jobTitleCompanyLocationKey, sourceJobKey, dedupeJobsByKey, uniqueJobsNotIn, dedupJobsAcrossSources, uniqueJobsAcrossSources } from '../src/utils/jobIdentity.js';
export { createSourceProgressRunGuard, mergeSourceProgress, isTerminalSourceStatus } from '../src/utils/sourceProgress.js';
export { buildExactTargetRoleQueryBundle, buildPinnedTitleQueryBundle, flattenJobSearchQueries } from '../src/utils/jobSearchQueries.js';
export { canAttemptJobSourceResolve, descriptionRecoveryCheckpointWriteFailureWarning, filterHandledJobSourceWarnings, isDescriptionRecoverySourceWarning, isDescriptionRecoveryWarningCode, isJobSourceResolveBusyHubState, isJobSourceWarningGating, jobSourceWarningAction, reconcileJobSourceWarnings } from '../src/utils/jobSourceWarningPolicy.js';
export { createRunOwnershipGuard } from '../src/utils/runOwnership.js';
export { applyManualAiRetirementReceiptsToNodes, collectDeletedJobAnalysisDiscards, collectDeletedJobRunDiscards, isSafeJobAnalysisCleanupNoop } from '../src/utils/canvasInteractions.js';
export { isJobCardVisible } from '../src/utils/jobCardFilters.js';
export { explicitSalaryCurrency, inferSalaryCurrency, formatSalaryCurrencyLabel } from '../src/utils/salaryCurrency.js';
export { buildScoredJob } from '../electron/ipc/jobBatchReconcile.js';
export { calculateDatedTenure, validateAndNormalizeFitAssessment } from '../electron/ipc/jobFitAssessment.js';
export { buildScoringAudit, scoringAuditRowsFromBatches } from '../electron/ipc/scoringAudit.js';
export { buildJobScoringRequestParts } from '../electron/ipc/jobScoringCache.js';
export { isProfileLockCollision, recordLaunchCollision, getLaunchCollisions, _resetLaunchCollisions } from '../electron/ipc/browserLaunchTelemetry.js';
export { detectAntiBotSignal, matchesNoResultsSentinel, detectApiAntiBotSignal, safeApiFetch } from '../electron/ipc/antiBotDetector.js';
export { cancellationError, nodeCancellationError } from '../electron/ipc/ipcUtils.js';
export { getStats, getStatsSignature } from '../src/utils/dashboardStats.js';
export { resolveNodePresence } from '../src/utils/nodePresence.js';
export { ALL_COMP_SOURCE_IDS, CANVAS_ZOOM_LIMITS, getNodeDims, getNodesBounds, SELL_PLATFORMS, SELL_PLATFORM_BY_ID } from '../src/utils/constants.js';
export { mergeSourceIntoComps, retryWarningRequiringAction, updateResolvedSourceWarning } from '../src/utils/compsMerge.js';
export { mergeResolvedSourceItems } from '../src/utils/jobSourceResolveMerge.js';
export { collectMarketplaceListings, marketplaceListingsSignature } from '../src/utils/marketplaceStatusScan.js';
export { bestMarketplaceStatusColumnCount, MARKETPLACE_STATUS_GRID, marketplaceStatusNodeWidth } from '../src/utils/marketplaceStatusLayout.js';
export { normalizeMarketplaceWatchUrls } from '../src/utils/marketplaceWatchUrls.js';
export { deepUpdateNode, deepAddElements, getCanvasData } from '../src/utils/navigationUtils.js';
export { buildCustomizationDialogData, filterNodeCustomizationUpdates, nodeSupportsCustomization } from '../src/utils/nodeCustomization.js';
export { buildJobTreeNodes, clearRestoredJobTreeLayout, computeLayoutPositions, computeJobTreeView, countMatchingDescendantCards, COL_X, canonicalSalaryRangeLabel, normalizeBandsWithRepairs, normalizeRangesWithRepairs, parseSalaryToNumeric, salaryRangeAnomaly, salaryRangeMetadata, sanitizeJobTaxonomy, shouldReflowMeasuredJobCard } from '../src/nodes/jobsearch/buildJobTree.js';
export { attachCompensationRemoteResidences, unionScoredJobs, moduleFingerprint, combineSignature, staleReason, isLegacyCombineSignature, deriveBoardCardStats } from '../src/nodes/jobboard/mergeJobs.js';
export { buildGeoTermSet, extractIndeedJobsFromHtml, extractSalaryFromText, filterWholeFeedJobsByTitleRelevance, jobRelevanceMatch, jobRelevanceEvidence, jobRelevanceRejection, reverbListingsToComps, parsePriceChartingHtml, filterPriceChartingByRelevance, dicePostedBucket, fetchDiceListings, extractJobPostingDescription, extractJobPostingBaseSalary, formatDiceBaseSalary, extractDiceSalaryBadge, formatUSAJobsSalary, formatRemoteOkSalary, fetchLinkedInJobs, fetchRemoteOKJobs, linkedInApiRequestPacing, linkedInDescriptionPacing, linkedInPacingWaitMs, linkedInPageStopReason, remoteOkTagsFromQueries, runApiTransportRetry, shouldRetryApiTransportFailure, wwrCategoriesFromQueries, parseAptDecoComps, extractAlgoliaHits, linkedInBrowserUnavailableResult, isRemoteOkSponsoredPlacement, isPlaceholderIndeedJobKey } from '../electron/extractors/apiExtractors.js';
export { isPriceChartingApplicable, isAptDecoApplicable } from '../src/utils/compSourceScope.js';
export { assertCandidateDashPunctuation, buildResumeDocument, buildCoverLetterDocument, embedApplicationSyncConfig, extractVariantAttrs, getDesignSystemDir, isDualMode, decodeTextEscapes, normaliseResumeDownloadBundle, sanitizeDocumentMainHtml, webFontFacesReadyExpression } from '../electron/ipc/resumeHtml.js';
export { applyDualPdf, atsSafePdfFontExpression, fixedPageTypeAreaHeight, pageTextMeasurementExpression, pdfContainsType3Fonts } from '../electron/ipc/resumeRender.js';
export { __applicationSyncStatePathForTests, __captureApplicationSyncWorkspaceIdentityForTests, __loadApplicationSyncWorkspacesForTests, __normaliseApplicationSyncWorkspaceForTests, __readApplicationSyncWorkspaceHtmlForTests, __reconcileApplicationSyncWorkspaceForTests, __resetApplicationSyncWorkspacesForTests, __syncApplicationSyncWorkspaceForTests, __verifyApplicationSyncWorkspaceIdentityForTests, __withApplicationSyncWorkspaceLockForTests, applicationSyncConfig, getApplicationSyncTelemetry, inspectApplicationSyncRevision, mergeSelectedApplicationPanel, recordApplicationSyncTelemetry, registerApplicationSyncWorkspace } from '../electron/ipc/applicationSync.js';
export { formatOriginalJobListingMarkdown, sanitizeApplicationBundlePart } from '../electron/ipc/applicationBundle.js';
export { GENERATION_AUDIT_VERSION, applicationVariantAttrsForJob, assertRetainedResumeRoleBullets, checkResumeBulletFocus, checkResumeBulletLength, careerDataRoleLocation, evaluateResumeProseChecks, extractResumeEvidence, formatUnderfilledTypeAreaUtilization, inspectApplicationExport, inspectGeneratedApplicationPdf, isPendingApplicationWorkspaceSaveInFlight, normalizeApplicationAdditionalNotes, readRegisteredApplicationArtifact, registerJobApplicationHandlers, registerPendingApplicationWorkspace, resumeProjectProvenanceFailures, resumeRoleBlockSample, resumeRoleLocationFailures, retainedResumeRolesWithoutBullets, getApplicationTelemetry, recordApplicationTelemetry, resolvePendingApplicationWorkspaceForOwner, targetPageCountForJob, resumeIsMateriallyUnderfilled, resumeTypeAreaUtilization, withUnregisteredApplicationWorkspacePruneClaim } from '../electron/ipc/jobApplication.js';
export { applicationConvergenceInstruction, createApplicationConvergenceTracker, expectedApplicationQualityDecision } from '../electron/ipc/applicationConvergence.js';
export { LOCAL_AI_APPLICATION_VERSION, assertSourceQuoteLinksFinalText, sanitizeQualityReview, buildLocalGenerationAuditArtifact, getLocalApplicationHandoff, queueLocalApplicationJob, discardLocalApplicationJob, discoverLocalApplicationJobs, localApplicationStatus, importLocalApplicationJob, registerLocalAiApplicationHandlers, resolveLocalOutputBundleRoot, submitLocalApplicationHandoff, validateLocalApplicationResult, withLocalAiJobPruneClaim } from '../electron/ipc/localAiApplication.js';
export { LOCAL_AI_FALLBACK_IDLE_STATUSES, LOCAL_AI_CARD_POLL_IDLE_STATUSES, LOCAL_AI_JOB_INTEGRITY_ERROR_CODE, brokenLocalAiJobDriveState, jobIntegrityFailureMessage, registerMountedJobCard, unregisterMountedJobCard, isJobCardMounted, selectFallbackLocalAiJobs, selectOrphanedLocalAiJobs } from '../src/utils/localAiFallback.js';
export { canRegenerateLocalApplication, canSaveImportedLocalApplication, queuedLocalApplicationSettlement, replacedLocalApplicationForCleanup } from '../src/utils/localAiApplicationLifecycle.js';
export { collectNodesDeep } from '../src/utils/navigationUtils.js';
export { replaceApplicationBundleAtomically } from '../electron/ipc/applicationFileTransaction.js';
export { LEDGER_CAP, MINING_TARGET, splitCareerDataByFile, normalizeQuoteText, computeLedger, applyRefuteVerdicts, ledgerById, derivationTooltip } from '../src/utils/achievementLedger.js';
export { createEmptySkillOpportunityHistogram, normalizeOpportunityName, assertValidSkillOpportunityHistogram, migrateSkillOpportunityHistogram, mergeSkillOpportunityAnalysis, replaceSkillOpportunityAnalysis } from '../src/utils/skillOpportunityHistogram.js';
export { skillOpportunityHistogramFilePath, loadSkillOpportunityHistogram, recordSkillOpportunityAnalysis, __resetSkillOpportunityHistogramCacheForTests } from '../electron/ipc/skillOpportunityStore.js';
export { fingerprint, persistenceContentFingerprint, migrateGroupNodes, migrateLegacyJobHubResults, migrateMarketplaceCardCreatedAt, migrateJobHubPageCeiling, migrateStaleJobHubInputLock, migrateInterruptedJobHubResults, migrateRetiredBatchScoringState, migrateMergedTargetRoleIntoBrief, migrateJobHubTitleSourceSingleMode, runNodeMigrations, CURRENT_SCHEMA_VERSION, sanitizeEdgesForSave, sanitizeNodesForSave } from '../src/utils/serializationUtils.js';
export { calculatePriceDropSuggestion, createdAtMsFromCardId, isPriceDropReminderDue, MS_PER_WEEK, normalizePriceDropMustSellDate, normalizePriceDropReminderWeeks, normalizePriceDropStartingPrice, normalizePriceDropStartingTier, normalizePriceDropTargetPrice, oldestPriceDropCardCreatedAtIso, priceDropDeadlineReminderDelayMs, priceDropStartingPrice, priceDropReminderDelayMs, priceDropReminderCountThroughMustSell, priceDropMustSellDateMs, priceDropMustSellDayEndMs, resolvePriceDropStartingTier } from '../src/utils/priceDropReminder.js';
export { matchesQuery, nextSearchMatchIndex } from '../src/utils/searchMatch.js';
export { cancelTimeout, replaceTimeout } from '../src/utils/latestTimeout.js';
export { hasActiveExternalRunState, mergeNonRestorableEdgesFromLive, mergeNonRestorableNodeDataFromLive } from '../src/utils/undoNonRestorableState.js';
export { collectOrphanTextDocumentPaths, collectRemainingTextDocumentPaths, collectSurvivingRepresentedPaths, collectTrashEligiblePaths } from '../src/utils/osDeletionPaths.js';
export { cloneNode, reassignCanvasDataIDs } from '../src/utils/nodeFactory.js';
export {
  createTextDocumentSessionRegistry,
  textDocumentFromTextarea,
  textDocumentNewlineStyle,
  textDocumentToTextarea,
} from '../src/utils/textDocumentSessions.js';
export { BACKGROUND_E2E_DISABLED_CODE, BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS, backgroundE2EDisabledError, isBackgroundE2E, runBackgroundE2EShutdownCleanup } from '../electron/utils/backgroundE2e.js';
export { redactNodeForIssueReport } from '../src/utils/issueReportRedaction.js';
export { buildHubHoverState, filePayloadFromDraggedNodes } from '../src/utils/hubNodeDrop.js';
export { resolveHubDropCue } from '../src/utils/hubDropCue.js';
export { distToSegment, pixelEraseStroke, segmentCircleIntersections, strokePoints } from '../src/utils/geometry.js';
export { edgeZoneForRadius, fitViewDuration, gridSpacing, panDuration, radialRadius, spiralStep, viewportForZoomAtScreenPoint } from '../src/utils/layoutGeometry.js';
export { computeTidiedNodes, findNonOverlappingPlacement } from '../src/utils/layoutUtils.js';
export { FILE_CATEGORIES, getFileCategoryInfo, toLocalFileUrl } from '../src/utils/fileDisplayUtils.js';
export { isProductImageExtension } from '../src/utils/fileExtensions.js';
export { parsePostedDate, filterJobsByAge, POSTED_DATE_PATTERN } from '../electron/ipc/jobDateFilter.js';
export {
  compsForPricing,
  compensationCohortAssessmentFits,
  compensationCohortAssessmentMaxTokens,
  roleFamilyAssessmentMaxTokens,
  jobPreferenceResearchAssessmentMaxTokens,
  jobPreferenceResearchMaxTokens,
  jobScoringBatchFits,
  jobScoringBatchSize,
  jobScoringEstimatedTokens,
  jobScoringMaxTokens,
  listingEvaluationBatchSize,
  listingEvaluationMaxTokens,
  marketplaceHubScanBatchEstimatedTokens,
  marketplaceHubScanBatchFits,
  marketplaceHubScanMaxPagesForPlatform,
  priceSynthesisBatchEstimatedTokens,
  priceSynthesisBatchFits,
  priceSynthesisBatchMaxComps,
  priceSynthesisBatchMaxTokens,
  priceSynthesisMaxTokens,
  COMPENSATION_MIN_FIT_SCORE,
} from '../electron/ipc/resultCaps.js';
export { JOB_COLLECTION_LIMITS_DEFAULT, JOB_COLLECTION_LIMITS_MAX, JOB_COLLECTION_PAGE_CEILING, normalizeJobCollectionLimits, isUnlimitedPages, resolvePageCeiling, describeJobCollectionLimits } from '../src/utils/jobCollectionLimits.js';
export { normalizeEnabledJobSourceIds, getEnabledJobSourceIds, getJobPlatformSelectionStatus, getRunnableJobSourceIds } from '../src/utils/jobPlatformSelection.js';
export { getJobCollectionSafetyForMode, getJobPlatformSafety, getUnsafeJobPlatformIds } from '../src/utils/jobPlatformSafety.js';
export { makeJobPageStop, STOP_STREAK, MIN_DATED_EVIDENCE } from '../electron/ipc/jobPageStop.js';
export { groundedMetadataUrls } from '../electron/ipc/groundedSourceAppendix.js';
export { parseAiJson } from '../electron/ipc/jsonRepair.js';
export { assertResponseMatchesSchema, assertResponseSchemaVocabularySupported, auditResponseSchemaVocabulary, canonicalizeResponseSchemaEnums, validateResponseSchema } from '../electron/ipc/schemaValidation.js';
export { withSharedProfileLock, getSharedProfileLockSnapshot } from '../electron/ipc/sharedProfileLock.js';
export { withStatusCheckLock, getStatusCheckQueueDepth } from '../electron/ipc/statusCheckLock.js';
export { withMarketplaceBrowserLock, getMarketplaceBrowserQueueDepth } from '../electron/ipc/marketplaceBrowserLock.js';
export { createAggregatingProgress } from '../electron/ipc/compProgressAggregator.js';
export { buildFinalListingTitle, buildRefreshResearchItems, buildResearchItems, computeBundleTotal, recoverRefreshExtraItems, selectBundleHeadline, selectListingPriceTiers, buildItemQuery, bundleSynergyForPrices, deriveBundlePricingResult, normalizeBundlePricingResult } from '../src/utils/bundlePricing.js';
export { clearMissingPreviewRelinkCache, clearMissingPreviewRelinkDiagnostics, clearMissingPreviewSearchRoots, findExactFilenameBelow, getMissingPreviewRelinkDiagnostics, rememberMissingPreviewSearchRoot, resolveMissingPreviewPath } from '../electron/ipc/missingPreviewRelink.js';
export { assertDeleteTargetNotRepresented, atomicWriteFile, cleanupStaleOwnedTempFiles, createFileWatchRegistry, readValidatedTextFile, registerFilesystemHandlers, resolveAllowedOpenFilePath, resolvePortableFilePaths, resolvePortableImagePath, isAllowedOpenFileExt, syncTextParentDirectory, validateMutablePath, writeValidatedTextFile } from '../electron/ipc/filesystem.js';
export { __runWithIpcRequestContextForTests, abortNodeTasks, abortNodeTasksAndWait, handleSafe, snapshotActiveNodeTasks } from '../electron/ipc/ipcUtils.js';
export { isTrustedCanvasNavigation } from '../electron/canvasNavigation.js';
export { decodeLocalFileRequestPath } from '../electron/localFileProtocol.js';
export { getBrowserPoolQueueState, pauseBrowserPool, queueScrape, readPageContentBounded } from '../electron/ipc/browserPool.js';
export { buildTrustedNativeLoginVerdict, getSoftLoginWallMatch, getStatusCacheSync, isConfirmedDisconnectedVerdict, clearAllSessionStatusCache, selectRestorableStatuses, isTrustedNativeLoginResult, writeStatusCache } from '../electron/ipc/accounts.js';
export { closeOwnedBrowserProcess, getIndeedSessionResetOrigins, getJobLoginConfig, getJobLoginPlatforms, getSellMonitorConfig, isIndeedCookieDomain, reserveSharedProfile, toPuppeteerExtraAbortSignal } from '../electron/ipc/stealthBrowser.js';
export { default as os } from 'node:os';
export { startRun, recordSourcePage, markSourceStatus, setStage, readStagedJobs, readRunState, clearRun, clearRunWithResult, completeRunWithReceipt, computeResumeStartPage, jobRunPathScopeForCanvas, lastRunReceiptPathForCanvas, readLastRunReceipt, normalizeJobRunProfileFingerprint, sanitizeJobPreferencePlan, sanitizeJobPreferences, sanitizeLastRunReceipt, writeLastRunReceipt, RESUMABLE_MAX_AGE_MS } from '../electron/ipc/jobRunStaging.js';
export { blankJobPreferencePlan, evaluateJobPreferences, hasJobPreferences, interpretJobPreferences, isValidJobPreferencePlanSubmission, listingIdsForRootBatch, normalizeJobPreferencePlan, normalizeJobRoleAudit, resolveSearchRoles, screenJobRolesByTitle, validateJobPreferenceListingSubmission, validateJobPreferencePlanSubmission, validateJobPreferenceResearchSubmission, validateJobRoleAuditSubmission } from '../electron/ipc/jobPreferences.js';
export { dedupAgainstHistory, dedupKeysFor, filterHistoryForResume, appendJobsHistory, loadJobsHistory } from '../electron/ipc/jobsHistory.js';
export { clipReportText, modelTag, overPricedSoldFlag, redactReportEventHistoryLine, redactReportUrlsInText, renderSessionTraceBlocks, visitCanvasNodes } from '../electron/ipc/bugReport/helpers.js';
export { looksLikeMoney, classifyUnparseableSalary, mojibakeExcerpt } from '../electron/ipc/bugReport/jobQualityChecks.js';
export { buildMarketplacePipelineSnapshot } from '../electron/ipc/bugReport/marketplaceSnapshot.js';
export { buildJobCompletionAssessment, buildJobRecoverySnapshot, buildJobsPipelineSnapshot, buildNonApiAiHandoffLifecycleMarkdown, collapseConsecutiveIdentical, formatChallengeTextEvidence, formatSourceEvent, formatGlassdoorCacheProvenance, formatPipelineState, postPipelineRecoveryAttemptCount } from '../electron/ipc/bugReport/jobsSnapshot.js';
export { getJobAnalysisPaths } from '../electron/ipc/jobAnalysisPaths.js';
export { buildNativeChallengeHistoryEvidence, generateMarkdown, registerBugReportHandlers } from '../electron/ipc/bugReport.js';
export { formatJsonLdSalary, extractZipRecruiterDomSalaryText, glassdoorRequestedCountry, glassdoorUrlHasLocationId, glassdoorLocationProof, isGlassdoorCanonicalResultsUrl, parseClaimedResultTotal, zipRecruiterSearchPageNumber, shouldTryZipRecruiterDirectContinuation, REVEAL_STABLE_PASSES, validateGlassdoorLocationPick, glassdoorCachedLocationUsable, upgradeGlassdoorCountryRootCache, glassdoorLookupAttemptIsTransient, classifyGlassdoorLookupFailure, summarizeGlassdoorLookupAttempts, describeGlassdoorLocationFailure, reconcileZipRecruiterDomSalary, mergeExpandedJobDetail, extractGlassdoorPanelResponseDetail, mergeGlassdoorPanelDetail, glassdoorPanelResponseIdentity, normalizeDetailNavigationUrl, pinGlassdoorDetailUrlToListHost, ADVANCE_CONTROL_LABEL_PATTERNS, isDetachedDetailFrameError, hasManualVerificationText, hasManualHardBlockText, classifyManualChallengeSignals, CHALLENGE_INTERSTITIAL_MAX_CHARS, challengeHeartbeatIntervalMs, resolveManualChallengeTransition, resolveManualDetailChallengeDisposition, shouldNavigateForDescription, descriptionNavigationDecision, isZipRecruiterClosedDetailRedirect, isUnavailableDetailPage, zipRecruiterRetryAfterMs, isAppcastTemporaryRestriction, zipRecruiterAppcastRestrictionBackoffMs, isZipRecruiterDetailErrorShell, zipRecruiterDetailErrorShellBackoffMs, resolveManualSourceStopReason, didDetailBlockReprobeRecover, composeDetailBlockReprobeResult, recordIssuedManualQuery, recordManualScraperTelemetry, getManualScraperTelemetry, resetManualScraperTelemetry, recordActivityBeat, setActivitySink, scrapeManualSources, isIgnorableManualBrowserTelemetry, mergeDescriptionDetailMissWarning, extractGoogleApplyCandidatesFromDocument, buildDescriptionCardTargets, buildPhysicalCardWalkPlan, descriptionExpansionStrategy, descriptionPanelPacing, descriptionPanelRetryAllowed, selectGoogleApplyUrl, inspectDescriptionCardTargetAvailability, readDescriptionCardDomKey, readDescriptionPanelText, assessDetailSelection, assessDescriptionPanelUpdate, isGlassdoorPanelRateLimitResponse, isGoogleDescriptionPanelRateLimitResponse, readActiveGoogleDetailTitle, inspectGlassdoorOpportunityModal } from '../electron/ipc/browser/manualScraper.js';
export { filterJobsByDescriptionEvidence } from '../electron/ipc/jobs.js';
export { buildOverlayScript } from '../electron/ipc/browser/scraperOverlay.js';
export { acceptIndeedScoreSafeDescription, classifyIndeedSessionPreflight, indeedHostForLocation, isIndeedScoreSafeDescription, needsIndeedDescriptionRetry, recordIndeedEnrichmentAttempt, shouldHandoffIndeedChallengeToNative } from '../electron/extractors/indeedBrowser.js';
export { classifyCompScrapeFailure, computeMissingLogins, filterGrosslyOffTargetSources, formatPricingNotesForPrompt, getMarketplaceTelemetry, normalizePricingNotes, routeLegacyPriceSynthesisHandoff } from '../electron/ipc/marketplace.js';
export { deriveHubScanStatus, resolveAttentionSourceUrls, prepareHubPages, scanPreparedHubPages, annotateReadState, summarizeReadState, stripHtmlForAnalysis, stripReadStateTokens, READ_STATE_READ_TOKEN, READ_STATE_UNREAD_TOKEN } from '../electron/ipc/listingStatusCheck.js';
export { canAuthCookieBypassLoginUrl, classifyNativeIndeedChallengeTab, classifyVisibleWindowNavigation, createNonOverlappingRunner, getLoginAutoCloseWaitReason, isAuthChallengeUrl, isBrowserProcessExited, isNativeIndeedChallengeCleared, isNativeIndeedChallengeHardBlock, isNativeIndeedChallengePending, nativeIndeedChallengeIsStalled, isPostLoginInterstitialUrl, isStrictIndeedHttpsUrl, nativeIndeedChallengeExitDisposition, nativeIndeedChallengeTabIdentity, selectNativeIndeedChallengeTab, shouldAutoCloseCaptchaResolveWithoutExtractor, validateVisibleWindowUrl, visibleWindowLaunchOptions, waitForBrowserProcessExit, PLATFORM_AUTH_COOKIES, PLATFORM_COOKIE_DOMAINS, PLATFORM_AUTH_GATED_URLS, PLATFORM_LOGIN_URLS, PUPPETEER_OSCRYPT_PARITY_ARGS, CAPTCHA_RESOLVE_CHALLENGE_SELECTORS, cookieListHasAuth, isNativeLoginSuccess, isLoggedOutTitleForPlatform, isInlineLoginPlatform, NATIVE_LOGIN_PLATFORMS, unwrapInlineExtractorItems, areCaptchaResolveHostsEquivalent, captchaResolveHostMismatchDiagnostic, buildAuthAttemptRecord, isLoginUrlPath, profileCookieStorePaths, hasProfileCookieCommitAdvanced } from '../electron/ipc/browser/authWindows.js';
export { APPLICATION_COVER_LETTER_SCHEMA, APPLICATION_DIRECT_COVER_LETTER_SCHEMA, JOB_TAXONOMY_CLASSIFY_SCHEMA, JOB_TAXONOMY_PLAN_SCHEMA, JOB_SCORING_SCHEMA, LETTER_GROUNDING_AUDIT_SCHEMA, LETTER_NEEDS_SCHEMA, LETTER_PLAN_SCHEMA, PRICE_SYNTHESIS_SCHEMA, RESUME_PARSE_SCHEMA } from '../electron/ipc/aiSchemas.js';
export { JOB_TAXONOMY_CHUNK_SIZE, buildJobTaxonomyPlanSummary, inspectJobTaxonomyRoleIndexes, normalizeJobTaxonomyPlan, validateJobTaxonomyPlan, runBoundedJobTaxonomy } from '../electron/ipc/jobTaxonomy.js';
export { deriveLocationParam, summarizeLocationAdherence, pickGlassdoorLocation, describeLocationTreatment, LOCATION_TREATMENT } from '../src/utils/jobLocation.js';
export { detectLanguage, tagJobLanguage, tagJobLanguages, summarizeJobLanguages } from '../src/utils/jobLanguage.js';
export { reconcileGlassdoorSalaryFromDescription } from '../src/utils/jobSalaryReconciliation.js';
export { repairMojibake, hasMojibake, repairJobsMojibake, normalizeJobMarkup, normalizeJobsMarkup, decodeHtmlEntities, stripHtmlToText } from '../src/utils/textEncoding.js';
export { foldVerificationSample, orderByVerification, verificationScore } from '../src/utils/scrapeOrder.js';
export { JOBHUB_CAREER_IDENTITY_FIELDS, buildJobHubCareerClearPatch, canHubAcceptInitialDrop, canSellHubAcceptDisplayPhotoDrop, canSellHubReplaceFailedInitialPhotos, getHubDropRejectLabel, getHubFileDropMode, hubHasAcceptedInitialDrop } from '../src/utils/hubDropEligibility.js';
export { applyBugReportCode, previewBugReportCode } from '../src/utils/bugReportCodes.js';
export { buildFilterSummaryMarkdown, codeIncludesFull } from '../electron/ipc/bugReport/filterSummary.js';
export { buildMainProcessLogsMarkdown, newestFirstLogLines, timestampedLogLines } from '../electron/ipc/bugReport/clipboardCap.js';
export { buildSellHubPriceDropRollup } from '../electron/ipc/bugReport/sellHubPriceDropRollup.js';
export { buildSellHubResolveRollup, buildSellHubResolveSnapshot } from '../src/utils/sellHubResolveSnapshot.js';
export { createJobSearchTestMode, parseJobSearchEnvBoolean } from '../src/utils/jobSourceScope.js';
export { createMarketplaceTestMode, parseMarketplaceEnvBoolean, getScopedCompSourceIds, isCompSourceEnabledInScope, normalizeCompWarnings } from '../src/utils/compSourceScope.js';
export { getJobAuthPreflightSourceIds, JOB_AUTH_PREFLIGHT_SOURCE_IDS } from '../src/utils/jobAuthPreflight.js';
export { getMarketplaceHubStatusLabel } from '../src/components/monitorStatusLabels.js';
export { appendPhotoFiles, appendPhotoPaths, normalizePhotoPathList, removePhotoPathAt } from '../src/utils/photoPathList.js';
export { filesToDropPayloads, filesToProductImagePaths, getLocalFilePath, summarizeFileExtensions } from '../src/utils/fileDropUtils.js';
export { buildMarketplaceModuleRollup } from '../electron/ipc/bugReport/marketplaceModuleRollup.js';
export { NATIVE_READ_PLATFORMS, shouldUseNativeRead, isAppleEventsJsDisabledError, nativeReadLooksChallenged, nativeReadLooksLoggedOut, parseNativeReadOutput, nativeReadToFetchResult, nativeReadLoginState, withAppleEventsJsEnabled, ensureAppleEventsJsEnabled } from '../electron/ipc/browser/nativeChromeReader.js';
export { shouldUseNativeTextUndo } from '../src/utils/nativeTextUndo.js';
export { matchesRedoShortcut } from '../src/utils/keyboardShortcuts.js';
export { syncUncontrolledTextValue } from '../src/utils/uncontrolledTextValue.js';
export { enqueueUniqueSourceResolve } from '../src/utils/sourceResolveQueue.js';
export { getRequiredCompLoginPlatformIds } from '../src/utils/marketplaceLoginPreflight.js';
export { createModuleRunQueue } from '../src/utils/moduleRunQueue.js';
export { deleteChildrenByHubId } from '../src/nodes/_shared/hubChildCleanup.js';
export { getConnectedHubCards } from '../src/utils/connectedHubCards.js';
export { getCanonicalDomain, extractDomain, effectiveConcurrency, isCoolingDown, recordOutcome, getRateLimiterSnapshot, _resetRateLimiter } from '../electron/ipc/rateLimiter.js';
export { encryptSecret, decryptSecret, getRoleFamilyExperienceBandCache, normalizeRoleFamilyExperienceBandCache, roleFamilyExperienceBandCacheEntry, saveRoleFamilyExperienceBandsBatch, mergeSettingsSection, getGlassdoorLocIdCache, saveGlassdoorLocId, tryGetStore } from '../electron/ipc/settings.js';
export { callLLMText, callLLMRaw, callLLMVision, callLLMDocument, checkPromptFits, getKnownTaskIds, taskMaxTokensFor, taskModelRoutingSnapshot } from '../electron/ipc/llm.js';
export { NON_API_AI_TRANSPORT, HANDOFF_CODE_ALPHABET, __durableStepKeysForTests, __selectDurableStepForTests, __selectUniqueAcceptedLegacyStepForTests, __nonApiAiProgressScopeSnapshotForTests, __pruneInactiveEphemeralProgressScopesForTests, canonicalizeGeneratedUntrustedBoundaryNonces, deriveHandoffCode, durableRunHasAnyTask, hardenStructuredTaskPrompt, NonApiAiCodeMismatchError, _resetNonApiAiHandoffLifecycle, getNonApiAiHandoffLifecycle, materializeNonApiPrompt, registerNonApiAiHandlers, requestNonApiAi, validateNonApiAiSubmission } from '../electron/ipc/nonApiAi.js';
export { default as electronPkg, ipcMain } from 'electron';
export { wrapUntrustedText } from '../electron/ipc/promptSafety.js';
export { PRODUCT_CONDITIONS, CONDITION_VALUES, DEFAULT_CONDITION, getConditionDef, formatConditionForPricingPrompt, formatConditionGuideForPrompt, stripConditionFromGeneratedTitle } from '../src/utils/productConditions.js';
export { beginMarketplaceStatusRun, completeMarketplaceStatusPlatform, finishMarketplaceStatusRun, getMarketplaceStatusActiveRuns, marketplaceStatusCheckingIds, mergeMarketplaceStatusResults, publishMarketplaceStatusCheckingIds, subscribeMarketplaceStatusCheckingIds } from '../src/utils/marketplaceStatusProgress.js';
export { TIMINGS, autosaveDebounceMs, docSaveDebounceMs, maxUndoHistory } from '../src/utils/timings.js';
export { generateId } from '../src/utils/idGenerator.js';
export { clamp } from '../src/utils/mathUtils.js';
export { LANGUAGE_LABELS, languageLabel } from '../src/utils/jobLanguageLabels.js';
export { getEnvValue, parseScopeEnvBoolean } from '../src/utils/sourceScopeShared.js';
export { pickEdgeHandles, structuralEdge } from '../src/nodes/_shared/edgeHelpers.js';
export { PLAIN_TEXT_EXT, readPlainTextDocument } from '../electron/ipc/docUtils.js';
export { CODE_EXT_RE, PRODUCT_IMAGE_EXT_RE } from '../src/utils/fileExtensions.js';
export { cancelNodeTasksRecursively } from '../src/utils/canvasInteractions.js';
export { deriveTimeoutBudget } from '../electron/ipc/scrapeBudget.js';
export { FINGERPRINT_PROFILES, getSessionProfile, getRandomUA } from '../electron/ipc/browser/antiDetectProfiles.js';
export { ensureDirectoryWithinRoot, isWithinDirectory, isExistingFile, isSensitivePath } from '../electron/utils/pathSafety.js';
export { resetManualSolveTracking, markManualSolveRequired, wasManualSolveRequired } from '../electron/ipc/scrapeVerification.js';
export { checkAdjacentEmployerRepetition } from '../electron/ipc/coverLetterChecks.js';
export { BANNED_GENERIC_PHRASES, BANNED_GENERIC_PATTERNS, COMPOUND_HYPHENATION_RULES, MAX_HYPHENATION_OBSERVATIONS, MAX_LETTER_FIGURES, MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS, MAX_SENTENCE_WORDS, MIN_ANCHOR_RELEVANCE_CORPUS_WORDS, STACK_TOOL_LEXICON, authorCoverLetterEnvelope, checkAdditiveSeam, checkAllNeedDisposition, checkAnchorRelevance, checkArtifactActionCompleteness, checkClaimedEquivalence, checkCompanySpecificity, checkCompoundHyphenation, checkContainerizationTechnologyRoles, checkDanglingParagraphTransition, checkDetachedRelevanceClaim, checkDirectWelcomeClosing, checkEligibilityNeedDisposition, checkEntailedPremise, checkEvidenceGrounding, checkExperienceInfinitiveGrammar, checkFigureDiscipline, checkGenericPhrases, checkInterestFraming, checkIntroductoryWorkplaceComma, checkLogisticsContainment, checkLogisticsExclusion, checkLogisticsGrounding, checkLowInformationToolBuild, checkModifierAttachment, checkNamedArtifactIntroduction, checkNeedGrounding, checkNeedsPortfolio, checkOpeningArtifactContext, checkOpeningDemonstrative, checkOpeningEmployerShorthand, ARGUMENT_MAPPING_REQUIRED_RULE, ARGUMENT_RELEVANCE_ANAPHORA_RULE, ARGUMENT_RELEVANCE_MECHANISM_RULE, checkParagraphArgumentLinks, paragraphArgumentSpanGaps, paragraphHasCandidatePastProof, checkParallelStructure, checkPlainRegister, checkPlanGate, checkPostingReference, checkPriorEmployerOpening, checkPunctuationStyle, checkProspectiveContributionTense, checkRedundancy, checkReferenceClarity, checkRepeatedSentenceShape, sharedSentenceShapeCeiling, MIN_SHARED_SHAPE_PARAGRAPHS, SENTENCE_SHAPE_FRAME_WORDS, SHARED_SENTENCE_SHAPE_CEILING_RULE, checkResponsibilityTransition, checkSalientPhraseEcho, checkRequestedWorkSampleLink, checkRoleThesis, checkSentenceLength, checkShape, checkTargetClaimScope, checkToolCallsGardenPath, checkTopNeedDisposition, checkVagueDomainWorkLabel, checkVisualReferencePrecision, evaluateCoverLetterChecks, formatCoverLetterDate, selectBetterLetterNeeds, sentences } from '../electron/ipc/coverLetterChecks.js';
export { assert, runExtractorFixtureTest, runZeroResultFixtureTest } from './tests/testHelpers.js';
export { ABSORB_EXCLUDED_TYPES, buildGroupHoverState, collectAbsorptionClosure, findSeveredRelations, getAbsorptionRejection, partitionEdgesForMove } from '../src/utils/nestedCanvasAbsorption.js';
export { isJobWorkflowDeletionPending, isJobWorkflowRelocationPending, markJobWorkflowDeletionPending, markJobWorkflowRelocationPending, settleJobWorkflowDeletion, settleJobWorkflowRelocation } from '../src/utils/nodeDeletionLifecycle.js';
export { MINIMAP_NODE_COLORS } from '../src/utils/constants.js';
