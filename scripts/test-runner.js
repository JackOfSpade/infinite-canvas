import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  EBAY_ACTIVE_EXTRACTOR,
  EBAY_SOLD_EXTRACTOR,
  MERCARI_SOLD_EXTRACTOR,
  POSHMARK_SOLD_EXTRACTOR,
  SWAPPA_SOLD_EXTRACTOR,
  priceChartingQuery,
} from '../electron/extractors/marketplace.js';
import { GOOGLE_JOBS_EXTRACTOR } from '../electron/extractors/jobs.js';
import {
  getJobSearchTransientKeysForSave,
  SELLHUB_TRANSIENT_KEYS,
  TRANSIENT_PROCESSING_HUB_STATES,
} from '../src/utils/persistenceTransientState.js';
import {
  jobTitleCompanyKey,
  jobTitleCompanyUrlKey,
  jobTitleCompanyLocationKey,
  dedupeJobsByKey,
  uniqueJobsNotIn,
} from '../src/utils/jobIdentity.js';
import { mergeSourceProgress } from '../src/utils/sourceProgress.js';
import { isJobCardVisible } from '../src/utils/jobCardFilters.js';
import { reconcileBatchScores, buildScoredJob } from '../electron/ipc/jobBatchReconcile.js';
import { buildCachedUserContent, buildAnthropicMessageParams } from '../electron/ipc/anthropicRequest.js';
import {
  isProfileLockCollision,
  recordLaunchCollision,
  getLaunchCollisions,
  _resetLaunchCollisions,
} from '../electron/ipc/browserLaunchTelemetry.js';
import { detectAntiBotSignal, matchesNoResultsSentinel } from '../electron/ipc/antiBotDetector.js';
import { getStats } from '../src/utils/dashboardStats.js';
import { resolveNodePresence } from '../src/utils/nodePresence.js';
import { ALL_COMP_SOURCE_IDS, CANVAS_ZOOM_LIMITS, getNodeDims, getNodesBounds, SELL_PLATFORMS } from '../src/utils/constants.js';
import { listingUrlMatchesPlatform, isFacebookShareUrl } from '../src/utils/platformUrlMatch.js';
import { mergeSourceIntoComps, retryWarningRequiringAction, updateResolvedSourceWarning } from '../src/utils/compsMerge.js';
import { mergeResolvedSourceItems } from '../src/utils/jobSourceResolveMerge.js';
import {
  buildJobTreeNodes,
  computeLayoutPositions,
  computeJobTreeView,
  partitionJobsForBranches,
  COL_X,
} from '../src/nodes/jobsearch/buildJobTree.js';
import { unionScoredJobs, moduleFingerprint, combineSignature, staleReason } from '../src/nodes/jobboard/mergeJobs.js';
import { buildGeoTermSet, extractIndeedJobsFromHtml, jobRelevanceMatch, selectReverbPriceGuides, reverbTransactionsToComps, parsePriceChartingHtml, filterPriceChartingByRelevance, dicePostedBucket, extractJobPostingDescription } from '../electron/extractors/apiExtractors.js';
import { isPriceChartingApplicable } from '../src/utils/compSourceScope.js';
import { buildResumeDocument, buildCoverLetterDocument, extractVariantAttrs, isDualMode, decodeTextEscapes } from '../electron/ipc/resumeHtml.js';
import {
  fingerprint,
  migrateGroupNodes,
  migrateLegacyJobHubResults,
  runNodeMigrations,
  CURRENT_SCHEMA_VERSION,
  sanitizeEdgesForSave,
  sanitizeNodesForSave,
} from '../src/utils/serializationUtils.js';
import { mergeNonRestorableNodeDataFromLive } from '../src/utils/undoNonRestorableState.js';
import { cloneNode, reassignCanvasDataIDs } from '../src/utils/nodeFactory.js';
import {
  distToSegment,
  pixelEraseStroke,
  segmentCircleIntersections,
  strokePoints,
} from '../src/utils/geometry.js';
import {
  edgeZoneForRadius,
  fitViewDuration,
  gridSpacing,
  panDuration,
  radialRadius,
  spiralStep,
  viewportForZoomAtScreenPoint,
} from '../src/utils/layoutGeometry.js';
import { computeTidiedNodes, findNonOverlappingPlacement } from '../src/utils/layoutUtils.js';
import { FILE_CATEGORIES, getFileCategoryInfo, toLocalFileUrl } from '../src/utils/fileDisplayUtils.js';
import { parsePostedDate, filterJobsByAge, POSTED_DATE_PATTERN } from '../electron/ipc/jobDateFilter.js';
import { compsForPricing, priceSynthesisMaxTokens, jobScoringBatchSize, JOB_MAX_PAGES, JOB_PER_PAGE_CAP } from '../electron/ipc/resultCaps.js';
import { modelMeta, contextWindowForModel, maxOutputForModel, estimateTokensFromChars, assessPromptFit, planSplits, LOCAL_CHARS_PER_TOKEN } from '../electron/ipc/tokenWindow.js';
import { parseGeminiJSON } from '../electron/ipc/gemini.js';
import { withSharedProfileLock } from '../electron/ipc/sharedProfileLock.js';
import { withStatusCheckLock, getStatusCheckQueueDepth } from '../electron/ipc/statusCheckLock.js';
import { withMarketplaceBrowserLock, getMarketplaceBrowserQueueDepth } from '../electron/ipc/marketplaceBrowserLock.js';
import { createAggregatingProgress } from '../electron/ipc/compProgressAggregator.js';
import { buildFinalListingTitle, buildRefreshResearchItems, buildResearchItems, computeBundleTotal, selectBundleHeadline, selectListingPriceTiers, buildItemQuery, bundleSynergyForPrices, deriveBundlePricingResult, normalizeBundlePricingResult } from '../src/utils/bundlePricing.js';
import {
  clearMissingPreviewRelinkCache,
  findExactFilenameBelow,
  resolveMissingPreviewPath,
} from '../electron/ipc/missingPreviewRelink.js';
import { getBrowserPoolQueueState, pauseBrowserPool, queueScrape } from '../electron/ipc/browserPool.js';
import { getSoftLoginWallMatch, getStatusCacheSync, writeStatusCache } from '../electron/ipc/accounts.js';
import { getSellMonitorConfig } from '../electron/ipc/stealthBrowser.js';
import os from 'node:os';
import { startRun, recordSourcePage, markSourceStatus, setStage, readStagedJobs, readRunState, clearRun, RESUMABLE_MAX_AGE_MS } from '../electron/ipc/jobRunStaging.js';
import { modelTag, overPricedSoldFlag } from '../electron/ipc/bugReport/helpers.js';
import { buildMarketplacePipelineSnapshot } from '../electron/ipc/bugReport/marketplaceSnapshot.js';
import { checkListingStatusMultiSource, classifyCompScrapeFailure, computeMissingLogins, filterGrosslyOffTargetSources, formatPricingNotesForPrompt, getMarketplaceTelemetry, normalizePricingNotes } from '../electron/ipc/marketplace.js';
import { aggregateStrongest, classifyOneUrl, deterministicListingStatusFromText, goneListingResult, resolveAttentionSourceUrls, annotateReadState, summarizeReadState, stripHtmlForAnalysis, stripReadStateTokens, READ_STATE_READ_TOKEN, READ_STATE_UNREAD_TOKEN } from '../electron/ipc/listingStatusCheck.js';
import { isAuthChallengeUrl, PLATFORM_AUTH_COOKIES, PLATFORM_LOGIN_URLS, unwrapInlineExtractorItems } from '../electron/ipc/browser/authWindows.js';
import { PRICE_SYNTHESIS_SCHEMA } from '../electron/ipc/aiSchemas.js';
import { deriveLocationParam, summarizeLocationAdherence, pickGlassdoorLocation } from '../src/utils/jobLocation.js';
import { detectLanguage, tagJobLanguages, summarizeJobLanguages } from '../src/utils/jobLanguage.js';
import { repairMojibake, hasMojibake, repairJobsMojibake } from '../src/utils/textEncoding.js';
import { foldVerificationSample, orderByVerification, verificationScore } from '../src/utils/scrapeOrder.js';
import { canHubAcceptInitialDrop, canSellHubAcceptDisplayPhotoDrop, canSellHubReplaceFailedInitialPhotos, getHubDropRejectLabel, getHubFileDropMode } from '../src/utils/hubDropEligibility.js';
import { applyBugReportCode, previewBugReportCode } from '../src/utils/bugReportCodes.js';
import { createJobSearchTestMode, parseJobSearchEnvBoolean } from '../src/utils/jobSourceScope.js';
import { createMarketplaceTestMode, parseMarketplaceEnvBoolean, getScopedCompSourceIds, isCompSourceEnabledInScope, normalizeCompWarnings } from '../src/utils/compSourceScope.js';
import { getJobAuthPreflightSourceIds, JOB_AUTH_PREFLIGHT_SOURCE_IDS } from '../src/utils/jobAuthPreflight.js';
import { getMarketplaceStatusLabel } from '../src/components/monitorStatusLabels.js';
import { appendPhotoFiles, appendPhotoPaths, normalizePhotoPathList, removePhotoPathAt } from '../src/utils/photoPathList.js';
import { filesToDropPayloads, filesToProductImagePaths, getLocalFilePath, summarizeFileExtensions } from '../src/utils/fileDropUtils.js';
import { cachedAuthNeedsLoginResult, statusErrorWrites, statusCheckWrites } from '../src/utils/listingStatusWrites.js';
import { buildMarketplaceStatusRollup } from '../electron/ipc/bugReport/marketplaceStatusRollup.js';
import { buildMarketplaceModuleRollup } from '../electron/ipc/bugReport/marketplaceModuleRollup.js';
import { shouldUseNativeTextUndo } from '../src/utils/nativeTextUndo.js';
import { matchesRedoShortcut } from '../src/utils/keyboardShortcuts.js';
import { syncUncontrolledTextValue } from '../src/utils/uncontrolledTextValue.js';
import { enqueueUniqueSourceResolve } from '../src/utils/sourceResolveQueue.js';
import { getRequiredCompLoginPlatformIds } from '../src/utils/marketplaceLoginPreflight.js';
import { createModuleRunQueue } from '../src/utils/moduleRunQueue.js';
import { deleteChildrenByHubId } from '../src/nodes/_shared/hubChildCleanup.js';
import { getConnectedHubCards } from '../src/utils/connectedHubCards.js';
import { enqueueStatusCheckAction, getStatusCheckActionQueueDepth } from '../src/utils/statusCheckActionQueue.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runExtractorFixtureTest({ name, file, extractor, minCount = 1, sampleAssert = null }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  // Extractors return either a bare array or { items, yieldStats } — mirror the
  // browserPool unwrap so the fixture asserts on the items array either way.
  const raw = dom.window.eval(extractor);
  const result = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : raw);
  assert(Array.isArray(result), `${name}: extractor did not return an array (or { items })`);
  assert(result.length >= minCount, `${name}: expected at least ${minCount} result(s), got ${result.length}`);
  if (sampleAssert) sampleAssert(result[0], result);
  return { count: result.length, sample: result[0] };
}

function runZeroResultFixtureTest({ name, file, extractor }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  const raw = dom.window.eval(extractor);
  const result = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : raw);
  assert(Array.isArray(result), `${name}: extractor did not return an array (or { items })`);
  assert(result.length === 0, `${name}: expected 0 results, got ${result.length}`);
  return { count: result.length };
}

const tests = [
  {
    name: 'listingUrlMatchesPlatform: blocks cross-platform URLs, stays conservative on the unknowable',
    run: () => {
      // Clear match — incl. protocol-less (how listing URLs are stored) and www/subdomain.
      assert(listingUrlMatchesPlatform('https://www.ebay.com/itm/123', 'ebay').ok, 'ebay itm URL matches ebay');
      assert(listingUrlMatchesPlatform('www.ebay.com/itm/123', 'ebay').ok, 'protocol-less ebay URL matches');
      assert(listingUrlMatchesPlatform('https://m.facebook.com/marketplace/item/1', 'facebook').ok, 'facebook subdomain matches');
      assert(listingUrlMatchesPlatform('https://www.facebook.com/share/abc/', 'facebook').ok, 'facebook share URL matches');
      // Clear mismatch — the bug the guard exists for (ebay link on a facebook card).
      const m = listingUrlMatchesPlatform('https://www.ebay.com/itm/123', 'facebook');
      assert(!m.ok, 'ebay URL on facebook card is a mismatch');
      assert(m.expectedDomain === 'facebook.com' && m.actualHost === 'ebay.com', 'mismatch reports both hosts');
      assert(!listingUrlMatchesPlatform('https://reverb.com/item/1', 'mercari').ok, 'reverb URL on mercari card is a mismatch');
      // Conservative: never block when we can't be sure it's wrong.
      assert(listingUrlMatchesPlatform('', 'ebay').ok, 'blank URL does not block');
      assert(listingUrlMatchesPlatform('not a url', 'ebay').ok, 'unparseable URL does not block');
      assert(listingUrlMatchesPlatform('https://www.ebay.com/itm/1', 'ebay-sold').ok, 'unknown platform id does not block');
      return { ok: true };
    },
  },
  {
    name: 'resolveAttentionSourceUrls: binds each item to a real hub page, never a wrong one',
    run: () => {
      const offers = 'https://www.ebay.com/sh/ord/?filter=offers';
      const messages = 'https://www.ebay.com/mesgreq';
      // Valid model hint against a multi-page scan → kept verbatim.
      const a = resolveAttentionSourceUrls(
        [{ headline: 'Offer on AirPods', sourceUrl: offers }, { headline: 'Buyer question', sourceUrl: messages }],
        [offers, messages],
      );
      assert(a[0].sourceUrl === offers && a[1].sourceUrl === messages, 'valid hints kept verbatim');
      // Single hub page → source is unambiguous; bad/missing hint is corrected to it.
      const b = resolveAttentionSourceUrls(
        [{ headline: 'x', sourceUrl: 'https://evil.example/phish' }, { headline: 'y' }],
        [offers],
      );
      assert(b[0].sourceUrl === offers && b[1].sourceUrl === offers, 'single page resolves regardless of hint');
      // Multiple pages + unresolvable hint → no button rather than a wrong page.
      const c = resolveAttentionSourceUrls(
        [{ headline: 'z', sourceUrl: 'https://made.up/page' }],
        [offers, messages],
      );
      assert(!('sourceUrl' in c[0]), 'ambiguous multi-page hint drops sourceUrl (no misleading button)');
      // No hub pages → nothing to link.
      assert(!('sourceUrl' in resolveAttentionSourceUrls([{ headline: 'q', sourceUrl: offers }], [])[0]), 'no hub urls → no sourceUrl');
      return { ok: true };
    },
  },
  {
    name: 'annotateReadState: read/unread CSS markers survive stripping next to the message text',
    run: () => {
      // Verbatim read conversation card from the eBay messages inbox (the bug:
      // an already-read message was flagged as action-needed because read-state
      // lives only in `card__content-read` / `status-dot--hidden`, which the
      // text strip erased).
      const readCard = `<button id="msg-0-btn" data-testid="conversation-item__from-member"><span class="status-dot status-dot--hidden"></span><div class="card__content card__content__resized card__content-read"><p class="card__username sender"><span class="ux-textspans">lentn_978928864</span></p><div class="card__latest-message"><span class="ux-textspans">Thanks. If change price let me know that. Thanks</span></div><div class="card__datetime"><small>7h</small></div></div></button>`;
      const stripped = stripHtmlForAnalysis(annotateReadState(readCard));
      // The READ token must land BEFORE the message body so the model binds them.
      assert(stripped.includes(READ_STATE_READ_TOKEN), 'read card gains a READ token');
      assert(!stripped.includes(READ_STATE_UNREAD_TOKEN), 'read card has no UNREAD token');
      assert(
        stripped.indexOf(READ_STATE_READ_TOKEN) < stripped.indexOf('Thanks. If change price'),
        'READ token precedes the message text it annotates',
      );

      // An unopened card → UNREAD token, no READ token.
      const unreadCard = `<button data-testid="conversation-item__from-member"><span class="status-dot"></span><div class="card__content card__content-unread"><div class="card__latest-message">Is this still available?</div></div></button>`;
      const strippedUnread = stripHtmlForAnalysis(annotateReadState(unreadCard));
      assert(strippedUnread.includes(READ_STATE_UNREAD_TOKEN), 'unread card gains an UNREAD token');
      assert(!strippedUnread.includes(READ_STATE_READ_TOKEN), 'unread card has no READ token');

      // Pages with no read-state classes are untouched (no spurious markers).
      const plain = `<div class="dashboard"><p>2 active listings, no offers.</p></div>`;
      const strippedPlain = stripHtmlForAnalysis(annotateReadState(plain));
      assert(!strippedPlain.includes(READ_STATE_READ_TOKEN) && !strippedPlain.includes(READ_STATE_UNREAD_TOKEN), 'plain page gets no markers');
      assert(annotateReadState('') === '' && annotateReadState(null) === null, 'empty input is passed through');

      // Belt-and-suspenders: if the model leaks a sentinel into evidence, it is
      // scrubbed so it never reaches the UI card or the bug report.
      const leaked = stripReadStateTokens(`${READ_STATE_READ_TOKEN} Thanks. If change price ${READ_STATE_UNREAD_TOKEN} let me know`);
      assert(!leaked.includes(READ_STATE_READ_TOKEN) && !leaked.includes(READ_STATE_UNREAD_TOKEN), 'sentinels scrubbed from leaked evidence');
      assert(leaked.trim() === 'Thanks. If change price let me know', 'scrub collapses the gap it leaves behind');
      // A token jammed between two words must not merge them.
      assert(stripReadStateTokens(`Thanks${READ_STATE_READ_TOKEN}more`).trim() === 'Thanks more', 'token replaced by a space, not nothing');
      // No-op fast path: a token-free string (the shared per-listing path) is
      // returned byte-for-byte, preserving any internal whitespace.
      assert(stripReadStateTokens('a  b\nc') === 'a  b\nc', 'token-free input is untouched (no whitespace collapse)');
      return { ok: true };
    },
  },
  {
    name: 'buildMarketplaceModuleRollup: surfaces flagged-item evidence + read/unread signal',
    run: () => {
      const nodes = [{
        id: 'mod-1',
        type: 'marketplacestatus',
        data: { platformStatus: {
          ebay: {
            status: 'ok',
            // Summary carries a literal pipe (a quoted buyer offer "$50 | OBO")
            // that must be escaped so it doesn't break the markdown table row.
            summary: 'Buyer offered $50 | OBO on the microphone',
            attention: [{ urgency: 'high', category: 'question', headline: 'Buyer message about price', evidence: 'Thanks. If change price let me know that. Thanks' }],
            sources: [{ status: 'ok' }],
            readState: { read: 4, unread: 1 },
            lastChecked: new Date().toISOString(),
          },
        } },
      }];
      const md = buildMarketplaceModuleRollup(nodes);
      assert(md.includes('Flagged items'), 'renders a flagged-items detail section');
      assert(md.includes('Thanks. If change price'), 'includes the verbatim evidence the model quoted');
      assert(md.includes('Buyer message about price'), 'includes the item headline');
      assert(/\b4r\/1u\b/.test(md), 'read/unread column shows 4r/1u');
      assert(md.includes('read-state'), 'notes that read-state was detected');
      assert(md.includes('$50 \\| OBO'), 'literal pipe in summary is escaped so the table row keeps its 7 cells');
      // No marketplacestatus node → empty (unchanged behavior).
      assert(buildMarketplaceModuleRollup([{ id: 'x', type: 'sellhub', data: {} }]) === '', 'no module node → empty string');
      return { ok: true };
    },
  },
  {
    name: 'summarizeReadState: counts conversations once each, keyed off the content class',
    run: () => {
      const html = `<div class="card__content card__content-read"></div><div class="card__content card__content-read"></div><div class="card__content card__content-unread"></div><span class="status-dot status-dot--hidden"></span>`;
      const s = summarizeReadState(html);
      // status-dot--hidden must NOT inflate the read count (it would double-count
      // a read card, which already carries card__content-read).
      assert(s.read === 2, `2 read conversations counted (got ${s.read})`);
      assert(s.unread === 1, `1 unread conversation counted (got ${s.unread})`);
      const empty = summarizeReadState('');
      assert(empty.read === 0 && empty.unread === 0, 'empty html → zero counts');
      return { ok: true };
    },
  },
  {
    name: 'isFacebookShareUrl: flags /share/<hash> links, not canonical item URLs',
    run: () => {
      // The weak-anchor shape this nudge exists for — incl. protocol-less + subdomain.
      assert(isFacebookShareUrl('https://www.facebook.com/share/1FnDGdqNK1/'), 'share link flagged');
      assert(isFacebookShareUrl('www.facebook.com/share/1FnDGdqNK1/'), 'protocol-less share link flagged');
      assert(isFacebookShareUrl('https://m.facebook.com/share/abc'), 'subdomain share link flagged (no trailing slash)');
      // Canonical listing URLs and everything else must NOT be flagged.
      assert(!isFacebookShareUrl('https://www.facebook.com/marketplace/item/27086638057612157'), 'canonical item URL not flagged');
      assert(!isFacebookShareUrl('https://www.ebay.com/itm/123'), 'non-facebook URL not flagged');
      assert(!isFacebookShareUrl('https://www.facebook.com/share/'), 'empty share hash not flagged');
      assert(!isFacebookShareUrl(''), 'blank not flagged');
      assert(!isFacebookShareUrl('not a url'), 'unparseable not flagged');
      return { ok: true };
    },
  },
  {
    name: 'tokenWindow: per-model context windows + max output (verified registry)',
    run: () => {
      // Verified against provider docs (May 2026): Sonnet 4.6 & Opus 4.8 are 1M
      // natively; Haiku 4.5 is 200K; every Gemini flash is 1,048,576 / 65,536.
      assert(contextWindowForModel('claude-sonnet-4-6') === 1000000, 'Sonnet 4.6 window should be 1M');
      assert(contextWindowForModel('claude-opus-4-8') === 1000000, 'Opus 4.8 window should be 1M');
      assert(contextWindowForModel('claude-haiku-4-5-20251001') === 200000, 'Haiku 4.5 window should be 200K');
      assert(contextWindowForModel('gemini-3.5-flash') === 1048576, 'Gemini 3.5 flash window should be 1,048,576');
      assert(maxOutputForModel('claude-opus-4-8') === 128000, 'Opus 4.8 max output should be 128K');
      assert(maxOutputForModel('gemini-2.5-flash-lite') === 65536, 'Gemini flash-lite max output should be 65,536');
      // Family fallbacks: unknown gemini → 1M; unknown claude → conservative 200K.
      assert(contextWindowForModel('gemini-99-ultra-flash') === 1048576, 'unknown gemini → 1M family default');
      assert(contextWindowForModel('claude-future-9') === 200000, 'unknown claude → conservative 200K default');
      assert(modelMeta('gemini-2.5-flash').provider === 'gemini', 'provider tagged on meta');
      return { ok: true };
    },
  },
  {
    name: 'tokenWindow: local estimate over-counts (safe upper bound), assessPromptFit budget math',
    run: () => {
      // The local estimate must be an UPPER bound vs the realistic ~4 chars/token,
      // so it can never wave an oversized prompt through.
      const chars = 100000;
      const est = estimateTokensFromChars(chars);
      assert(est === Math.ceil(chars / LOCAL_CHARS_PER_TOKEN), 'estimate uses the conservative ratio');
      assert(est > chars / 4, 'estimate over-counts vs the realistic ~4 chars/token');
      // A 22K-token scoring batch (15 enriched jobs) fits BOTH a 200K and a 1M window.
      const out = 8800; // job-scoring reserve at 15 items: min(24576, 2500+420*15)
      assert(assessPromptFit({ contextWindow: 200000, modelMaxOutput: 64000, requestedOutput: out, promptTokens: 22000 }).fits, '22K batch fits 200K');
      assert(assessPromptFit({ contextWindow: 1048576, modelMaxOutput: 65536, requestedOutput: out, promptTokens: 22000 }).fits, '22K batch fits 1M');
      // A 195K-token prompt overflows 200K (no room for output+margin) but fits 1M.
      assert(!assessPromptFit({ contextWindow: 200000, modelMaxOutput: 64000, requestedOutput: out, promptTokens: 195000 }).fits, '195K overflows 200K');
      assert(assessPromptFit({ contextWindow: 1048576, modelMaxOutput: 65536, requestedOutput: out, promptTokens: 195000 }).fits, '195K fits 1M');
      // requestedOutput is clamped to the model's own max output.
      const clamped = assessPromptFit({ contextWindow: 200000, modelMaxOutput: 4096, requestedOutput: 24576, promptTokens: 0 });
      assert(clamped.reservedOutput === 4096, 'requestedOutput clamps to modelMaxOutput');
      return { ok: true, est, budget200k: assessPromptFit({ contextWindow: 200000, modelMaxOutput: 64000, requestedOutput: out, promptTokens: 0 }).budget };
    },
  },
  {
    name: 'tokenWindow: planSplits recursively halves only oversized groups, preserves order',
    run: () => {
      const items = Array.from({ length: 15 }, (_, i) => i);
      // fits = groups of ≤4 only → every chunk ≤4, order preserved, covers all 15.
      const chunks = planSplits(items, (g) => g.length <= 4);
      assert(chunks.every((c) => c.length <= 4), 'all chunks within the size predicate');
      assert(chunks.flat().join(',') === items.join(','), 'flatten preserves original order + completeness');
      // Whole batch fits → single chunk, no splitting.
      assert(planSplits(items, () => true).length === 1, 'no split when it already fits');
      // Halving ISOLATES a single oversized item (size-weighted predicate).
      const weighted = [1, 1, 1, 20, 1, 1];
      const wchunks = planSplits(weighted, (g) => g.reduce((a, b) => a + b, 0) <= 10);
      assert(wchunks.some((c) => c.length === 1 && c[0] === 20), 'oversized item isolated into its own chunk');
      // A size-1 group that still does not fit is returned as-is (atomic case).
      assert(planSplits([99], () => false).length === 1, 'unsplittable single item returned as-is');
      return { ok: true, chunkSizes: chunks.map((c) => c.length) };
    },
  },
  {
    name: 'ZipRecruiter posted-date: DOM "Posted X ago" pattern extracts + parses (no structured date)',
    run: () => {
      // ZR's new /jobs/{co}/{slug} detail pages have NO JSON-LD/__NEXT_DATA__/<time>;
      // the only date is visible text like "Posted 28 days ago". manualScraper's
      // harvest matches POSTED_DATE_PATTERN against short DOM text leaves and feeds
      // the captured phrase to parsePostedDate. Validate that exact chain.
      const re = new RegExp(POSTED_DATE_PATTERN, 'i');
      const ageOf = (d) => d ? Math.round((Date.now() - new Date(d).getTime()) / 86400000) : null;
      const cases = [
        ['Posted 28 days ago', '28 days ago', 28],
        ['Posted 30+ days ago', '30+ days ago', 30],
        ['Reposted 3 weeks ago', '3 weeks ago', 21],
        ['Posted 5 hours ago', '5 hours ago', 0],
      ];
      for (const [raw, phrase, ageDays] of cases) {
        const m = raw.match(re);
        assert(m && m[0] === phrase, `extract "${phrase}" from "${raw}" (got ${m && m[0]})`);
        const parsed = parsePostedDate(m[0]); // returns a Date
        assert(parsed && ageOf(parsed) === ageDays, `parse "${phrase}" → ${ageDays}d (got ${ageOf(parsed)})`);
      }
      // "just posted" captures and parses to ~today.
      assert('Just posted'.match(re)?.[0].toLowerCase() === 'just posted', 'captures "just posted"');
      assert(parsePostedDate('just posted') !== null, '"just posted" parses to a recent date');
      // Must NOT false-positive on prose that merely contains a number.
      assert(!('We have 28 open roles on our careers page.'.match(re)), 'no false-positive on non-date prose');
      return { ok: true };
    },
  },
  {
    name: 'Dice JD enrichment: extractJobPostingDescription pulls JobPosting.description from JSON-LD',
    run: () => {
      // Dice list summaries are ~500 chars; the full JD lives in the detail page's
      // JSON-LD JobPosting.description. The harvester must handle plain JobPosting,
      // @graph wrappers, and array @type — and never throw on malformed JSON-LD.
      const mk = (ld) => `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>x</body></html>`;
      assert(extractJobPostingDescription(mk({ '@type': 'JobPosting', description: 'Full JD here' })) === 'Full JD here', 'plain JobPosting');
      assert(extractJobPostingDescription(mk({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization' }, { '@type': 'JobPosting', description: 'Graph JD' }] })) === 'Graph JD', '@graph wrapper');
      assert(extractJobPostingDescription(mk({ '@type': ['JobPosting', 'Thing'], description: 'Array-type JD' })) === 'Array-type JD', 'array @type');
      // Absent / no-LD / malformed → '' (caller keeps the list summary), no throw.
      assert(extractJobPostingDescription(mk({ '@type': 'Organization', name: 'Acme' })) === '', 'no JobPosting → empty');
      assert(extractJobPostingDescription('<html>no ld</html>') === '', 'no JSON-LD → empty');
      assert(extractJobPostingDescription('<script type="application/ld+json">{bad json</script>') === '', 'malformed → empty (no throw)');
      return { ok: true };
    },
  },
  {
    name: 'Dice postedDate bucket: only exact 1/3/7-day windows map to a server-side filter',
    run: () => {
      // Dice's `filters.postedDate` accepts ONLY ONE/THREE/SEVEN (verified against
      // the live API; other values are silently ignored). dicePostedBucket must
      // return a bucket ONLY for an exact 1/3/7-day window, else null so the caller
      // keeps the wide over-pull + client-side filter (no server-side narrowing).
      assert(dicePostedBucket(1) === 'ONE', '1 → ONE');
      assert(dicePostedBucket(3) === 'THREE', '3 → THREE');
      assert(dicePostedBucket(7) === 'SEVEN', '7 → SEVEN');
      assert(dicePostedBucket(7.0) === 'SEVEN', 'float 7.0 → SEVEN');
      // Non-bucket windows → null (client-side enforces them; never a wrong bucket).
      for (const n of [2, 5, 6, 8, 14, 21, 30]) {
        assert(dicePostedBucket(n) === null, `${n} → null (no exact bucket)`);
      }
      // Garbage / missing → null (never throw, never fabricate a bucket).
      for (const bad of [null, undefined, 0, -1, NaN, '7']) {
        assert(dicePostedBucket(bad) === null, `${String(bad)} → null`);
      }
      return { ok: true };
    },
  },
  {
    name: 'Batch chunking: window-split sub-batches reconcile by b{i} (order + per-job index preserved)',
    run: () => {
      // The async batch path pre-splits each over-window group then submits one
      // `b{i}` request per fit-guaranteed sub-batch (splitBatchesToFitWindow in
      // jobs.js mirrors planSplits). reconcileBatchScores must map every sub-batch
      // back by local index so no job is lost or mis-scored after the split.
      const jobs = Array.from({ length: 7 }, (_, i) => ({ id: i, title: `J${i}`, company: 'Co' }));
      const subBatches = planSplits(jobs, (g) => g.length <= 3); // synthetic "fits ≤3" predicate
      assert(subBatches.flat().length === 7, 'no jobs lost across the split');
      assert(subBatches.every((b) => b.length <= 3), 'each sub-batch within the window predicate');
      // Build results exactly as the Batch API returns them: b{i} → {scores:[{index(LOCAL)…}]}.
      const resultsByCustomId = {};
      subBatches.forEach((b, i) => {
        resultsByCustomId[`b${i}`] = { scores: b.map((_job, idx) => ({ index: idx, matchScore: 50 + idx, reasoning: 'r', careerDirection: 'X' })) };
      });
      const { scoredJobs, placeholderCount, failedBatches } = reconcileBatchScores(subBatches, resultsByCustomId, { fallbackScore: 1 });
      assert(scoredJobs.length === 7, 'every job reconciled after the split');
      assert(placeholderCount === 0 && failedBatches === 0, 'clean results → no placeholders/failures');
      assert(scoredJobs.every((j) => typeof j.title === 'string' && j.matchScore >= 50), 'each job kept its fields + a real local-index score');
      return { ok: true, subBatchSizes: subBatches.map((b) => b.length) };
    },
  },
  {
    name: 'Application: literal \\n / \\t escapes decode in cover letter + résumé (no verbatim backslash text)',
    run: () => {
      // decodeTextEscapes: literal 2-char escapes → real whitespace; real content untouched.
      assert(decodeTextEscapes('Hiring Team\\nMonster') === 'Hiring Team\nMonster', 'literal \\n decodes to newline');
      assert(decodeTextEscapes('a\\tb') === 'a\tb', 'literal \\t decodes to tab');
      assert(decodeTextEscapes('already\nreal') === 'already\nreal', 'real newline untouched (no-op)');
      assert(decodeTextEscapes('plain text') === 'plain text', 'plain text untouched');

      // Cover letter: a recipient with a LITERAL backslash-n splits into rows
      // (recipient-name + recipient-line), and no verbatim "\n" leaks through.
      const cl = buildCoverLetterDocument({
        name: 'Maya Chen',
        recipient: 'Hiring Team\\nMonster Brewing Company',
        salutation: 'Dear Monster Team,',
        paragraphs: ['I have led growth\\nin brand marketing for 6 years.', 'Second\\tindented bit.'],
        closing: 'Sincerely,',
      });
      assert(!/\\n|\\t/.test(cl), 'cover letter must contain NO literal backslash-n/t');
      assert(cl.includes('<span class="recipient-name">Hiring Team</span>'), 'recipient first line → recipient-name');
      assert(cl.includes('<span class="recipient-line">Monster Brewing Company</span>'), 'recipient second line → recipient-line');
      // An in-paragraph newline must COLLAPSE (flowing prose), NOT become a hard
      // <br> — a stray model newline mid-sentence (around a title's en-dash) would
      // otherwise render as a bad break. Both halves still present, no <br>.
      assert(!/<br\s*\/?>/.test(cl), 'no hard <br> break inserted inside a paragraph');
      assert(/led growth\s+in brand marketing/.test(cl), 'in-paragraph newline collapses to whitespace (prose flows)');

      // Résumé: literal escapes in the raw model HTML decode to whitespace.
      const rz = buildResumeDocument('<main class="page"><h1 class="name">Maya\\nChen</h1><p>Led\\tgrowth</p></main>');
      assert(!/\\n|\\t/.test(rz), 'résumé must contain NO literal backslash-n/t');
      assert(/Maya\s+Chen/.test(rz), 'résumé literal \\n became collapsing whitespace');
      return { ok: true };
    },
  },
  {
    name: 'eBay sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'eBay sold fixture',
      file: 'scripts/fixtures/ebay-body.html',
      extractor: EBAY_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'ebay-sold', 'eBay sold fixture: wrong source id');
        assert(sample.title && sample.price > 0 && sample.soldDate, 'eBay sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    // The eBay count-heading parse (yieldStats.claimedTotal) against REAL markup:
    // the fixture reads "4,100+ results", so the parser must strip the comma and
    // the "+" → 4100. This is the signal the detector uses to tell a genuine
    // 1-result page from selector drift; a markup change that breaks it would
    // silently re-enable the false zero-extracted Solve loop, so lock it down.
    name: 'eBay extractor: claimedTotal parses the site result-count header',
    run: () => {
      const html = fs.readFileSync(path.resolve('scripts/fixtures/ebay-body.html'), 'utf8');
      const dom = new JSDOM(html, { url: 'https://example.com', runScripts: 'outside-only' });
      const raw = dom.window.eval(EBAY_SOLD_EXTRACTOR);
      assert(raw && raw.yieldStats, 'eBay extractor must return a yieldStats envelope');
      assert(raw.yieldStats.claimedTotal === 4100, `claimedTotal should parse "4,100+ results" → 4100 (got ${raw.yieldStats.claimedTotal})`);
      assert(Number.isInteger(raw.yieldStats.seen) && raw.yieldStats.seen >= 10, 'seen denominator present');
      return { ok: true, claimedTotal: raw.yieldStats.claimedTotal };
    },
  },
  {
    name: 'eBay active fixture',
    run: () => runExtractorFixtureTest({
      name: 'eBay active fixture',
      file: 'scripts/fixtures/ebay-body.html',
      extractor: EBAY_ACTIVE_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'ebay-active', 'eBay active fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'eBay active fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Mercari sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'Mercari sold fixture',
      file: 'scripts/fixtures/mercari-body.html',
      extractor: MERCARI_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'mercari', 'Mercari sold fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'Mercari sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Poshmark sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'Poshmark sold fixture',
      file: 'scripts/fixtures/poshmark-body.html',
      extractor: POSHMARK_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'poshmark', 'Poshmark sold fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'Poshmark sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Google captcha fixture',
    run: () => runZeroResultFixtureTest({
      name: 'Google captcha fixture',
      file: 'scripts/fixtures/google-jobs.html',
      extractor: GOOGLE_JOBS_EXTRACTOR,
    }),
  },
  {
    name: 'Indeed DOM extraction',
    run: () => {
      const html = `
        <html><body>
          <div class="job_seen_beacon" data-jk="abc123">
            <h2 class="jobTitle"><a href="/rc/clk?jk=abc123">Senior Product Manager</a></h2>
            <span data-testid="company-name">Acme</span>
            <div data-testid="text-location">Remote</div>
            <div data-testid="attribute_snippet_testid">$120,000 a year</div>
            <div data-testid="job-snippet">Own product strategy.</div>
            <span data-testid="myJobsStateDate">Posted 1 day ago</span>
          </div>
          <div class="job_seen_beacon" data-jk="abc123">
            <h2 class="jobTitle"><a href="/rc/clk?jk=abc123">Senior Product Manager</a></h2>
            <span data-testid="company-name">Acme</span>
            <div data-testid="text-location">Remote</div>
          </div>
        </body></html>`;
      const jobs = extractIndeedJobsFromHtml(html);
      assert(jobs.length === 1, `Indeed DOM extraction: expected deduped single job, got ${jobs.length}`);
      assert(jobs[0].title === 'Senior Product Manager', 'Indeed DOM extraction: wrong title');
      assert(jobs[0].company === 'Acme' && jobs[0].location === 'Remote', 'Indeed DOM extraction: wrong company/location');
      assert(jobs[0].url === 'https://www.indeed.com/viewjob?jk=abc123', `Indeed DOM extraction: normalized URL mismatch ${jobs[0].url}`);
      return { count: jobs.length, sample: jobs[0] };
    },
  },
  {
    name: 'Transient jobhub save rules',
    run: () => {
      const normal = getJobSearchTransientKeysForSave('searching');
      const sourcesReady = getJobSearchTransientKeysForSave('sources-ready');
      assert(normal.includes('queuedModuleRun'), 'Transient jobhub save rules: default state should strip queuedModuleRun');
      assert(normal.includes('scrapeWarnings'), 'Transient jobhub save rules: default state should strip scrapeWarnings');
      assert(normal.includes('pendingTargetRole'), 'Transient jobhub save rules: default state should strip pendingTargetRole');
      assert(!sourcesReady.includes('scrapeWarnings'), 'Transient jobhub save rules: sources-ready should preserve scrapeWarnings');
      assert(sourcesReady.includes('errorMessage') && sourcesReady.includes('isRateLimit'), 'Transient jobhub save rules: sources-ready should still strip banners');
      return { normal, sourcesReady };
    },
  },
  {
    name: 'Transient state constants',
    run: () => {
      assert(TRANSIENT_PROCESSING_HUB_STATES.includes('queued'), 'Transient state constants: missing queued');
      assert(TRANSIENT_PROCESSING_HUB_STATES.includes('searching'), 'Transient state constants: missing searching');
      assert(TRANSIENT_PROCESSING_HUB_STATES.includes('researching'), 'Transient state constants: missing researching');
      assert(SELLHUB_TRANSIENT_KEYS.includes('platformFitPending'), 'Transient state constants: missing platformFitPending');
      assert(SELLHUB_TRANSIENT_KEYS.includes('queuedModuleRun'), 'Transient state constants: missing queuedModuleRun');
      return {
        transientStates: TRANSIENT_PROCESSING_HUB_STATES.length,
        sellhubKeys: SELLHUB_TRANSIENT_KEYS.length,
      };
    },
  },
  {
    name: 'Serialization sanitizes transient state',
    run: () => {
      const nodes = [
        { id: 'hub', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'queued', queuedModuleRun: { position: 1 }, pendingJobs: [1], scrapeWarnings: [2], errorMessage: 'old' } },
        { id: 'job', type: 'jobcard', position: { x: 1, y: 1 }, style: { opacity: 0.3, width: 180 }, data: { title: 'A', isDropTarget: true } },
        { id: 'clean-source', type: 'jobsourcecard', position: { x: 2, y: 2 }, data: { persistedProgress: { status: 'done' } } },
        { id: 'blocked-source', type: 'jobsourcecard', position: { x: 3, y: 3 }, data: { persistedProgress: { status: 'error', warning: { code: 'captcha' } } } },
        { id: 'group', type: 'group', position: { x: 4, y: 4 }, data: { isDropTarget: true, canvasData: { nodes: [
          { id: 'inner-job', type: 'jobcard', position: { x: 0, y: 0 }, style: { opacity: 0.1 }, data: { title: 'Inner' } },
        ], edges: [], drawings: [] } } },
      ];
      const sanitized = sanitizeNodesForSave(nodes);
      const hub = sanitized.find(n => n.id === 'hub');
      const job = sanitized.find(n => n.id === 'job');
      assert(hub.data.hubState === 'empty', 'Serialization sanitizes transient state: active jobhub should reset to empty');
      assert(!('pendingJobs' in hub.data) && !('scrapeWarnings' in hub.data) && !('queuedModuleRun' in hub.data), 'Serialization sanitizes transient state: jobhub transient buffers should be stripped');
      assert(!('isDropTarget' in job.data) && job.style.opacity === undefined && job.style.width === 180, 'Serialization sanitizes transient state: node transient UI state should be stripped');
      assert(!sanitized.some(n => n.id === 'clean-source'), 'Serialization sanitizes transient state: clean source card should be dropped');
      assert(sanitized.some(n => n.id === 'blocked-source'), 'Serialization sanitizes transient state: blocked source card should persist');
      assert(sanitized.find(n => n.id === 'group').data.canvasData.nodes[0].style === undefined, 'Serialization sanitizes transient state: nested nodes should be sanitized');
      const edges = sanitizeEdgesForSave([
        { id: 'keep', source: 'hub', target: 'job' },
        { id: 'drop', source: 'hub', target: 'missing' },
      ], sanitized);
      assert(edges.length === 1 && edges[0].id === 'keep', 'Serialization sanitizes transient state: orphan edges should be pruned');
      return { nodes: sanitized.length, edges: edges.length };
    },
  },
  {
    name: 'Serialization migration and fingerprints',
    run: () => {
      const legacy = [{
        id: 'g1',
        type: 'group',
        position: { x: 0, y: 0 },
        dragHandle: '.old',
        data: {
          title: 'Legacy',
          collapsed: true,
          nodes: [{ id: 'child', type: 'text', position: { x: 1, y: 2 }, data: { text: 'A' } }],
          edges: [{ id: 'e', source: 'child', target: 'child' }],
          drawings: [{ id: 'd', points: [{ x: 0, y: 0 }] }],
        },
      }];
      const migrated = migrateGroupNodes(legacy);
      assert(migrated[0].data.canvasData.nodes.length === 1, 'Serialization migration and fingerprints: legacy group should migrate canvasData');
      assert(!('nodes' in migrated[0].data) && !('dragHandle' in migrated[0]), 'Serialization migration and fingerprints: legacy fields should be removed');
      const fpA = fingerprint({ nodes: migrated, edges: [], drawings: [{ points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }] }] });
      const fpB = fingerprint({ nodes: migrated, edges: [], drawings: [{ points: [{ x: 0, y: 0 }, { x: 7, y: 7 }, { x: 10, y: 10 }] }] });
      assert(fpA !== fpB, 'Serialization migration and fingerprints: middle drawing point should affect fingerprint');
      return { migratedNodes: migrated[0].data.canvasData.nodes.length };
    },
  },
  {
    name: 'Module run queue serializes Marketplace and Job Search modules FIFO',
    run: async () => {
      const starts = [];
      const positionEvents = [];
      const queue = createModuleRunQueue();

      const a = await queue.acquireModuleRun({
        nodeId: 'market-1',
        kind: 'marketplace',
        label: 'A',
        onStart: () => starts.push('A'),
      });
      const bPromise = queue.acquireModuleRun({
        nodeId: 'job-1',
        kind: 'jobsearch',
        label: 'B',
        onQueued: ({ position }) => positionEvents.push(`Bq${position}`),
        onQueueUpdate: ({ position }) => positionEvents.push(`Bu${position}`),
        onStart: () => starts.push('B'),
      });
      const cPromise = queue.acquireModuleRun({
        nodeId: 'market-2',
        kind: 'marketplace',
        label: 'C',
        onQueued: ({ position }) => positionEvents.push(`Cq${position}`),
        onStart: () => starts.push('C'),
      });
      const dPromise = queue.acquireModuleRun({
        nodeId: 'job-2',
        kind: 'jobsearch',
        label: 'D',
        onQueued: ({ position }) => positionEvents.push(`Dq${position}`),
        onQueueUpdate: ({ position }) => positionEvents.push(`Du${position}`),
        onStart: () => starts.push('D'),
      });

      assert(queue.getSnapshot().active.nodeId === 'market-1', 'first module starts immediately');
      assert(queue.getSnapshot().queued.length === 3, `three later modules wait (got ${queue.getSnapshot().queued.length})`);
      assert(positionEvents.includes('Bq1') && positionEvents.includes('Cq2') && positionEvents.includes('Dq3'), `initial queue positions recorded (${positionEvents.join(',')})`);

      const cancelled = queue.cancelQueuedRunsForNode('market-2');
      const cResult = await cPromise.catch(err => err?.message || String(err));
      assert(cancelled === 1 && cResult === 'Node deleted', `cancel removes one waiting module (${cancelled}, ${cResult})`);
      assert(queue.getSnapshot().queued.map(e => e.nodeId).join(',') === 'job-1,job-2', 'cancel preserves remaining FIFO order');
      assert(positionEvents.includes('Du2'), `remaining queue positions update after cancel (${positionEvents.join(',')})`);

      a.release();
      const b = await bPromise;
      assert(starts.join(',') === 'A,B', `B starts after A releases (${starts.join(',')})`);
      b.release();
      const d = await dPromise;
      assert(starts.join(',') === 'A,B,D', `D starts after B releases (${starts.join(',')})`);
      d.release();
      assert(queue.getSnapshot().active === null && queue.getSnapshot().queued.length === 0, 'queue drains after all releases');
      return { starts, queued: positionEvents.length };
    },
  },
  {
    name: 'SellHub price refresh cleanup preserves attached marketplace listing cards',
    run: () => {
      const nodes = [
        { id: 'sellhub-1', type: 'sellhub', data: {} },
        { id: 'comp-1', type: 'compsourcecard', data: { hubId: 'sellhub-1' } },
        { id: 'ebay-1', type: 'marketplacecard', data: { hubId: 'sellhub-1', platformId: 'ebay' } },
        { id: 'facebook-1', type: 'marketplacecard', data: { hubId: 'sellhub-1', platformId: 'facebook' } },
        { id: 'other-card', type: 'marketplacecard', data: { hubId: 'sellhub-2', platformId: 'ebay' } },
      ];
      const edges = [
        { id: 'edge-comp', source: 'sellhub-1', target: 'comp-1' },
        { id: 'edge-ebay', source: 'sellhub-1', target: 'ebay-1' },
        { id: 'edge-facebook', source: 'sellhub-1', target: 'facebook-1' },
        { id: 'edge-other', source: 'sellhub-2', target: 'other-card' },
        { id: 'edge-cross-hub', source: 'sellhub-1', target: 'other-card' },
      ];
      let deletion = null;

      deleteChildrenByHubId({
        getNodes: () => nodes,
        getEdges: () => edges,
        deleteElements: (payload) => { deletion = payload; },
        hubId: 'sellhub-1',
        childTypes: ['compsourcecard'],
      });

      assert(deletion?.nodes?.map(n => n.id).join(',') === 'comp-1', 'refresh cleanup should delete only the ephemeral comp-source card');
      assert(deletion?.edges?.map(e => e.id).join(',') === 'edge-comp', 'refresh cleanup should delete only the comp-source edge');
      assert(!deletion.nodes.some(n => n.id === 'ebay-1' || n.id === 'facebook-1'), 'attached marketplace listing cards must survive refresh');
      assert(!deletion.edges.some(e => e.id === 'edge-ebay' || e.id === 'edge-facebook'), 'marketplace listing-card edges must remain attached');

      const deletedNodeIds = new Set(deletion.nodes.map(node => node.id));
      const deletedEdgeIds = new Set(deletion.edges.map(edge => edge.id));
      const remainingNodes = nodes.filter(node => !deletedNodeIds.has(node.id));
      const remainingEdges = edges.filter(edge => !deletedEdgeIds.has(edge.id));
      const checkAllCardIds = getConnectedHubCards({
        nodes: remainingNodes,
        edges: remainingEdges,
        hubId: 'sellhub-1',
        cardType: 'marketplacecard',
      }).map(card => card.id);

      assert(checkAllCardIds.join(',') === 'ebay-1,facebook-1',
        `Check All after refresh must target the same attached marketplace cards only — got ${checkAllCardIds.join(',')}`);
      return { preservedCards: checkAllCardIds };
    },
  },
  {
    name: 'Undo fingerprints ignore marketplace status checks',
    run: () => {
      const base = {
        id: 'm1',
        type: 'marketplacecard',
        position: { x: 0, y: 0 },
        data: {
          listingUrl: 'https://market.test/listing/1',
          status: 'unknown',
          statusMessage: '',
          lastChecked: '2026-01-01T00:00:00.000Z',
          attention: [],
          lastCheckTrace: { checked: 1 },
        },
      };
      const checked = {
        ...base,
        data: {
          ...base.data,
          status: 'live',
          statusMessage: 'Still live',
          lastChecked: '2026-01-02T00:00:00.000Z',
          attention: [{ urgency: 'low', category: 'watcher', headline: 'Watcher', evidence: '1 watcher' }],
          lastCheckTrace: { checked: 2 },
        },
      };
      assert(
        fingerprint({ nodes: [base], edges: [], drawings: [] }) === fingerprint({ nodes: [checked], edges: [], drawings: [] }),
        'Undo fingerprints ignore marketplace status checks: status-only changes should not dirty undo history'
      );

      const edited = { ...checked, data: { ...checked.data, listingUrl: 'https://market.test/listing/2' } };
      assert(
        fingerprint({ nodes: [base], edges: [], drawings: [] }) !== fingerprint({ nodes: [edited], edges: [], drawings: [] }),
        'Undo fingerprints ignore marketplace status checks: listing URL edits should remain undoable'
      );

      const restored = mergeNonRestorableNodeDataFromLive([base], [edited]);
      assert(restored[0].data.listingUrl === base.data.listingUrl, 'Undo restore should still restore undoable listing URL data');
      assert(restored[0].data.status === 'live' && restored[0].data.lastChecked === checked.data.lastChecked, 'Undo restore should preserve live status fields');
      assert(restored[0].data.lastCheckTrace.checked === 2, 'Undo restore should preserve live status trace');
      return { ok: true };
    },
  },
  {
    name: 'Legacy Job Search Module migration: relocate cascade → scoredJobs, drop orphans',
    run: () => {
      const legacy = [
        { id: 'doc', type: 'document', position: { x: 0, y: 0 }, data: { filePath: 'r.docx' } },
        { id: 'hub', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'done', resultCount: 3, resumeProfile: { id: 'P' } } },
        { id: 'L0', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', label: 'Strong', childIds: ['c1'] } },
        { id: 'c1', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub', title: 'Mid', company: 'A', url: 'u1', matchScore: 60, resumeProfile: { id: 'P' } } },
        { id: 'c2', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub', title: 'Top', company: 'B', url: 'u2', matchScore: 90 } },
        { id: 'c3', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub', title: 'Low', company: 'C', url: 'u3', matchScore: 30 } },
      ];
      const out = migrateLegacyJobHubResults(legacy);
      const hub = out.find(n => n.id === 'hub');
      const cascadeLeft = out.filter(n => n.type === 'jobcard' || n.type === 'jobgroup');
      assert(cascadeLeft.length === 0, `migration: orphaned cascade should be removed (left ${cascadeLeft.length})`);
      assert(Array.isArray(hub.data.scoredJobs) && hub.data.scoredJobs.length === 3, 'migration: hub should hold reconstructed scoredJobs');
      assert(hub.data.scoredJobs[0].matchScore === 90 && hub.data.scoredJobs[2].matchScore === 30, 'migration: scoredJobs sorted score-desc');
      assert(hub.data.scoredJobs[0].resumeProfile == null && hub.data.scoredJobs.find(j => j.url === 'u1').resumeProfile?.id === 'P', 'migration: per-card resumeProfile preserved');
      assert(out.find(n => n.id === 'doc'), 'migration: unrelated nodes untouched');

      // Idempotent / new-model untouched: a hub with scoredJobs and no cascade is the same reference.
      const newModel = [{ id: 'h2', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'done', scoredJobs: [{ title: 'x', matchScore: 1 }] } }];
      assert(migrateLegacyJobHubResults(newModel) === newModel, 'migration: new-model canvas returned unchanged (same ref)');
      assert(migrateLegacyJobHubResults(out) === out, 'migration: idempotent — re-running on migrated output is a no-op');
      return { scored: hub.data.scoredJobs.length };
    },
  },
  {
    name: 'runNodeMigrations: versioned, recurses into nested canvases, idempotent',
    run: () => {
      const legacyHub = (p) => ([
        { id: `${p}hub`, type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'done', resultCount: 2 } },
        { id: `${p}c1`, type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: `${p}hub`, title: 'A', url: `${p}u1`, matchScore: 70 } },
        { id: `${p}c2`, type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: `${p}hub`, title: 'B', url: `${p}u2`, matchScore: 30 } },
      ]);
      const nodes = [
        ...legacyHub('top-'),
        // new-format group whose nested canvas holds its OWN legacy hub + cascade
        { id: 'grp', type: 'group', position: { x: 0, y: 0 }, data: { canvasData: { nodes: legacyHub('inner-'), edges: [], drawings: [] } } },
      ];

      // v0 file → run all migrations; top-level AND nested hubs heal.
      const out = runNodeMigrations(nodes, 0);
      assert(out !== nodes, 'runNodeMigrations: migrated → new ref');
      const topHub = out.find(n => n.id === 'top-hub');
      assert(topHub.data.scoredJobs?.length === 2, 'runNodeMigrations: top-level hub → scoredJobs');
      assert(!out.some(n => n.type === 'jobcard'), 'runNodeMigrations: top-level cascade removed');
      const grp = out.find(n => n.id === 'grp');
      const innerHub = grp.data.canvasData.nodes.find(n => n.id === 'inner-hub');
      assert(innerHub.data.scoredJobs?.length === 2, 'runNodeMigrations: NESTED hub migrated (recursion into canvasData)');
      assert(!grp.data.canvasData.nodes.some(n => n.type === 'jobcard'), 'runNodeMigrations: nested cascade removed');

      // Current-version file → no migration eligible → SAME ref (clean files are free).
      assert(runNodeMigrations(out, CURRENT_SCHEMA_VERSION) === out, 'runNodeMigrations: current-version file is a same-ref no-op');

      // Idempotent by value: re-running from 0 over migrated output doesn't
      // duplicate scoredJobs or resurrect a cascade.
      const out2 = runNodeMigrations(out, 0);
      assert(out2.find(n => n.id === 'top-hub').data.scoredJobs.length === 2, 'runNodeMigrations: idempotent — scoredJobs not duplicated');
      assert(!out2.some(n => n.type === 'jobcard'), 'runNodeMigrations: idempotent — no cascade resurrected');
      return { current: CURRENT_SCHEMA_VERSION };
    },
  },
  {
    name: 'Node factory clone safety',
    run: () => {
      const source = {
        id: 'hub-a',
        type: 'jobhub',
        position: { x: 10, y: 20 },
        draggable: false,
        deletable: false,
        data: { locked: true, hubState: 'queued', queuedModuleRun: { position: 2 }, isNew: true },
      };
      const clone = cloneNode(source, 5, 6);
      assert(clone.id !== source.id, 'Node factory clone safety: clone should get a new id');
      assert(clone.position.x === 15 && clone.position.y === 26, 'Node factory clone safety: clone should be offset');
      assert(clone.data.locked === false && clone.draggable === undefined && clone.deletable === undefined, 'Node factory clone safety: clone should unlock');
      assert(clone.data.hubState === 'empty' && clone.data.isNew === false && !clone.data.queuedModuleRun, 'Node factory clone safety: active state/new flag should be sanitized');

      const group = {
        id: 'group-a',
        type: 'group',
        position: { x: 0, y: 0 },
        data: {
          canvasData: {
            nodes: [{ id: 'child-a', type: 'text', position: { x: 1, y: 1 }, data: {} }],
            edges: [{ id: 'edge-a', source: 'child-a', target: 'child-a' }],
            drawings: [{ id: 'draw-a', points: [] }],
          },
        },
      };
      const reassigned = reassignCanvasDataIDs(group);
      const childId = reassigned.data.canvasData.nodes[0].id;
      assert(childId !== 'child-a', 'Node factory clone safety: nested child id should be reassigned');
      assert(reassigned.data.canvasData.edges[0].source === childId && reassigned.data.canvasData.edges[0].target === childId, 'Node factory clone safety: nested edge endpoints should be remapped consistently');
      assert(reassigned.data.canvasData.drawings[0].id !== 'draw-a', 'Node factory clone safety: drawing ids should be reassigned');
      return { cloneIdChanged: clone.id !== source.id, childId };
    },
  },
  {
    name: 'Hub drop eligibility locks after initial input',
    run: () => {
      assert(canHubAcceptInitialDrop({ type: 'sellhub', data: { hubState: 'empty' } }), 'Hub drop eligibility: empty sellhub accepts initial photos');
      assert(!canHubAcceptInitialDrop({ type: 'sellhub', data: { hubState: 'empty', imagePaths: ['/tmp/a.jpg'] } }), 'Hub drop eligibility: sellhub with photos rejects later drops');
      const failedInitialPhotos = { type: 'sellhub', data: { hubState: 'empty', imagePaths: ['/tmp/too-large.jpg'], inputLocked: true, errorMessage: 'Image file too large after resizing' } };
      assert(canSellHubReplaceFailedInitialPhotos(failedInitialPhotos), 'Hub drop eligibility: failed initial sellhub photo analysis can be replaced');
      assert(canHubAcceptInitialDrop(failedInitialPhotos), 'Hub drop eligibility: failed initial sellhub photo analysis accepts replacement drop');
      assert(getHubFileDropMode(failedInitialPhotos) === 'initial-input', 'Hub drop eligibility: failed initial sellhub photo analysis routes replacement as initial input');
      assert(!canHubAcceptInitialDrop({ type: 'sellhub', data: { hubState: 'priced', product: { title: 'x' } } }), 'Hub drop eligibility: priced sellhub rejects later drops');
      assert(canSellHubAcceptDisplayPhotoDrop({ type: 'sellhub', data: { hubState: 'priced', product: { title: 'x' } } }), 'Hub drop eligibility: priced sellhub accepts display-photo drops');
      assert(!canSellHubAcceptDisplayPhotoDrop({ type: 'sellhub', data: { hubState: 'priced', locked: true } }), 'Hub drop eligibility: locked priced sellhub rejects display-photo drops');
      assert(getHubFileDropMode({ type: 'sellhub', data: { hubState: 'empty' } }) === 'initial-input', 'Hub drop eligibility: empty sellhub routes file drops as initial input');
      assert(getHubFileDropMode({ type: 'sellhub', data: { hubState: 'priced', product: { title: 'x' } } }) === 'display-photos', 'Hub drop eligibility: priced sellhub routes file drops as display photos');
      assert(getHubFileDropMode({ type: 'sellhub', data: { hubState: 'priced', locked: true } }) === null, 'Hub drop eligibility: locked priced sellhub does not route file drops');
      assert(getHubDropRejectLabel({ type: 'sellhub', data: { hubState: 'analyzing' } }) === 'Busy', 'Hub drop eligibility: active sellhub reports busy');

      assert(canHubAcceptInitialDrop({ type: 'jobhub', data: { hubState: 'empty' } }), 'Hub drop eligibility: empty jobhub accepts initial career files');
      assert(!canHubAcceptInitialDrop({ type: 'jobhub', data: { hubState: 'empty', inputLocked: true } }), 'Hub drop eligibility: jobhub preflight lock rejects a second drop');
      assert(!canHubAcceptInitialDrop({ type: 'jobhub', data: { hubState: 'done', resumeProfile: { skills: [] } } }), 'Hub drop eligibility: completed jobhub rejects later drops');
      assert(getHubFileDropMode({ type: 'jobhub', data: { hubState: 'empty' } }) === 'initial-input', 'Hub drop eligibility: empty jobhub routes file drops as initial input');
      assert(getHubFileDropMode({ type: 'jobhub', data: { hubState: 'done', resumeProfile: { skills: [] } } }) === null, 'Hub drop eligibility: completed jobhub does not route file drops');
      assert(getHubDropRejectLabel({ type: 'jobhub', data: { hubState: 'searching' } }) === 'Busy', 'Hub drop eligibility: active jobhub reports busy');
      return { checked: 18 };
    },
  },
  {
    name: 'Native text undo guard: opt-in module fields keep Ctrl/Cmd-Z even when empty',
    run: () => {
      const dom = new JSDOM('<div><input id="plain" value=""><input id="marked" data-native-undo="true" value=""><div data-native-undo="true"><textarea id="nested"></textarea></div><input id="checkbox" type="checkbox" data-native-undo="true"></div>');
      const doc = dom.window.document;
      assert(!shouldUseNativeTextUndo(doc.getElementById('plain')), 'plain empty input should still allow workspace undo');
      assert(shouldUseNativeTextUndo(doc.getElementById('marked')), 'marked empty input should keep native undo');
      assert(shouldUseNativeTextUndo(doc.getElementById('nested')), 'textarea under marked ancestor should keep native undo');
      assert(!shouldUseNativeTextUndo(doc.getElementById('checkbox')), 'checkbox is not a text undo target');
      return { ok: true };
    },
  },
  {
    name: 'Redo shortcuts: Ctrl/Cmd+Y and Ctrl/Cmd+Shift+Z are unconditional aliases',
    run: () => {
      const keyEvent = (key, overrides = {}) => ({
        key,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...overrides,
      });
      const custom = {
        undo: { meta: true, shift: false, alt: false, key: 'y' },
        redo: { meta: true, shift: false, alt: false, key: 'r' },
        redoAlt: { meta: true, shift: true, alt: false, key: 'r' },
      };

      assert(matchesRedoShortcut(keyEvent('y', { ctrlKey: true }), custom), 'Ctrl+Y should redo even after shortcuts are customized or conflict');
      assert(matchesRedoShortcut(keyEvent('z', { ctrlKey: true, shiftKey: true }), custom), 'Ctrl+Shift+Z should redo even after shortcuts are customized');
      assert(matchesRedoShortcut(keyEvent('Y', { metaKey: true }), custom), 'Cmd+Y should redo');
      assert(matchesRedoShortcut(keyEvent('Z', { metaKey: true, shiftKey: true }), custom), 'Cmd+Shift+Z should redo');
      assert(matchesRedoShortcut(keyEvent('r', { ctrlKey: true }), custom), 'custom redo bindings should remain supported');
      assert(!matchesRedoShortcut(keyEvent('z', { ctrlKey: true }), custom), 'Ctrl+Z must remain undo, not redo');
      return { ok: true };
    },
  },
  {
    name: 'Uncontrolled text sync: focused middle edits keep value and selection; unfocused external changes apply',
    run: () => {
      const dom = new JSDOM('<textarea id="notes"></textarea>');
      const notes = dom.window.document.getElementById('notes');
      notes.value = 'alpha beta';
      notes.setSelectionRange(5, 5);

      const focusedSync = syncUncontrolledTextValue(notes, 'stale parent value', true);
      assert(!focusedSync, 'focused notes should reject external synchronization');
      assert(notes.value === 'alpha beta', 'focused notes should preserve the live DOM edit');
      assert(notes.selectionStart === 5 && notes.selectionEnd === 5, 'focused notes should preserve the middle-edit caret');

      const unfocusedSync = syncUncontrolledTextValue(notes, 'workspace undo value', false);
      assert(unfocusedSync && notes.value === 'workspace undo value', 'unfocused notes should accept external undo/redo state');
      assert(!syncUncontrolledTextValue(notes, 'workspace undo value', false), 'equal external text should not rewrite the DOM');
      return { ok: true };
    },
  },
  {
    name: 'Source resolve queue: duplicate pending/active sources coalesce',
    run: () => {
      const ebay1 = { sourceId: 'ebay-sold', items: [1] };
      const ebay2 = { sourceId: 'ebay-sold', items: [2] };
      const swappa = { sourceId: 'swappa', items: [] };

      const first = enqueueUniqueSourceResolve([], ebay1);
      assert(first.status === 'added' && first.queue.length === 1, 'first source resolve should enqueue');
      const replaced = enqueueUniqueSourceResolve(first.queue, ebay2);
      assert(replaced.status === 'replaced' && replaced.queue.length === 1 && replaced.queue[0] === ebay2,
        'duplicate pending source should replace in place, not add a second rescrape');
      const second = enqueueUniqueSourceResolve(replaced.queue, swappa);
      assert(second.status === 'added' && second.queue.length === 2, 'different source should enqueue independently');
      const active = enqueueUniqueSourceResolve(second.queue, ebay1, new Set(['ebay-sold']));
      assert(active.status === 'active' && active.queue === second.queue, 'already-active source should not queue another retry');
      return { ok: true };
    },
  },
  {
    name: 'Geometry eraser math',
    run: () => {
      assert(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }) === 5, 'Geometry eraser math: point-to-segment distance mismatch');
      const ts = segmentCircleIntersections({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, 5);
      assert(ts.length === 2 && Math.abs(ts[0] - 0.25) < 1e-6 && Math.abs(ts[1] - 0.75) < 1e-6, 'Geometry eraser math: segment-circle intersections mismatch');
      const pieces = pixelEraseStroke({ id: 's', points: [{ x: -10, y: 0 }, { x: 10, y: 0 }] }, { x: 0, y: 0 }, 5);
      assert(pieces.length === 2, `Geometry eraser math: expected stroke split into 2 pieces, got ${pieces.length}`);
      assert(pieces[0].points.at(-1).x === -5 && pieces[1].points[0].x === 5, 'Geometry eraser math: split points should sit on eraser boundary');
      return { intersections: ts, pieces: pieces.length };
    },
  },
  {
    name: 'Layout geometry helpers',
    run: () => {
      assert(radialRadius({ count: 12, cardW: 140, cardH: 50, hubW: 260, hubH: 140 }) >= 223, 'Layout geometry helpers: radial radius should clear hub/cards');
      assert(CANVAS_ZOOM_LIMITS.min === 0.01 && CANVAS_ZOOM_LIMITS.max === 9.99, 'Canvas zoom limits should mirror Resolve-style 1%-999% viewer scale');
      assert(fitViewDuration(0) === 450 && fitViewDuration(100) === 900, 'Layout geometry helpers: fit duration clamp mismatch');
      assert(panDuration(0) === 260 && panDuration(5000) === 900, 'Layout geometry helpers: pan duration clamp mismatch');
      const vp = viewportForZoomAtScreenPoint({ x: -100, y: -50, zoom: 1 }, { x: 400, y: 300 }, 2);
      assert(vp.x === -600 && vp.y === -400 && vp.zoom === 2, 'Layout geometry helpers: center-anchored zoom viewport mismatch');
      assert(edgeZoneForRadius(10) === 8 && edgeZoneForRadius(1000) === 28, 'Layout geometry helpers: edge zone clamp mismatch');
      const spacing = gridSpacing([{ type: 'text' }, { type: 'listing' }]);
      assert(spacing.gutter >= 32 && spacing.gutter <= 80, 'Layout geometry helpers: grid spacing out of bounds');
      assert(spiralStep(1000, 20) === 240 && spiralStep(40, 40) === 60, 'Layout geometry helpers: spiral step clamp mismatch');
      return { radius: radialRadius({ count: 12, cardW: 140, cardH: 50, hubW: 260, hubH: 140 }), spacing };
    },
  },
  {
    name: 'Layout utilities',
    run: () => {
      const nodes = [
        { id: 'a', type: 'text', selected: true, position: { x: 100, y: 100 }, data: {} },
        { id: 'b', type: 'text', selected: true, position: { x: 10, y: 100 }, data: {} },
        { id: 'locked', type: 'text', selected: true, position: { x: 999, y: 999 }, data: { locked: true } },
      ];
      const tidied = computeTidiedNodes(nodes, true);
      assert(tidied.find(n => n.id === 'locked').position.x === 999, 'Layout utilities: locked nodes should not move');
      assert(tidied.find(n => n.id === 'b').position.x === 10, 'Layout utilities: leftmost selected node should anchor layout');
      const placement = findNonOverlappingPlacement(
        [{ id: 'drop', type: 'text', position: { x: 0, y: 0 }, data: {} }],
        [{ id: 'existing', type: 'text', position: { x: 0, y: 0 }, data: {} }],
      );
      assert(Number.isFinite(placement.anchorX) && Number.isFinite(placement.anchorY), 'Layout utilities: placement should be finite');
      assert(Math.abs(placement.anchorX) > 1 || Math.abs(placement.anchorY) > 1, 'Layout utilities: placement should move away from overlap');
      return { placement };
    },
  },
  {
    name: 'File display helpers',
    run: () => {
      assert(toLocalFileUrl('/tmp/a b#c?.png') === 'local-file:///tmp/a%20b%23c%3F.png', 'File display helpers: local file URL encoding mismatch');
      assert(getFileCategoryInfo('photo.HEIC').category === FILE_CATEGORIES.IMAGE, 'File display helpers: HEIC should be image');
      assert(getFileCategoryInfo('script.tsx').category === FILE_CATEGORIES.CODE, 'File display helpers: TSX should be code');
      assert(getFileCategoryInfo('report.pdf').label === 'PDF Document', 'File display helpers: PDF label mismatch');
      assert(getFileCategoryInfo('unknown').badge === 'FILE', 'File display helpers: extensionless badge mismatch');
      return { image: getFileCategoryInfo('photo.HEIC').label };
    },
  },
  {
    name: 'Missing preview relink uses exact nearest filename and refuses ambiguity',
    run: () => {
      const root = path.join(os.tmpdir(), `ic-preview-relink-${process.pid}-${Date.now()}`);
      const original = path.join(root, 'photo.jpg');
      const moved = path.join(root, 'products', 'archived', 'photo.jpg');
      const ambiguousRoot = path.join(root, 'ambiguous');
      try {
        fs.mkdirSync(path.dirname(moved), { recursive: true });
        fs.writeFileSync(moved, 'image');
        fs.mkdirSync(path.join(ambiguousRoot, 'a'), { recursive: true });
        fs.mkdirSync(path.join(ambiguousRoot, 'b'), { recursive: true });
        fs.writeFileSync(path.join(ambiguousRoot, 'a', 'duplicate.jpg'), 'a');
        fs.writeFileSync(path.join(ambiguousRoot, 'b', 'duplicate.jpg'), 'b');

        clearMissingPreviewRelinkCache();
        const found = resolveMissingPreviewPath(original);
        assert(found.status === 'found' && found.path === moved, `missing preview should relink to exact descendant filename -> ${JSON.stringify(found)}`);
        const cached = resolveMissingPreviewPath(original);
        assert(cached.cached === true && cached.path === moved, 'repeated preview requests should reuse the bounded relink cache');

        const wrongCase = findExactFilenameBelow(root, 'Photo.jpg');
        assert(wrongCase.status === 'not-found', 'missing preview relink should require an exact case-sensitive filename');

        const ambiguous = findExactFilenameBelow(ambiguousRoot, 'duplicate.jpg');
        assert(ambiguous.status === 'ambiguous' && ambiguous.path === null && ambiguous.matches.length === 2, 'same-depth duplicate filenames should be left unresolved');
        return { found: path.relative(root, found.path), ambiguous: ambiguous.matches.length };
      } finally {
        clearMissingPreviewRelinkCache();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'SellHub display photo path edits',
    run: () => {
      const original = ['/tmp/a.jpg', '  /tmp/b.jpg  ', '/tmp/a.jpg', '', null];
      assert(JSON.stringify(normalizePhotoPathList(original)) === JSON.stringify(['/tmp/a.jpg', '/tmp/b.jpg']), 'photo paths should normalize, trim, and dedupe');
      assert(JSON.stringify(removePhotoPathAt(original, 0)) === JSON.stringify(['/tmp/b.jpg']), 'remove should use visible normalized index');
      assert(JSON.stringify(removePhotoPathAt(original, 99)) === JSON.stringify(['/tmp/a.jpg', '/tmp/b.jpg']), 'out-of-range remove should be a no-op');
      assert(JSON.stringify(appendPhotoPaths(original, ['/tmp/c.jpg', '/tmp/b.jpg'])) === JSON.stringify(['/tmp/a.jpg', '/tmp/b.jpg', '/tmp/c.jpg']), 'append should add replacements without duplicates');
      const displayDrop = appendPhotoFiles(['/tmp/a.jpg'], [{ filePath: '/tmp/a.jpg' }, { filePath: '/tmp/c.jpg' }, { path: '/tmp/d.jpg' }]);
      assert(JSON.stringify(displayDrop.imagePaths) === JSON.stringify(['/tmp/a.jpg', '/tmp/c.jpg', '/tmp/d.jpg']), 'display photo file append should accept canvas-node filePath and file path payloads');
      assert(displayDrop.accepted === 3 && displayDrop.added === 2, `display photo file append should report accepted/added counts -> ${JSON.stringify(displayDrop)}`);
      return { ok: true };
    },
  },
  {
    name: 'File drop helpers preserve payload pairing and centralize image filtering',
    run: () => {
      const resolver = (file) => file.systemPath || '';
      const files = [
        { name: 'resume.pdf', type: 'application/pdf', size: 123, systemPath: '/tmp/resume.pdf' },
        { filename: 'front.HEIC', filePath: ' /tmp/front.HEIC ' },
        { name: 'notes.txt', systemPath: '/tmp/notes.txt' },
        { name: 'missing.jpg', systemPath: '' },
        { filename: 'nested.JPG', filePath: '/tmp/nested.JPG' },
      ];
      assert(getLocalFilePath(files[0], resolver) === '/tmp/resume.pdf', 'resolver fallback should return trimmed system paths');
      const payloads = filesToDropPayloads(files, resolver);
      assert(JSON.stringify(payloads.map(f => [f.name, f.path])) === JSON.stringify([
        ['resume.pdf', '/tmp/resume.pdf'],
        ['front.HEIC', '/tmp/front.HEIC'],
        ['notes.txt', '/tmp/notes.txt'],
        ['nested.JPG', '/tmp/nested.JPG'],
      ]), 'drop payloads should keep names paired with filtered valid paths');
      assert(JSON.stringify(summarizeFileExtensions(files)) === JSON.stringify(['.pdf', '.heic', '.txt', '.jpg', '.jpg']), 'extension summaries should support name/filename payloads');
      assert(JSON.stringify(filesToProductImagePaths(files, resolver)) === JSON.stringify(['/tmp/front.HEIC', '/tmp/nested.JPG']), 'product-image paths should filter and normalize accepted image drops');
      return { ok: true };
    },
  },
  {
    name: 'Job date and cap helpers',
    run: () => {
      const twoDaysAgo = parsePostedDate('2 days ago');
      const twoMonthsAgo = parsePostedDate('2mo ago');
      const minutesAgo = parsePostedDate('5m ago');
      assert(twoDaysAgo && Date.now() - twoDaysAgo.getTime() >= 1.5 * 86400000, 'Job date and cap helpers: days parsing mismatch');
      assert(twoMonthsAgo && Date.now() - twoMonthsAgo.getTime() >= 50 * 86400000, 'Job date and cap helpers: months parsing mismatch');
      assert(minutesAgo && Date.now() - minutesAgo.getTime() < 86400000, 'Job date and cap helpers: minutes should be today');
      const filtered = filterJobsByAge([
        { title: 'keep', posted: 'today' },
        { title: 'drop', posted: '90 days ago' },
        { title: 'unknown', posted: 'some weird source text' },
      ], 30);
      assert(filtered.map(j => j.title).join(',') === 'keep,unknown', 'Job date and cap helpers: age filter should keep recent and unknown dates');
      // compsForPricing is unbounded — a small set passes through in full...
      const cSmall = compsForPricing(8, 4);
      assert(cSmall.sold === 8 && cSmall.active === 4, 'Job date and cap helpers: small comp set should pass through unbounded');
      // ...and a large set is bounded ONLY by the synthesis token budget (scaled
      // proportionally, well above the old 25/15 caps), and the count actually fed
      // must always receive a NON-clamped budget (i.e. it can't truncate).
      const cBig = compsForPricing(1000, 1000);
      assert(cBig.sold === cBig.active && cBig.sold > 15, 'Job date and cap helpers: large comp set should scale proportionally above the old caps');
      assert(priceSynthesisMaxTokens(cBig.sold + cBig.active) < 24576, 'Job date and cap helpers: fed comp count must fit the synthesis token budget (no clamp/truncate)');
      assert(jobScoringBatchSize() >= 5 && jobScoringBatchSize() <= 15, 'Job date and cap helpers: scoring batch out of bounds');
      assert(JOB_MAX_PAGES === 10 && JOB_PER_PAGE_CAP > 0, 'Job date and cap helpers: job caps unexpected');
      return { filtered: filtered.length, scoringBatch: jobScoringBatchSize() };
    },
  },
  {
    name: 'resultCaps: jobScoringBatchSize scales with the serving model',
    run: () => {
      const claude = jobScoringBatchSize('claude-sonnet-4-6');
      const gemini = jobScoringBatchSize('gemini-3.5-flash');
      const missing = jobScoringBatchSize();
      assert(gemini === 15, `gemini Flash stays at the calibrated 15 (got ${gemini})`);
      assert(missing === 15, `missing model → conservative default 15 (got ${missing})`);
      assert(claude === 30, `Claude (stronger, leaner output) scores more per call (got ${claude})`);
      assert(claude > gemini, 'a stronger model gets a larger batch than thinking-heavy Flash');
      // Bounds hold for every known scoring-capable model id, and the size never
      // exceeds what the output-token cap can honor (so a batch can't truncate).
      const PER_JOB_FLOOR = 200, CAP = 24576, BASE = 2500, SAFETY = 0.8;
      const outBudgetMax = Math.floor((CAP * SAFETY - BASE) / PER_JOB_FLOOR);
      for (const m of ['claude-opus-4-8', 'claude-haiku-4-5-20251001', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite']) {
        const n = jobScoringBatchSize(m);
        assert(n >= 5 && n <= 30, `${m} batch ${n} within [5,30]`);
        assert(n <= outBudgetMax, `${m} batch ${n} fits the output-token budget (≤${outBudgetMax})`);
      }
      return { claude, gemini, missing };
    },
  },
  {
    name: 'Job board relevance filtering',
    run: () => {
      const geoTerms = buildGeoTermSet(['Denver, CO', 'hybrid in Chicago']);
      assert(geoTerms.has('denver') && geoTerms.has('chicago'), 'Job board relevance filtering: geo terms should include city tokens');
      assert(!geoTerms.has('co'), 'Job board relevance filtering: short state token should be ignored');
      assert(
        !jobRelevanceMatch('Account Executive - Denver', 'Junior Cinematographer Denver', geoTerms),
        'Job board relevance filtering: location/seniority tokens should not pull unrelated board roles',
      );
      assert(
        jobRelevanceMatch('Senior Cinematographer', 'Junior Cinematographer Denver', geoTerms),
        'Job board relevance filtering: surviving role noun should match',
      );
      assert(
        !jobRelevanceMatch('Account Executive - Chicago', 'Product Designer Chicago', geoTerms),
        'Job board relevance filtering: preferred-location token should not become role relevance',
      );
      assert(
        jobRelevanceMatch('Engineering Manager', 'Senior Manager', new Set()),
        'Job board relevance filtering: all-generic role query should still fall back rather than match nothing',
      );
      return { geoTerms: [...geoTerms].sort(), fallback: true };
    },
  },
  {
    name: 'Job source test-mode env parsing',
    run: () => {
      const off = createJobSearchTestMode({});
      assert(off.enabled === false && off.sourceId === null, 'Job source test-mode env parsing: default should be production/all-source mode');
      const disabledWithSource = createJobSearchTestMode({ JOB_SEARCH_TEST_SOURCE: 'linkedin' });
      assert(disabledWithSource.sourceId === null, 'Job source test-mode env parsing: source should be ignored unless enabled');
      const full = createJobSearchTestMode({
        JOB_SEARCH_TEST_ENABLED: 'true',
        JOB_SEARCH_TEST_SOURCE: 'linkedin',
        JOB_SEARCH_TEST_FULL_RUN: '1',
        JOB_SEARCH_TEST_SKIP_AI: 'yes',
      });
      assert(full.enabled && full.sourceId === 'linkedin' && full.fullRun && full.skipAI, 'Job source test-mode env parsing: plain env values not parsed');
      assert(full.fast === false, 'Job source test-mode env parsing: fast should default false');
      const vite = createJobSearchTestMode({
        VITE_JOB_SEARCH_TEST_ENABLED: 'on',
        VITE_JOB_SEARCH_TEST_SOURCE: 'indeed',
        VITE_JOB_SEARCH_TEST_FULL_RUN: '0',
      });
      assert(vite.enabled && vite.sourceId === 'indeed' && !vite.fullRun, 'Job source test-mode env parsing: VITE env values not parsed');
      assert(parseJobSearchEnvBoolean('not-a-bool', true) === true, 'Job source test-mode env parsing: invalid bool should use fallback');
      // FAST mode: parsed from its own flag, independent of fullRun. Precedence
      // (fast wins over medium/full) lives in resultCaps.js, not this parser.
      const fast = createJobSearchTestMode({
        JOB_SEARCH_TEST_ENABLED: 'true',
        JOB_SEARCH_TEST_SOURCE: 'glassdoor',
        JOB_SEARCH_TEST_FAST: 'true',
      });
      assert(fast.enabled && fast.fast === true && fast.sourceId === 'glassdoor' && !fast.fullRun, 'Job source test-mode env parsing: FAST flag not parsed');
      const viteFast = createJobSearchTestMode({ VITE_JOB_SEARCH_TEST_ENABLED: '1', VITE_JOB_SEARCH_TEST_FAST: 'on' });
      assert(viteFast.fast === true, 'Job source test-mode env parsing: VITE FAST flag not parsed');
      return { defaultEnabled: off.enabled, fullSource: full.sourceId, viteSource: vite.sourceId, fast: fast.fast };
    },
  },
  {
    name: 'Marketplace source test-mode env parsing',
    run: () => {
      const off = createMarketplaceTestMode({});
      assert(off.enabled === false && off.sourceId === null, 'Marketplace test-mode: default should be production/all-source mode');
      const disabledWithSource = createMarketplaceTestMode({ MARKETPLACE_TEST_SOURCE: 'ebay-sold' });
      assert(disabledWithSource.sourceId === null, 'Marketplace test-mode: source should be ignored unless enabled');
      const on = createMarketplaceTestMode({ MARKETPLACE_TEST_ENABLED: 'true', MARKETPLACE_TEST_SOURCE: 'ebay-sold' });
      assert(on.enabled && on.sourceId === 'ebay-sold', 'Marketplace test-mode: plain env values not parsed');
      const vite = createMarketplaceTestMode({ VITE_MARKETPLACE_TEST_ENABLED: '1', VITE_MARKETPLACE_TEST_SOURCE: 'reverb' });
      assert(vite.enabled && vite.sourceId === 'reverb', 'Marketplace test-mode: VITE env values not parsed');
      assert(parseMarketplaceEnvBoolean('not-a-bool', true) === true, 'Marketplace test-mode: invalid bool should use fallback');
      // The module singleton sees no env vars in the test process, so scope is a
      // passthrough — every source stays enabled (production behavior).
      assert(getScopedCompSourceIds(['ebay-sold', 'reverb']).length === 2, 'Marketplace test-mode: disabled scope returns all sources');
      assert(isCompSourceEnabledInScope('ebay-sold') === true, 'Marketplace test-mode: disabled scope enables every source');
      return { defaultEnabled: off.enabled, targetSource: on.sourceId, viteSource: vite.sourceId };
    },
  },
  {
    name: 'Job auth preflight sources',
    run: () => {
      const required = getJobAuthPreflightSourceIds(ids => ids);
      assert(!required.includes('linkedin'), 'Job auth preflight sources: LinkedIn should not block anonymous public job search');
      assert(required.includes('indeed') && required.includes('glassdoor'), 'Job auth preflight sources: browser sources should still be gated');
      const scopedLinkedIn = getJobAuthPreflightSourceIds(ids => ids.filter(id => id === 'linkedin'));
      assert(scopedLinkedIn.length === 0, 'Job auth preflight sources: LinkedIn-only test scope should require no login preflight');
      const scopedIndeed = getJobAuthPreflightSourceIds(ids => ids.filter(id => id === 'indeed'));
      assert(scopedIndeed.join(',') === 'indeed', 'Job auth preflight sources: source scope should still gate required browser sources');
      return { required: JOB_AUTH_PREFLIGHT_SOURCE_IDS.length, scopedLinkedIn: scopedLinkedIn.length };
    },
  },
  {
    name: 'Bug report code filtering',
    run: () => {
      const logs = [
        '00:00 User clicked save',
        '00:01 normal interaction',
        '00:02 Error: failed to save workspace',
        '00:03 recovery toast shown',
        '00:04 unrelated tail',
      ];
      const full = applyBugReportCode(logs, {}, 'FULL');
      assert(full.filteredLogs === logs && full.matchedCodes.includes('FULL'), 'Bug report code filtering: FULL should keep original logs');
      const filtered = applyBugReportCode(logs, {}, 'ERR+QUICK');
      assert(filtered.filteredLogs.length <= logs.length && filtered.matchedCodes.includes('ERR'), 'Bug report code filtering: ERR+QUICK should match ERR');
      const text = applyBugReportCode([...logs, '[TextEdit] input field=hub:primary type=historyUndo len=4 selection=2-2'], {}, 'TEXT');
      assert(text.filteredLogs.some(line => line.includes('[TextEdit]')) && text.matchedCodes.includes('TEXT'), 'Bug report code filtering: TEXT should retain text-edit diagnostics');
      const viewport = applyBugReportCode([...logs, 'viewport changed source=programmatic zoom=0.2818 x=-181.31 y=237.18'], {}, 'VIEWPORT');
      assert(viewport.filteredLogs.some(line => line.includes('viewport changed')) && viewport.matchedCodes.includes('VIEWPORT'), 'Bug report code filtering: VIEWPORT should retain zoom/pan diagnostics');
      const preview = previewBugReportCode(logs, 'ERR+NOPE');
      assert(preview.unknownCodes.includes('NOPE') && preview.valid, 'Bug report code filtering: preview should report unknown codes while keeping valid matches');
      return { filtered: filtered.filteredLogs.length, unknown: preview.unknownCodes };
    },
  },
  {
    name: 'Job identity helpers',
    run: () => {
      const a = { title: ' Senior Engineer ', company: 'Acme ', location: ' Denver ', url: ' HTTPS://EXAMPLE.COM/JOB ' };
      const b = { title: 'senior engineer', company: 'acme', location: 'denver', url: 'https://example.com/job' };
      const c = { title: 'Senior Engineer', company: 'Acme', location: 'Remote', url: 'https://example.com/job-2' };
      assert(jobTitleCompanyKey(a) === 'senior engineer|acme', 'Job identity helpers: title/company key should normalize case and whitespace');
      assert(jobTitleCompanyUrlKey(a) === jobTitleCompanyUrlKey(b), 'Job identity helpers: URL key should normalize case and whitespace');
      assert(jobTitleCompanyLocationKey(a) === jobTitleCompanyLocationKey(b), 'Job identity helpers: location key should normalize case and whitespace');
      assert(jobTitleCompanyLocationKey(a) !== jobTitleCompanyLocationKey(c), 'Job identity helpers: location key should keep distinct locations');

      const deduped = dedupeJobsByKey([a, b, c], jobTitleCompanyKey);
      assert(deduped.length === 1, `Job identity helpers: expected title/company dedupe to keep 1, got ${deduped.length}`);
      const fresh = uniqueJobsNotIn([a], [b, c], jobTitleCompanyUrlKey);
      assert(fresh.length === 1 && fresh[0] === c, 'Job identity helpers: uniqueJobsNotIn should preserve only unseen candidates');
      return { deduped: deduped.length, fresh: fresh.length };
    },
  },
  {
    name: 'Source progress merge',
    run: () => {
      const first = mergeSourceProgress(null, {
        status: 'searching',
        count: 0,
        warning: { code: 'captcha', severity: 'block' },
        url: 'https://example.com/jobs',
        detail: 'page 1',
        completed: 0,
        total: 10,
      });
      const terminal = mergeSourceProgress(first, { status: 'done', count: 12 });
      assert(terminal.warning?.code === 'captcha', 'Source progress merge: warning should stay sticky when omitted');
      assert(terminal.url === 'https://example.com/jobs', 'Source progress merge: url should stay sticky when omitted');
      assert(terminal.detail === null, 'Source progress merge: detail should not stay sticky');
      assert(terminal.completed === 0 && terminal.total === 10, 'Source progress merge: completed/total should stay sticky when omitted');
      const advanced = mergeSourceProgress(terminal, { status: 'searching', count: 12, completed: 4, total: 10 });
      assert(advanced.completed === 4 && advanced.total === 10, 'Source progress merge: completed/total should update when provided');
      const cleared = mergeSourceProgress(terminal, { status: 'done', count: 12, warning: null, url: null });
      assert(cleared.warning === null && cleared.url === null, 'Source progress merge: explicit null should clear sticky fields');
      return { terminal, advanced, cleared };
    },
  },
  {
    name: 'Job card filters',
    run: () => {
      const job = { source: 'indeed', matchScore: 72, status: 'New' };
      assert(isJobCardVisible(job, { sourceFilter: 'indeed', scoreThreshold: 70 }), 'Job card filters: matching source and score should be visible');
      assert(!isJobCardVisible(job, { sourceFilter: 'linkedin' }), 'Job card filters: non-matching source should be hidden');
      assert(!isJobCardVisible(job, { scoreThreshold: 80 }), 'Job card filters: score below threshold should be hidden');
      assert(isJobCardVisible({ ...job, status: undefined }, { statusFilters: ['New'] }), 'Job card filters: missing status should default to New');
      assert(!isJobCardVisible(job, { statusFilters: ['Filled'] }), 'Job card filters: non-matching status should be hidden');
      return { ok: true };
    },
  },
  {
    name: 'anthropicRequest: buildCachedUserContent splits the cached prefix into an ephemeral block',
    run: () => {
      const arr = [{ type: 'image' }];
      assert(buildCachedUserContent('hi', null) === 'hi', 'no prefix → string passthrough');
      assert(buildCachedUserContent(arr, null) === arr, 'no prefix → array passthrough (same ref)');
      const s = buildCachedUserContent('JOBS', 'PROFILE');
      assert(Array.isArray(s) && s.length === 2, 'string + prefix → 2 blocks');
      assert(s[0].type === 'text' && s[0].text === 'PROFILE' && s[0].cache_control?.type === 'ephemeral', 'prefix block is ephemeral-cached');
      assert(s[1].type === 'text' && s[1].text === 'JOBS', 'second block is the dynamic content');
      const a = buildCachedUserContent([{ type: 'image' }, { type: 'text', text: 'p' }], 'PFX');
      assert(a.length === 3 && a[0].cache_control?.type === 'ephemeral' && a[1].type === 'image', 'array + prefix → prefix prepended to media blocks');
      return { ok: true };
    },
  },
  {
    name: 'anthropicRequest: buildAnthropicMessageParams builds the identical live/batch request shape',
    run: () => {
      const base = { model: 'claude-sonnet-4-6', maxTokens: 8000, cachedPrefix: 'PROFILE' };
      const schema = { type: 'object', properties: {} };
      // responseSchema → forced submit_response tool, no JSON prefill.
      const p1 = buildAnthropicMessageParams('JOBS', { ...base, responseSchema: schema });
      assert(p1.model === 'claude-sonnet-4-6' && p1.max_tokens === 8000, 'carries model + max_tokens');
      assert(p1.tools?.[0]?.name === 'submit_response' && p1.tools[0].input_schema === schema, 'responseSchema → submit_response tool');
      assert(p1.tool_choice?.type === 'tool' && p1.tool_choice?.name === 'submit_response', 'responseSchema → forced tool_choice');
      assert(p1.messages.length === 1, 'tool-use mode adds no assistant prefill');
      assert(p1.messages[0].content[0].cache_control?.type === 'ephemeral', 'cached prefix carried into params');
      // expectJson (no schema) → assistant "{" prefill, no tools.
      const p2 = buildAnthropicMessageParams('X', { model: 'm', maxTokens: 100, expectJson: true });
      assert(!p2.tools && p2.messages.length === 2 && p2.messages[1].role === 'assistant' && p2.messages[1].content === '{', 'expectJson → "{" prefill');
      // plain → single user turn, no envelope.
      const p3 = buildAnthropicMessageParams('X', { model: 'm', maxTokens: 100 });
      assert(!p3.tools && !p3.tool_choice && p3.messages.length === 1, 'plain → single user message, no envelope');
      return { ok: true };
    },
  },
  {
    name: 'compSourceScope: normalizeCompWarnings preserves every exact blocked source',
    run: () => {
      assert(ALL_COMP_SOURCE_IDS.includes('swappa-sold') && ALL_COMP_SOURCE_IDS.includes('swappa'),
        'Swappa sold and active must have separate source cards/retry actions');
      const cards = ['ebay-sold', 'ebay-active', 'swappa-sold', 'swappa', 'reverb'];
      const out1 = normalizeCompWarnings([{ sourceId: 'swappa-sold', code: 'zero-extracted', severity: 'block' }], cards);
      assert(out1.length === 1 && out1[0].sourceId === 'swappa-sold', `swappa-sold stays exact (got ${out1[0]?.sourceId})`);
      assert(out1[0].code === 'zero-extracted' && out1[0].severity === 'block', 'warning fields preserved');
      // A real card warning is kept untouched (same ref).
      const w = { sourceId: 'ebay-sold', code: 'x' };
      const out2 = normalizeCompWarnings([w], cards);
      assert(out2.length === 1 && out2[0] === w, 'real card warning kept as-is (same ref)');
      // Sold and active variants are separate sources and both remain blocked.
      const out4 = normalizeCompWarnings([{ sourceId: 'swappa', code: 'a' }, { sourceId: 'swappa-sold', code: 'b' }], cards);
      assert(out4.length === 2, 'distinct sold/active source warnings must never collapse');
      // Unexpected sources remain blocked rather than silently pricing without them.
      const orphan = normalizeCompWarnings([{ sourceId: 'unexpected-source', code: 'x' }], cards);
      assert(orphan.length === 1 && orphan[0].sourceId === 'unexpected-source', 'unexpected source warning is preserved');
      // Multiple item-query warnings for one exact source share one source retry.
      assert(normalizeCompWarnings([{ sourceId: 'ebay-sold', code: 'a' }, { sourceId: 'ebay-sold', code: 'b' }], cards).length === 1,
        'duplicate warnings for one exact source collapse to one retry action');
      return { ok: true };
    },
  },
  {
    name: 'nodePresence: resolveNodePresence prefers stamped filterStats over a dropped nodes section',
    run: () => {
      // No filter, nodes intact → scan nodes.
      const scanned = resolveNodePresence({ nodes: [{ type: 'sellhub' }, { type: 'text' }] });
      assert(scanned.hasSellNodes === true && scanned.hasJobNodes === false, 'scans nodes when no flags present');
      // The bug: a filter code (MARKET/JOBS) drops the nodes section; the stamped
      // flags must still drive the module-section gates.
      const stamped = resolveNodePresence({ filterStats: { hasSellNodes: true, hasJobNodes: false } });
      assert(stamped.hasSellNodes === true && stamped.hasJobNodes === false, 'uses stamped flags when nodes absent');
      const jobs = resolveNodePresence({ nodes: [{ type: 'jobhub' }, { type: 'jobboard' }] });
      assert(jobs.hasJobNodes === true && jobs.hasSellNodes === false, 'jobhub/jobboard count as job nodes');
      // ?? not || — a genuine false from a node-less canvas is respected.
      const empty = resolveNodePresence({ filterStats: { hasJobNodes: false, hasSellNodes: false }, nodes: [] });
      assert(empty.hasJobNodes === false && empty.hasSellNodes === false, 'genuine false flag respected');
      return { ok: true };
    },
  },
  {
    name: 'dashboardStats: getStats uses combined bundle price and single-item recommended_price',
    run: () => {
      const nodes = [
        { type: 'jobcard', data: {} },
        { type: 'jobcard', data: {} },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: 250 } } },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: '99.5' } } },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: null } } }, // no-comps → 0
        { type: 'sellhub', data: { hubState: 'draft', pricing: { recommended_price: 999 } } },    // not priced → excluded
        { type: 'sellhub', data: { hubState: 'priced', userPrice: 500 } },                        // legacy/wrong field → 0
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: 20 }, bundleTotal: 42, bundlePricing: { bundle_price: 40 } } },
      ];
      const { jobCardsCount, sellHubsCount, totalValue } = getStats(nodes);
      assert(jobCardsCount === 2, `getStats: jobCardsCount should be 2, got ${jobCardsCount}`);
      assert(sellHubsCount === 6, `getStats: sellHubsCount should be 6, got ${sellHubsCount}`);
      assert(totalValue === 389.5, `getStats: totalValue should include the $40 combined bundle price, got ${totalValue}`);
      return { totalValue };
    },
  },
  {
    name: 'Batch scoring reconciliation',
    run: () => {
      const batches = [
        [{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }], // b0 — both scored
        [{ url: 'c', title: 'C' }],                            // b1 — whole request failed
        [{ url: 'd', title: 'D' }, { url: 'e', title: 'E' }], // b2 — index 1 missing
      ];
      const results = {
        b0: { scores: [
          { index: 0, matchScore: 90, reasoning: 'great', careerDirection: 'X' },
          { index: 1, matchScore: 40, reasoning: 'meh', careerDirection: 'Y' },
        ] },
        b1: null, // errored/expired batch request
        b2: { scores: [{ index: 0, matchScore: 70, reasoning: 'ok', careerDirection: 'Z' }] },
      };
      const { scoredJobs, placeholderCount, failedBatches } = reconcileBatchScores(batches, results, { fallbackScore: 50 });
      assert(scoredJobs.length === 5, `Batch reconcile: expected 5 scored, got ${scoredJobs.length}`);
      assert(failedBatches === 1, `Batch reconcile: expected 1 failed batch, got ${failedBatches}`);
      assert(placeholderCount === 2, `Batch reconcile: expected 2 placeholders, got ${placeholderCount}`);
      assert(scoredJobs[0].matchScore === 90 && scoredJobs[0].url === 'a', 'Batch reconcile: results sorted desc by score');
      const cJob = scoredJobs.find(j => j.url === 'c');
      assert(cJob.matchScore === 50 && cJob.reasoning === 'AI format error', 'Batch reconcile: failed-batch job → AI format error placeholder');
      const eJob = scoredJobs.find(j => j.url === 'e');
      assert(eJob.matchScore === 50 && eJob.reasoning === 'Unable to score', 'Batch reconcile: missing-index job → Unable to score placeholder');
      const bJob = scoredJobs.find(j => j.url === 'b');
      assert(bJob.matchScore === 40 && bJob.careerDirection === 'Y', 'Batch reconcile: matched score fields spread onto the job');
      return { scored: scoredJobs.length, placeholderCount, failedBatches };
    },
  },
  {
    name: 'Job source resolve merge',
    run: () => {
      const existing = [
        { title: 'Indeed A', company: 'Acme', url: 'https://jobs/a', source: 'indeed' },
        { title: 'LinkedIn A', company: 'Acme', url: 'https://jobs/li-a', source: 'linkedin', snippet: '' },
        { title: 'Other', company: 'Beta', url: 'https://jobs/b', source: 'remoteok' },
      ];
      const incremental = mergeResolvedSourceItems(existing, [
        { title: 'Indeed B', company: 'Acme', url: 'https://jobs/indeed-b', source: 'indeed' },
      ], 'indeed');
      assert(incremental.replacedExisting === 0, 'Job source resolve merge: incremental source should not drop existing same-source jobs');
      assert(incremental.mergedPending.filter(j => j.source === 'indeed').length === 2, 'Job source resolve merge: incremental source should append fresh jobs');

      const replacement = mergeResolvedSourceItems(existing, [
        { title: 'LinkedIn A', company: 'Acme', url: 'https://jobs/li-a', source: 'linkedin', snippet: 'full description' },
        { title: 'LinkedIn B', company: 'Acme', url: 'https://jobs/li-b', source: 'linkedin', snippet: 'full description' },
      ], 'linkedin', { replaceSourceItems: true });
      assert(replacement.replacedExisting === 1, 'Job source resolve merge: replacement source should drop stale same-source jobs');
      assert(replacement.mergedPending.filter(j => j.source === 'linkedin').length === 2, 'Job source resolve merge: replacement source should use returned full source set');
      return { incremental: incremental.mergedPending.length, replacement: replacement.mergedPending.length };
    },
  },
  {
    name: 'Job partitioning: display set = ALL scored jobs (target ≡ no-target; no gate, fill, or split)',
    run: () => {
      // Target and no-target runs are identical post-scoring: every scored job is
      // displayed, nothing gated/filled/hidden, no target/other partition. A target
      // role only adds queries upstream. partitionJobsForBranches is a passthrough.
      const jobs = [
        { title: 'A', company: 'Co', url: '1', matchScore: 90 },
        { title: 'B', company: 'Co', url: '2', matchScore: 30 },
        { title: 'C', company: 'Co', url: '3', matchScore: 80 },
        { title: 'D', company: 'Co', url: '4', matchScore: 12 },  // low score — STILL shown (no gate)
      ];
      const out = partitionJobsForBranches(jobs);
      assert(out.displayedJobs.length === jobs.length, `must show all ${jobs.length} jobs, got ${out.displayedJobs.length}`);
      assert(out.displayedJobs === jobs, 'displayedJobs is the scored set itself (pure passthrough)');
      assert(out.targetList === undefined && out.otherList === undefined, 'no target/other split fields anymore');
      return { displayed: out.displayedJobs.length };
    },
  },
  {
    name: 'Job tree: likelihood → salary → role hierarchy',
    run: () => {
      const mk = (title, score, salary, url) => ({
        title, company: 'Acme', location: 'Remote', salary, snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today',
      });
      // idx0 strong+highpay+Brand, idx1 strong+lowpay+Growth, idx2 weak+nopay+Brand
      const displayedJobs = [
        mk('Brand Lead', 92, '$150,000 a year', 'https://jobs/0'),
        mk('Growth Mgr', 88, '$70,000 a year', 'https://jobs/1'),
        mk('Brand Intern', 30, '', 'https://jobs/2'),
      ];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [
            { label: 'Strong (70–100%)', minScore: 70, maxScore: 100 },
            { label: 'Long shot (0–69%)', minScore: 0, maxScore: 69 },
          ],
          salaryRanges: [
            { label: '$100k+', minSalary: 100000, maxSalary: 0 },
            { label: '$50-100k', minSalary: 50000, maxSalary: 100000 },
            { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
          ],
          roles: [
            { name: 'Brand Marketing', jobIndices: [0, 2] },
            { name: 'Growth', jobIndices: [1] },
          ],
        },
        profile: { skills: ['x'] },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-h',
      });
      const byKind = (k) => result.newNodes.filter(n => n.data?.kind === k);
      const cards = result.newNodes.filter(n => n.type === 'jobcard');
      const bands = byKind('likelihood');
      const salary = byKind('salary');
      const roles = byKind('role');
      assert(cards.length === 3, `hierarchy: expected 3 cards, got ${cards.length}`);
      // Two bands present (Strong has 2 jobs, Long shot has 1).
      assert(bands.length === 2, `hierarchy: expected 2 likelihood bands, got ${bands.length}`);
      const strong = bands.find(b => b.data.label.startsWith('Strong'));
      const longshot = bands.find(b => b.data.label.startsWith('Long shot'));
      assert(strong.data.count === 2 && longshot.data.count === 1, `hierarchy: band counts wrong (${strong.data.count}/${longshot.data.count})`);
      // Bands are roots (children of hub, not of any group) and ordered best-first.
      assert(strong.position.y < longshot.position.y, 'hierarchy: Strong band should sit above Long shot');
      // Strong band → two salary ranges ($100k+ for idx0, $50-100k for idx1).
      const strongRanges = salary.filter(s => (strong.data.childIds || []).includes(s.id));
      assert(strongRanges.length === 2, `hierarchy: Strong band should have 2 salary ranges, got ${strongRanges.length}`);
      // Highest salary range ordered first WITHIN the band — checked via
      // childIds order, since nothing auto-expands at analysis end so the salary
      // nodes (hidden under the collapsed band) have no laid-out position.
      const hi = strongRanges.find(s => s.data.label === '$100k+');
      const lo = strongRanges.find(s => s.data.label === '$50-100k');
      assert(strong.data.childIds[0] === hi.id && strong.data.childIds[1] === lo.id, 'hierarchy: higher salary range should be ordered first within the band');
      // idx2 (no salary, weak) lands in the Long shot band's Unspecified range.
      const lsRange = salary.find(s => (longshot.data.childIds || []).includes(s.id));
      assert(lsRange.data.label === 'Unspecified', 'hierarchy: no-salary job should land in Unspecified');
      // Role leaves hold the cards.
      assert(roles.every(r => (r.data.childIds || []).every(cid => cards.some(c => c.id === cid))), 'hierarchy: role children should be cards');
      assert(result.scoreRangeMin === 30 && result.scoreRangeMax === 92, 'hierarchy: score range from displayed jobs');
      return { cards: cards.length, bands: bands.length, salary: salary.length, roles: roles.length };
    },
  },
  {
    name: 'Job tree: fully collapsed at analysis end (no auto-expand)',
    run: () => {
      const mk = (title, score, url) => ({
        title, company: 'Acme', location: 'Remote', salary: '$120k', snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today',
      });
      const displayedJobs = [mk('Weak', 40, 'https://jobs/lo'), mk('Strong', 95, 'https://jobs/hi')];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [
            { label: 'Strong (70–100%)', minScore: 70, maxScore: 100 },
            { label: 'Possible (0–69%)', minScore: 0, maxScore: 69 },
          ],
          salaryRanges: [{ label: '$100k+', minSalary: 100000, maxSalary: 0 }, { label: 'Unspecified', minSalary: 0, maxSalary: 0 }],
          roles: [{ name: 'Role A', jobIndices: [0, 1] }],
        },
        profile: { skills: ['x'] },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-c',
      });
      const bands = result.newNodes.filter(n => n.data?.kind === 'likelihood');
      const nonBandGroups = result.newNodes.filter(n => n.type === 'jobgroup' && n.data?.kind !== 'likelihood');
      const cards = result.newNodes.filter(n => n.type === 'jobcard');
      const strong = bands.find(b => b.data.label.startsWith('Strong'));
      const possible = bands.find(b => b.data.label.startsWith('Possible'));
      // Nothing is expanded — the whole tree is closed when analysis ends.
      assert(result.newNodes.every(n => !n.data?.expanded), 'collapsed: no node should be expanded');
      // Band roots are visible (collapsed pills); everything below is hidden.
      assert(bands.every(b => b.hidden === false), 'collapsed: band roots should be visible');
      assert(nonBandGroups.every(g => g.hidden === true), 'collapsed: salary/role groups should be hidden');
      assert(cards.every(c => c.hidden === true), 'collapsed: all cards should be hidden');
      // Bands still ordered best-first and stacked (layout pass runs regardless).
      assert(strong.position.y < possible.position.y, 'collapsed: Strong band should still sit above Possible');
      return { ok: true };
    },
  },
  {
    name: 'Job Board: unionScoredJobs dedups by identity, keeps higher score',
    run: () => {
      const a = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 60, resumeProfile: { id: 'A' } },
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 80, resumeProfile: { id: 'A' } },
      ];
      const b = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 90, resumeProfile: { id: 'B' } }, // dup of a[0], higher
        { title: 'Designer', company: 'Gamma', url: '', matchScore: 50, resumeProfile: { id: 'B' } },
        { title: 'designer', company: 'gamma', url: '', matchScore: 70, resumeProfile: { id: 'B' } }, // dup by title|company (no url)
      ];
      const out = unionScoredJobs([a, b]);
      assert(out.length === 3, `union: expected 3 unique, got ${out.length}`);
      const eng = out.find(j => j.url === 'https://j/1');
      assert(eng.matchScore === 90, `union: higher score should win (got ${eng.matchScore})`);
      assert(eng.resumeProfile?.id === 'B', 'union: winning copy carries its own resumeProfile');
      // First-seen order preserved: Eng (a[0]), PM, Designer.
      assert(out[0].url === 'https://j/1' && out[1].url === 'https://j/2', 'union: first-seen order preserved');
      const designer = out.find(j => j.company.toLowerCase() === 'gamma');
      assert(designer.matchScore === 70, 'union: title|company dedup keeps higher score when url missing');
      return { unique: out.length };
    },
  },
  {
    name: 'Job Board: unionScoredJobs reports merge stats via out-param',
    run: () => {
      const a = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 60 },
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 80 },
      ];
      const b = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 90 }, // dup, higher → upgrade
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 50 },  // dup, lower → no upgrade
        { title: 'New', company: 'Gamma', url: 'https://j/3', matchScore: 70 },
      ];
      const stats = {};
      const out = unionScoredJobs([a, b], stats);
      assert(out.length === 3, `stats: expected 3 unique, got ${out.length}`);
      assert(stats.totalIncoming === 5, `stats: totalIncoming should be 5 (got ${stats.totalIncoming})`);
      assert(stats.unique === 3, `stats: unique should be 3 (got ${stats.unique})`);
      assert(stats.duplicatesRemoved === 2, `stats: duplicatesRemoved should be 2 (got ${stats.duplicatesRemoved})`);
      assert(stats.collisions === 2, `stats: collisions should be 2 (got ${stats.collisions})`);
      assert(stats.collisionUpgrades === 1, `stats: only the higher-score collision upgrades (got ${stats.collisionUpgrades})`);
      // Stats path must not alter the returned union vs. the no-stats call.
      assert(unionScoredJobs([a, b]).length === out.length, 'stats: out-param does not change the result');
      return stats;
    },
  },
  {
    name: 'Job Board: unionScoredJobs tolerates empty / non-array inputs',
    run: () => {
      assert(unionScoredJobs([]).length === 0, 'union: empty → empty');
      assert(unionScoredJobs(null).length === 0, 'union: null → empty');
      const out = unionScoredJobs([null, undefined, [{ title: 'x', company: 'y', url: 'u', matchScore: 1 }]]);
      assert(out.length === 1, 'union: skips non-array entries');
      return { ok: true };
    },
  },
  {
    name: 'Job Board: moduleFingerprint changes on count OR score change, stable otherwise',
    run: () => {
      const a = [{ matchScore: 90 }, { matchScore: 80 }];
      assert(moduleFingerprint(a) === moduleFingerprint([{ matchScore: 80 }, { matchScore: 90 }]),
        'fingerprint: order-insensitive (sum-based), same set → same fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90 }]),
        'fingerprint: fewer jobs → different fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90 }, { matchScore: 81 }]),
        'fingerprint: re-scored (same count, different score) → different fp');
      assert(moduleFingerprint(null) === '0.0', 'fingerprint: nullish → "0.0"');
      return { ok: true };
    },
  },
  {
    name: 'Job Board: combineSignature is order-independent over modules',
    run: () => {
      const m1 = { id: 'A', fingerprint: '5.10' };
      const m2 = { id: 'B', fingerprint: '3.7' };
      assert(combineSignature([m1, m2]) === combineSignature([m2, m1]),
        'signature: connection order does not matter');
      assert(combineSignature([m1]) !== combineSignature([m1, m2]),
        'signature: dropping a module changes it');
      assert(combineSignature([m1, m2]) !== combineSignature([m1, { id: 'B', fingerprint: '4.8' }]),
        'signature: a module whose data changed changes it');
      assert(combineSignature([]) === '', 'signature: empty → ""');
      return { ok: true };
    },
  },
  {
    name: 'Job Board: staleReason diffs last-combine signature vs. live modules',
    run: () => {
      const prev = combineSignature([{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }]);
      // B disconnected:
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }]) === '1 disconnected',
        'reason: a removed connection');
      // B re-ran (data changed):
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '4.9' }]) === '1 updated',
        'reason: a connection whose data changed');
      // C newly added:
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }, { id: 'C', fingerprint: '2.2' }]) === '1 added',
        'reason: a new connection');
      // Identical → no drift (caller wouldn't show it, but the function stays honest):
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }]) === 'connections changed',
        'reason: no diff → generic fallback');
      // Combined change:
      assert(staleReason(prev, [{ id: 'B', fingerprint: '9.9' }, { id: 'C', fingerprint: '1.1' }]) === '1 disconnected · 1 added · 1 updated',
        'reason: disconnected + added + updated together');
      return { ok: true };
    },
  },
  {
    name: 'computeJobTreeView: filter removes non-matching cards + empty branches (not dim)',
    run: () => {
      // Two bands: A (Excellent, scores 90/88) and B (Long shot, score 20).
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'A',   type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', label: 'Excellent', childIds: ['A-S'], expanded: false } },
        { id: 'A-S', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', label: '$100k+', childIds: ['A-R'], expanded: false } },
        { id: 'A-R', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: ['a1', 'a2'], expanded: false, visibleCount: 10 } },
        { id: 'a1',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'a2',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 88, source: 'dice' } },
        { id: 'B',   type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', label: 'Long shot', childIds: ['B-S'], expanded: false } },
        { id: 'B-S', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', label: 'Under', childIds: ['B-R'], expanded: false } },
        { id: 'B-R', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: ['b1'], expanded: false, visibleCount: 10 } },
        { id: 'b1',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 20, source: 'indeed' } },
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;

      // No filter on the spawned/collapsed tree → no change (same ref).
      const base = tree();
      assert(computeJobTreeView(base, 'hub', {}) === base, 'no-filter on collapsed tree is a same-ref no-op');

      // Filter ≥85 (collapsed): empty band B removed; matching band A stays visible.
      const f85 = computeJobTreeView(tree(), 'hub', { scoreThreshold: 85 });
      assert(hiddenOf(f85, 'A') === false, 'filter: band with matches stays visible');
      assert(hiddenOf(f85, 'B') === true, 'filter: empty band REMOVED (hidden), not dimmed');

      // Expand A fully under ≥89 → only a1 (90) shows; a2 (88) removed; branch stays.
      const expanded = tree().map(n =>
        ['A', 'A-S', 'A-R'].includes(n.id) ? { ...n, data: { ...n.data, expanded: true } } : n);
      const f89 = computeJobTreeView(expanded, 'hub', { scoreThreshold: 89 });
      assert(hiddenOf(f89, 'a1') === false, 'filter+expand: matching card visible');
      assert(hiddenOf(f89, 'a2') === true, 'filter+expand: non-matching card REMOVED');
      assert(hiddenOf(f89, 'A-R') === false && hiddenOf(f89, 'B') === true, 'filter+expand: branch with a match kept, empty band gone');

      // Filter above every score → whole tree removed.
      const f99 = computeJobTreeView(tree(), 'hub', { scoreThreshold: 99 });
      assert(['A', 'A-S', 'A-R', 'a1', 'a2', 'B', 'b1'].every(id => hiddenOf(f99, id)), 'filter above max removes everything');

      // Source filter: only dice → a2 stays, a1 (lever) + b1 (indeed) removed.
      const expandedSrc = computeJobTreeView(expanded, 'hub', { sourceFilter: 'dice' });
      assert(hiddenOf(expandedSrc, 'a2') === false && hiddenOf(expandedSrc, 'a1') === true, 'source filter keeps only matching source');
      return { ok: true };
    },
  },
  {
    name: 'computeJobTreeView: flat-spawn fallback (no jobgroups) — cards survive filter/restore',
    run: () => {
      // Bucketing failed → flat spawn: jobcards wired straight to the hub, NO groups.
      // Regression: previously computeJobTreeView only seeded `visible` by walking
      // jobgroups, so a flat board had an empty visible set and ALL cards were hidden
      // on any filter/restore (blank board with a non-zero header count).
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'c1', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'c2', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 60, source: 'dice' } },
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;
      const f0 = computeJobTreeView(tree(), 'hub', {});
      assert(hiddenOf(f0, 'c1') === false && hiddenOf(f0, 'c2') === false, 'flat: no-filter keeps all cards visible');
      const fLow = computeJobTreeView(tree(), 'hub', { scoreThreshold: 50 });
      assert(hiddenOf(fLow, 'c1') === false && hiddenOf(fLow, 'c2') === false, 'flat: threshold below all keeps both');
      const fMid = computeJobTreeView(tree(), 'hub', { scoreThreshold: 80 });
      assert(hiddenOf(fMid, 'c1') === false && hiddenOf(fMid, 'c2') === true, 'flat: threshold removes only sub-threshold card');
      const fHigh = computeJobTreeView(tree(), 'hub', { scoreThreshold: 95 });
      assert(hiddenOf(fHigh, 'c1') === true && hiddenOf(fHigh, 'c2') === true, 'flat: threshold above all hides both');
      const fSrc = computeJobTreeView(tree(), 'hub', { sourceFilter: 'dice' });
      assert(hiddenOf(fSrc, 'c2') === false && hiddenOf(fSrc, 'c1') === true, 'flat: source filter keeps only matching source');
      return { ok: true };
    },
  },
  {
    name: 'Job tree layout positions',
    run: () => {
      const nodes = [
        { id: 'hub', type: 'jobhub', position: { x: 10, y: 20 }, data: {} },
        { id: 'L', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['S'], expanded: true } },
        { id: 'S', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', childIds: ['R'], expanded: true } },
        { id: 'R', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['job-1', 'job-2'], expanded: true, visibleCount: 1 } },
        { id: 'job-1', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
        { id: 'job-2', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
      ];
      const positions = computeLayoutPositions(nodes, 'hub', COL_X, { x: 10, y: 20 });
      assert(positions.L?.x === 10 + COL_X.likelihood && positions.L?.y === 20, 'layout: likelihood position mismatch');
      assert(positions.S?.x === 10 + COL_X.salary && positions.S?.y === 20, 'layout: salary position mismatch');
      assert(positions.R?.x === 10 + COL_X.role && positions.R?.y === 20, 'layout: role position mismatch');
      assert(positions['job-1']?.x === 10 + COL_X.job && positions['job-1']?.y === 20, 'layout: visible job position mismatch');
      assert(!positions['job-2'], 'layout: hidden overflow job (past visibleCount) should not be positioned');
      return positions;
    },
  },
  {
    name: 'Application: résumé document scaffold',
    run: () => {
      const doc = buildResumeDocument('<main class="page" data-print="ink-only"><h1 class="name">Jane</h1></main>');
      assert(/^<!doctype html>/i.test(doc.trim()), 'resume doc: missing doctype');
      assert(doc.includes('<link rel="stylesheet" href="colors_and_type.css">'), 'resume doc: missing tokens stylesheet');
      assert(doc.includes('<link rel="stylesheet" href="resume.css">'), 'resume doc: missing component stylesheet');
      assert(doc.includes('data-print="ink-only"') && doc.includes('Jane'), 'resume doc: lost the <main> block');
      // A model that mistakenly returns a full fenced document is normalized to
      // exactly one <main> inside our scaffold.
      const fenced = buildResumeDocument('```html\n<html><body><main class="page">X</main></body></html>\n```');
      const mainCount = (fenced.match(/<main/gi) || []).length;
      assert(mainCount === 1 && fenced.includes('>X</main>'), 'resume doc: should extract a single <main> from a fenced full doc');
      return { ok: true };
    },
  },
  {
    name: 'Application: variant attrs mirror résumé',
    run: () => {
      assert(extractVariantAttrs('<main class="page" data-print="ink-only" data-mono>') === 'data-print="ink-only" data-mono', 'variant: ink-only + mono');
      // dual-pdf is the design system default — present even when the model
      // omits data-print (and when it only sets paper size).
      assert(extractVariantAttrs('<main class="page" data-page="a4">') === 'data-print="dual-pdf" data-page="a4"', 'variant: a4 defaults to dual-pdf');
      assert(extractVariantAttrs('<main class="page" data-print="dual-pdf">') === 'data-print="dual-pdf"', 'variant: dual-pdf preserved');
      assert(extractVariantAttrs('<main class="page">') === 'data-print="dual-pdf"', 'variant: plain → dual-pdf default');
      // isDualMode gates the OCG cream post-process.
      assert(isDualMode('data-print="dual-pdf"') === true, 'isDualMode: dual-pdf → true');
      assert(isDualMode('data-print="ink-only" data-mono') === false, 'isDualMode: ink-only → false');
      return { ok: true };
    },
  },
  {
    name: 'Application: cover letter builder (design-system native surface)',
    run: () => {
      const html = buildCoverLetterDocument({
        name: 'Jane Doe',
        tagline: 'Product Marketer',
        contact: ['Austin, TX', 'jane@x.com'],
        date: 'May 31, 2026',
        recipient: 'Hiring Team\nAcme\nProduct Marketing',
        salutation: 'Dear Acme Team,',
        paragraphs: ['I love <Acme> & your work.', 'Second para.', '   '],
        closing: 'Sincerely,',
        signatureTitle: 'Senior Product Marketer · candidate',
      }, 'data-print="ink-only"');
      // Uses the design system's NATIVE cover-letter surface — all three
      // stylesheets, not a guessed inline <style>.
      assert(!html.includes('<style'), 'cover: must not inline guessed styles');
      assert(html.includes('href="colors_and_type.css"') && html.includes('href="resume.css"') && html.includes('href="cover-letter.css"'),
        'cover: must link colors_and_type.css + resume.css + cover-letter.css');
      // Native structure classes (cover-letter.html / cover-letter.css).
      for (const cls of ['resume-header letter-letterhead', 'letterhead-rule', 'letter-meta', 'letter-date', 'letter-recipient', 'letter-body', 'salutation', 'letter-close', 'valediction', 'signature']) {
        assert(html.includes(cls), `cover: missing native class "${cls}"`);
      }
      assert(html.includes('Jane Doe') && html.includes('Product Marketer'), 'cover: letterhead missing');
      assert(html.includes('data-print="ink-only"'), 'cover: variant not mirrored onto <html>');
      // Recipient block split: first line is the bolded .recipient-name, the rest .recipient-line.
      assert(html.includes('<span class="recipient-name">Hiring Team</span>'), 'cover: recipient-name (first line) missing');
      assert((html.match(/<span class="recipient-line">/g) || []).length === 2, 'cover: expected 2 recipient-line rows');
      // signatureTitle renders under the signature.
      assert(html.includes('<p class="signature-title">Senior Product Marketer · candidate</p>'), 'cover: signature-title missing');
      // User text is HTML-escaped (no markup injection from model output).
      assert(html.includes('I love &lt;Acme&gt; &amp; your work.'), 'cover: body not HTML-escaped');
      // Blank/whitespace paragraphs dropped; body uses bare <p> (every other
      // paragraph is classed, so this count isolates the body).
      const bodyParas = (html.match(/<p>/g) || []).length;
      assert(bodyParas === 2, `cover: expected 2 body paragraphs, got ${bodyParas}`);
      assert(html.includes('jane@x.com') && html.includes('class="sep"'), 'cover: contact line missing separators');
      // Sensible fallbacks when optional fields are omitted: salutation/closing
      // default; no recipient → no <address>; no signatureTitle → no signature-title.
      const bare = buildCoverLetterDocument({ name: 'X' });
      assert(bare.includes('Dear Hiring Team,') && bare.includes('Sincerely,'), 'cover: missing salutation/closing fallback');
      assert(!bare.includes('letter-recipient') && !bare.includes('signature-title'), 'cover: optional blocks must be omitted when empty');
      assert(bare.includes('<p class="signature"'), 'cover: signature (name) always present');
      return { ok: true };
    },
  },
  {
    name: 'Gemini JSON parsing',
    run: () => {
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      // Plain object, markdown-fenced, and trailing-comma cleanup.
      assert(eq(parseGeminiJSON('{"a":1}'), { a: 1 }), 'parseGeminiJSON: plain object');
      assert(eq(parseGeminiJSON('```json\n{"a":1}\n```'), { a: 1 }), 'parseGeminiJSON: fenced object');
      assert(eq(parseGeminiJSON('{"a":1,}'), { a: 1 }), 'parseGeminiJSON: trailing comma');
      // Top-level arrays must NOT be mangled (guards the fallback against
      // starting the span at the first inner brace).
      assert(eq(parseGeminiJSON('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]), 'parseGeminiJSON: top-level array');
      // Regression: prose containing a stray bracket before the JSON object used
      // to make the first-open/last-close span start at the stray '[' and throw.
      assert(eq(parseGeminiJSON('Use [ ] for arrays: {"status":"ok"}'), { status: 'ok' }), 'parseGeminiJSON: stray bracket in prose');
      return { ok: true };
    },
  },
  {
    name: 'SITE_CHANGED diagnostic on empty page',
    run: () => {
      // The throw site fires only when extraction returns 0; it must append the
      // decisive facts (candidate count, path, login-wall flag) so a bug report
      // can tell a login wall / empty anon page from a genuine selector change —
      // without the user pasting page HTML.
      const evalThrow = (extractor, html, url) => {
        const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
        try { dom.window.eval(extractor); return null; }
        catch (e) { return e.message; }
      };

      // (a) Login wall: no listing cards + a /login URL + password field →
      //     cards=0 and the LOGIN-WALL flag (→ "log in", not a code bug).
      const loginMsg = evalThrow(
        POSHMARK_SOLD_EXTRACTOR,
        '<html><head><title>Login | Poshmark</title></head><body><input type="password"></body></html>',
        'https://poshmark.com/login',
      );
      assert(loginMsg && /SITE_CHANGED/.test(loginMsg), `poshmark empty page should throw SITE_CHANGED → ${loginMsg}`);
      assert(/\[diag /.test(loginMsg), `diag block missing → ${loginMsg}`);
      assert(/cards=0/.test(loginMsg), `expected cards=0 → ${loginMsg}`);
      assert(/LOGIN-WALL/.test(loginMsg), `expected LOGIN-WALL flag → ${loginMsg}`);

      // (b) Real results page whose tile selectors changed: candidate cards
      //     present but our sub-selectors match 0 → cards>0, titleSel=0, NO
      //     login flag (→ a genuine redesign; says exactly what to fix).
      const redesignMsg = evalThrow(
        POSHMARK_SOLD_EXTRACTOR,
        '<html><head><title>Search</title></head><body>' +
          '<div data-et-name="listing"></div><div data-et-name="listing"></div></body></html>',
        'https://poshmark.com/search?query=x',
      );
      assert(/cards=2/.test(redesignMsg), `expected cards=2 → ${redesignMsg}`);
      assert(/titleSel=0/.test(redesignMsg), `expected titleSel=0 → ${redesignMsg}`);
      assert(!/LOGIN-WALL/.test(redesignMsg), `should NOT flag login on a real search page → ${redesignMsg}`);

      // (c) Card class skeleton: a renamed card whose OLD sub-selectors all miss
      //     still surfaces the NEW class names via card0=[…] — so a selector
      //     rewrite is derivable from the bug report without pasting page HTML.
      const renamedMsg = evalThrow(
        POSHMARK_SOLD_EXTRACTOR,
        '<html><head><title>Search</title></head><body>' +
          '<div data-et-name="listing" class="tile__v2"><a href="/listing/x"><div class="tile__v2-title">iPhone</div>' +
          '<span class="tile__v2-price">$500</span></a></div></body></html>',
        'https://poshmark.com/search?query=x',
      );
      assert(/card0=\[/.test(renamedMsg), `expected card0 skeleton → ${renamedMsg}`);
      assert(/tile__v2-title/.test(renamedMsg) && /tile__v2-price/.test(renamedMsg),
        `skeleton should expose the new class names → ${renamedMsg}`);

      // The other throwing extractors also carry the diag block.
      for (const [label, ex] of [['ebay-sold', EBAY_SOLD_EXTRACTOR], ['ebay-active', EBAY_ACTIVE_EXTRACTOR], ['mercari', MERCARI_SOLD_EXTRACTOR]]) {
        const m = evalThrow(ex, '<html><body></body></html>', 'https://example.com');
        assert(m && /\[diag .*cards=0/.test(m), `${label} diag missing cards=0 → ${m}`);
      }
      return { ok: true };
    },
  },
  {
    name: 'extraction yield (noFields) surfaces partial per-card drift',
    run: () => {
      // The gap this guards: a sub-selector (e.g. price) drifts for SOME cards,
      // so items.length stays > 0 (no SITE_CHANGED throw) but a chunk of the
      // page is silently dropped. yieldStats.{seen,noFields} makes that visible.
      const listing = (slug, opts = {}) => {
        const { title = true, price = true, link = true } = opts;
        const inner =
          (title ? `<div class="tile-grid-redesign__title">iPhone XS</div>` : '') +
          (price ? `<span class="tile-grid-redesign__price-current">$200</span>` : '');
        return link
          ? `<div data-et-name="listing"><a href="/listing/${slug}">${inner}</a></div>`
          : `<div data-et-name="listing">${inner}</div>`;
      };
      // 2 complete cards + one missing EACH of price / title / link → kept=2,
      // noFields=3, with the per-field attribution pinning WHICH selector dropped
      // each (noPrice/noTitle/noLink). That breakdown is what lets a bug report tell
      // a single drifted sub-selector apart from whole-card skeleton (all 3 spread).
      const html = '<html><head><title>Search</title></head><body>' +
        listing('a') + listing('b') +
        listing('c', { price: false }) +
        listing('d', { title: false }) +
        listing('e', { link: false }) + '</body></html>';
      const dom = new JSDOM(html, { url: 'https://poshmark.com/search?query=x&availability=sold_out', runScripts: 'outside-only' });
      const out = dom.window.eval(POSHMARK_SOLD_EXTRACTOR);
      assert(out && Array.isArray(out.items), 'poshmark extractor should return { items }');
      assert(out.items.length === 2, `expected 2 kept items, got ${out.items.length}`);
      assert(out.yieldStats && out.yieldStats.seen === 5, `expected seen=5 (cards on page), got ${out.yieldStats?.seen}`);
      assert(out.yieldStats.noFields === 3, `expected noFields=3, got ${out.yieldStats?.noFields}`);
      assert(out.yieldStats.noPrice === 1, `expected noPrice=1 (the price-less card), got ${out.yieldStats?.noPrice}`);
      assert(out.yieldStats.noTitle === 1, `expected noTitle=1 (the title-less card), got ${out.yieldStats?.noTitle}`);
      assert(out.yieldStats.noLink === 1, `expected noLink=1 (the link-less card), got ${out.yieldStats?.noLink}`);

      // A fully healthy page reports noFields=0 AND every per-field counter 0 (so the
      // report stays quiet) — only real drift produces a non-zero counter.
      const cleanDom = new JSDOM(
        '<html><head><title>Search</title></head><body>' + listing('x') + listing('y') + '</body></html>',
        { url: 'https://poshmark.com/search?query=x&availability=sold_out', runScripts: 'outside-only' });
      const clean = cleanDom.window.eval(POSHMARK_SOLD_EXTRACTOR);
      assert(clean.items.length === 2 && clean.yieldStats.seen === 2 && clean.yieldStats.noFields === 0,
        `clean page should read seen=2 noFields=0, got seen=${clean.yieldStats?.seen} noFields=${clean.yieldStats?.noFields}`);
      assert(clean.yieldStats.noPrice === 0 && clean.yieldStats.noTitle === 0 && clean.yieldStats.noLink === 0,
        `clean page should read all per-field counters 0, got ${JSON.stringify(clean.yieldStats)}`);
      return { ok: true, drift: out.yieldStats, clean: clean.yieldStats };
    },
  },
  {
    name: 'price parse: strikethrough/range second number is not fused onto the price',
    run: () => {
      // Regression for the Mercari "$3.0415" bug: an on-sale card renders the
      // current price AND the strikethrough original in the SAME node, and the old
      // greedy strip (replace(/[^0-9.]/g,'')) concatenated them — "$3.04"+"$15" →
      // 3.0415, and a whole-dollar "$110"+"$199" → a catastrophic 110199. __money
      // must capture only the FIRST money token (the current/sold price).
      const mcard = (id, priceInner) =>
        `<a href="/us/item/${id}/?ref=search_results"><img alt="Apple iPhone XS 64GB Silver"/>` +
        `<p data-testid="ProductThumbItemPrice">${priceInner}</p></a>`;
      const mhtml = '<html><head><title>iPhone XS sold</title></head><body>' +
        mcard('m1', '$3.04 <span>$15</span>') +     // 2-decimal current + higher original
        mcard('m2', '$110 <span>$199</span>') +     // WHOLE-dollar current → old code → 110199
        '</body></html>';
      const mdom = new JSDOM(mhtml, { url: 'https://www.mercari.com/search/?keyword=iphone%20xs&status=sold_out', runScripts: 'outside-only' });
      const mout = mdom.window.eval(MERCARI_SOLD_EXTRACTOR);
      const mprices = mout.items.map(i => i.price);
      assert(mprices.includes(3.04), `Mercari current price should be 3.04 (not 3.0415), got ${mprices.join(',')}`);
      assert(mprices.includes(110), `Mercari whole-dollar current should be 110 (not 110199), got ${mprices.join(',')}`);
      assert(mprices.every(p => p < 1000), `no fused price should survive, got ${mprices.join(',')}`);

      // eBay price ranges ("$10.00 to $20.00") are the same hazard — take the low end.
      const ehtml = '<html><head><title>eBay</title></head><body><ul class="srp-results">' +
        '<li class="s-card"><span class="su-styled-text primary">Apple iPhone XS</span>' +
        '<div class="s-card__price">$10.00 to $20.00</div>' +
        '<a class="s-card__link" href="https://www.ebay.com/itm/123"></a></li>' +
        '</ul></body></html>';
      const edom = new JSDOM(ehtml, { url: 'https://www.ebay.com/sch/i.html?_nkw=x&_sop=15', runScripts: 'outside-only' });
      const eout = edom.window.eval(EBAY_ACTIVE_EXTRACTOR);
      assert(eout.items[0].price === 10, `eBay range should parse the low end 10 (not 10.002), got ${eout.items[0]?.price}`);
      return { ok: true, mercari: mprices, ebayRange: eout.items[0].price };
    },
  },
  {
    name: 'drift telemetry: Mercari counts missing-title cards in noFields',
    run: () => {
      // Mercari: title comes solely from img[alt]. A card whose image/alt drifts
      // must count toward noFields (not silently vanish), matching the renderer's
      // advertised "price/title/link" drift semantics.
      const mcard = (id, withImg, priceTxt) =>
        `<a href="/us/item/${id}/"><div>` +
        (withImg ? `<img alt="Apple iPhone XS 64GB Silver"/>` : '') +
        `<p>${priceTxt}</p></div></a>`;
      const mhtml = '<html><head><title>iPhone XS sold</title></head><body>' +
        mcard('a', true, '$100') + mcard('b', true, '$120') +
        mcard('c', false, '$130') +   // valid price but NO img[alt] → title drift → counted
        '</body></html>';
      const mdom = new JSDOM(mhtml, { url: 'https://www.mercari.com/search/?keyword=x&status=sold_out', runScripts: 'outside-only' });
      const mout = mdom.window.eval(MERCARI_SOLD_EXTRACTOR);
      assert(mout.items.length === 2, `Mercari: expected 2 kept (title-less dropped), got ${mout.items.length}`);
      assert(mout.yieldStats.seen === 3, `Mercari: expected seen=3, got ${mout.yieldStats?.seen}`);
      assert(mout.yieldStats.noFields === 1, `Mercari: title-less card must count toward noFields=1, got ${mout.yieldStats?.noFields}`);
      return { ok: true, mercari: mout.yieldStats };
    },
  },
  {
    name: 'priceChartingQuery strips listing cruft but keeps price-distinct edition tokens',
    run: () => {
      // The reported case: a seller title finds 0 exact + 100 fuzzy. Strip
      // capacity/condition/"Console"/separator → canonical product name. KEEP
      // "Digital Edition" (a distinct SKU ~$80–100 below the Disc edition).
      const ps5 = priceChartingQuery('Sony PlayStation 5 Digital Edition 1TB Console - Certified Refurbished');
      assert(ps5 === 'Sony PlayStation 5 Digital Edition', `PS5 query → "${ps5}"`);
      // Capacity stripped, variant token (OLED) kept.
      assert(priceChartingQuery('Nintendo Switch OLED 64GB') === 'Nintendo Switch OLED', `switch → "${priceChartingQuery('Nintendo Switch OLED 64GB')}"`);
      // Intra-word hyphen preserved (only space-padded listing dashes removed).
      assert(priceChartingQuery("Marvel's Spider-Man") === "Marvel's Spider-Man", `hyphen → "${priceChartingQuery("Marvel's Spider-Man")}"`);
      // All-cruft never reduces to empty — falls back to the original trimmed.
      assert(priceChartingQuery('  Used Console  ') === 'Used Console', `all-cruft fallback → "${priceChartingQuery('  Used Console  ')}"`);
      // A plain game title is untouched.
      assert(priceChartingQuery('Gears of War 4') === 'Gears of War 4', 'plain game title unchanged');
      return { ok: true, ps5 };
    },
  },
  {
    name: 'parsePriceChartingHtml extracts server-rendered prices (the bot-gated-JS workaround)',
    run: () => {
      // PriceCharting moved off the stealth browser to a direct HTTP fetch because
      // its client-side JS blanks the prices under automation. The prices are
      // server-rendered into <span class="js-price"> — verified by curl — so this
      // parses the raw HTML directly. Mirrors the real row markup.
      const row = (id, slug, name, used, cib, neu) =>
        `<tr id="product-${id}" data-product="${id}">` +
        `<td class="image"><a href="https://www.pricecharting.com/game/${slug}"></a></td>` +
        `<td class="title"><a href="https://www.pricecharting.com/game/${slug}" title="${id}">${name}</a>` +
        `<div class="console-in-title"><a href="/console/playstation-5">Playstation 5</a></div></td>` +
        `<td class="console">Playstation 5</td>` +
        `<td class="price numeric used_price"><span class="js-price">${used}</span></td>` +
        `<td class="price numeric cib_price"><span class="js-price">${cib}</span></td>` +
        `<td class="price numeric new_price"><span class="js-price">${neu}</span></td></tr>`;
      const html = '<html><head><title>PS5 Digital Price</title></head><body><table id="games_table"><tbody>' +
        '<tr><th>&nbsp;</th><th>Title</th><th>Loose</th><th>CIB</th><th>New</th></tr>' +   // header → no td.title a, skipped
        row('6179528', 'playstation-5/playstation-5-slim-digital-edition', 'Playstation 5 Slim Digital Edition', '$366.55', '$401.93', '$524.25') +
        row('37393', 'playstation-4/playstation-4-pro-1tb-console', 'Playstation 4 Pro 1TB Console', '$144.98', '$167.20', '$413.56') +
        row('9999', 'playstation-5/ps5-cover-plate', 'Digital Edition Console Cover', '', '', '') +   // unpriced accessory → skipped
        row('6179528', 'playstation-5/playstation-5-slim-digital-edition', 'Dup row', '$366.55', '', '') +  // dup URL → deduped
        '</tbody></table></body></html>';
      const comps = parsePriceChartingHtml(html);
      assert(comps.length === 2, `expected 2 comps (header/unpriced/dup excluded), got ${comps.length}`);
      // Takes the FIRST (loose/used) price column, not CIB/new.
      assert(comps[0].price === 366.55 && comps[0].priceText === '$366.55', `loose price first → ${JSON.stringify(comps[0])}`);
      assert(comps[0].title === 'Playstation 5 Slim Digital Edition' && comps[0].source === 'pricecharting', `title/source → ${JSON.stringify(comps[0])}`);
      assert(comps[0].url === 'https://www.pricecharting.com/game/playstation-5/playstation-5-slim-digital-edition', `absolute url → ${comps[0].url}`);
      assert(comps[1].price === 144.98, `second comp loose price → ${comps[1].price}`);
      // Empty / off-category HTML → no comps, no throw.
      assert(parsePriceChartingHtml('<html><body><table id="games_table"><tbody></tbody></table></body></html>').length === 0, 'empty table → 0 comps');
      assert(parsePriceChartingHtml('').length === 0, 'empty string → 0 comps');
      return { ok: true, prices: comps.map(c => c.price) };
    },
  },
  {
    name: 'filterPriceChartingByRelevance drops fuzzy whole-catalog junk, keeps genuine matches',
    run: () => {
      // The reported bug: PriceCharting fuzzy-matches a vacuum-formula query to
      // dozens of unrelated games/comics/cards on single shared tokens. Each junk
      // row shares ONE query token; a real match shares most. The filter keeps
      // only rows clearing a token-overlap bar.
      const vacuumQuery = 'BISSELL Multi-Surface Pet Formula Febreze Freshness Crosswave 80 oz';
      const junk = [
        { title: 'Formula One 99', price: 12, source: 'pricecharting' },          // shares "formula"
        { title: 'Azur Lane: Crosswave', price: 24, source: 'pricecharting' },     // shares "crosswave"
        { title: 'Wizard of Oz', price: 8, source: 'pricecharting' },              // shares "oz" → stopword, 0 hits
        { title: 'Obnoxious Pet', price: 5, source: 'pricecharting' },             // shares "pet"
        { title: 'Multi-Form Token', price: 3, source: 'pricecharting' },          // shares "multi"
      ];
      const keptJunk = filterPriceChartingByRelevance(junk, vacuumQuery);
      assert(keptJunk.length === 0, `vacuum query must drop all fuzzy junk, kept ${keptJunk.length}: ${keptJunk.map(c => c.title).join(', ')}`);

      // A genuine multi-token game match shares most of the query's tokens → kept;
      // a different product sharing only one token → dropped.
      const gameQuery = 'Sony PlayStation 5 Digital Edition';
      const gameRows = [
        { title: 'Playstation 5 Slim Digital Edition', price: 366, source: 'pricecharting' },  // 3 of 4 tokens → keep
        { title: 'Playstation 4 Pro 1TB Console', price: 144, source: 'pricecharting' },        // 1 token → drop
      ];
      const keptGame = filterPriceChartingByRelevance(gameRows, gameQuery);
      assert(keptGame.length === 1 && keptGame[0].title === 'Playstation 5 Slim Digital Edition',
        `genuine match kept, wrong-product dropped → ${JSON.stringify(keptGame.map(c => c.title))}`);

      // 1-token query keeps any title containing that token (broad-by-design).
      assert(filterPriceChartingByRelevance([{ title: 'Tetris' }, { title: 'Halo' }], 'Tetris').length === 1, 'single-token query → exact-token match only');
      // Empty/blank query → don't over-filter (nothing to score on).
      assert(filterPriceChartingByRelevance([{ title: 'Anything' }], '   ').length === 1, 'blank query → unfiltered');
      assert(filterPriceChartingByRelevance([], gameQuery).length === 0, 'empty list → empty');
      return { ok: true, keptGame: keptGame.map(c => c.title) };
    },
  },
  {
    name: 'isPriceChartingApplicable gates by product category',
    run: () => {
      // In-catalog categories → run PriceCharting.
      assert(isPriceChartingApplicable('Video Games > Nintendo Switch > Games') === true, 'video games → applicable');
      assert(isPriceChartingApplicable('Toys & Hobbies > Trading Card Games > Pokémon') === true, 'TCG/Pokémon → applicable');
      assert(isPriceChartingApplicable('Collectibles > Comics') === true, 'comics → applicable');
      assert(isPriceChartingApplicable('Electronics > Video Game Consoles') === true, 'consoles → applicable');
      // Off-catalog household goods → skip (the reported vacuum case).
      assert(isPriceChartingApplicable('Home & Garden > Vacuums > Wet/Dry') === false, 'vacuum → not applicable');
      assert(isPriceChartingApplicable('Appliances > Floor Care') === false, 'appliance → not applicable');
      assert(isPriceChartingApplicable('Electronics > Headphones > Over-Ear') === false, 'headphones → not applicable');
      // Unknown/blank → don't suppress (back-compat; relevance filter still guards).
      assert(isPriceChartingApplicable('') === true, 'blank category → applicable (don\'t suppress)');
      assert(isPriceChartingApplicable(undefined) === true, 'undefined category → applicable');
      return { ok: true };
    },
  },
  {
    name: 'Swappa SOLD extractor parses /xui sales fragment',
    run: () => {
      // Swappa's /listings page (active source) is asking prices; the REAL sold
      // data is the /xui/product/<slug>/sales HTMX fragment — one <tr> per
      // completed sale: date · condition · carrier · storage ·
      // <a href="/listing/view/<id>">$price</a>. Step 1 of the extractor parses
      // such a fragment directly (no fetch), which is what we assert here.
      const row = (date, cond, carrier, storage, id, price) =>
        `<tr><td>${date}</td><td>${cond}</td><td>${carrier}</td><td>${storage}</td>` +
        `<td><a href="/listing/view/${id}" title="View Sold Listing">$${price}</a></td></tr>`;
      const html = '<html><head><title>Apple iPhone X Sales</title></head><body><table class="table fs-sm"><tbody>' +
        row('May 29', 'Good', 'Unlocked', '64 GB', 'LAFB09505', 99) +
        row('May 28', 'Good', 'Unlocked', '256 GB', 'LAFM79221', 114) +
        row('May 26', 'Fair', 'Unlocked Non-US', '256 GB', 'LAES54888', 47) +
        row('May 29', 'Good', 'Unlocked', '64 GB', 'LAFB09505', 99) +   // duplicate listing → must dedup by URL
        '</tbody></table></body></html>';
      const dom = new JSDOM(html, { url: 'https://swappa.com/xui/product/apple-iphone-x/sales', runScripts: 'outside-only' });
      const out = dom.window.eval(SWAPPA_SOLD_EXTRACTOR);
      assert(Array.isArray(out) && out.length === 3, `expected 3 sold comps after deduping the repeated listing, got ${out && out.length}`);
      const first = out[0];
      assert(first.source === 'swappa-sold', `wrong source ${first.source}`);
      assert(first.price === 99 && first.priceText === '$99', `wrong price ${first.priceText}`);
      assert(first.url === 'https://swappa.com/listing/view/LAFB09505', `wrong url ${first.url}`);
      assert(first.condition === 'Good' && first.soldDate === 'May 29', `wrong condition/date ${first.condition}/${first.soldDate}`);
      // Title is built from the slug (model name) + the row's spec columns, since
      // the sales fragment carries no model name of its own.
      assert(/iphone x/i.test(first.title) && /64 gb/i.test(first.title) && /unlocked/i.test(first.title),
        `title should carry model + storage + carrier → ${first.title}`);
      // Distinct prices preserved (incl. the low Non-US outlier) — no collapsing.
      assert(out.map(c => c.price).join(',') === '99,114,47', `prices mismatch → ${out.map(c => c.price).join(',')}`);
      return { ok: true, count: out.length, sample: first };
    },
  },
  {
    name: 'Reverb SOLD price-guide mapping (real sales, not live retail)',
    run: () => {
      // Reverb's /listings/all only returns LIVE listings (state=sold/ended are
      // silently ignored → brand-new retail prices). Real sold data is the Price
      // Guide: selectReverbPriceGuides picks the matching guide; then
      // reverbTransactionsToComps maps its completed transactions (price_final).
      const guides = [
        { id: 81477, title: 'Yamaha A3R-VN Dreadnought with Electronics 2010s Vintage Natural', make: 'Yamaha', model: 'A3R-VN Dreadnought with Electronics', finish: 'Vintage Natural', _links: { web: { href: 'https://reverb.com/price-guide/guide/81477-yamaha-a3r-vn' } } },
        { id: 100299, title: 'Yamaha LS6M ARE 2020s Natural', make: 'Yamaha', model: 'LS6M ARE', finish: 'Natural' }, // shares yamaha+are but WRONG model
        { id: 999, title: 'Fender Stratocaster American Pro', make: 'Fender', model: 'Stratocaster', finish: 'Sunburst' },
      ];
      const picked = selectReverbPriceGuides('Yamaha A3R ARE', guides);
      assert(picked.length === 1 && picked[0].id === 81477,
        `should pick only the A3R guide — NOT the LS6M ARE on the generic 'yamaha'/'are' tokens, got ${picked.map(g => g.id).join(',')}`);
      assert(selectReverbPriceGuides('Gibson Les Paul', guides).length === 0, 'unrelated query should match no guide (no pricing the wrong instrument)');

      const txs = [
        { date: '2025-07-31', condition: 'Excellent', order_id: 23592701, price_ask: { amount: '575.00', display: '$575' }, price_final: { amount: '575.00', display: '$575' } },
        { date: '2025-05-13', condition: 'Mint', order_id: 23010111, price_final: { amount: '620.00', display: '$620' } },
        { date: '2025-05-13', condition: 'Mint', order_id: 23010111, price_final: { amount: '620.00', display: '$620' } }, // dup order_id → deduped
        { date: '2024-01-01', condition: 'Good', order_id: 1, price_final: { amount: '0.00', display: '$0' } },           // zero price → dropped
      ];
      const comps = reverbTransactionsToComps(picked[0], txs);
      assert(comps.length === 2, `expected 2 comps (dup + zero-price dropped), got ${comps.length}`);
      assert(comps.every(c => c.source === 'reverb'), 'source should be reverb');
      assert(comps[0].price === 575 && comps[0].condition === 'Excellent' && comps[0].soldDate === '2025-07-31', `wrong first comp ${JSON.stringify(comps[0])}`);
      assert(comps[0].title === 'Yamaha A3R-VN Dreadnought with Electronics 2010s Vintage Natural', `title should be the guide title → ${comps[0].title}`);
      // Each distinct sale gets the guide link + a unique #tx fragment, so the
      // pipeline's url-keyed dedup counts them as distinct (not "1 unique of N").
      assert(comps[0].url === 'https://reverb.com/price-guide/guide/81477-yamaha-a3r-vn#tx-23592701', `url should be guide link + tx fragment → ${comps[0].url}`);
      assert(comps[0].url !== comps[1].url, 'distinct sales must get distinct urls so uniqueCompCount does not collapse them');
      // The real sold figures ($575–620) are ~half the live-retail price (~$1180)
      // the broken /listings path returned — the whole point of this fix.
      assert(Math.max(...comps.map(c => c.price)) <= 620, 'sold comps should reflect used-market price, not new retail');
      // Outer-dedup contract (fetchReverbSoldComps now keys on comp.url): two
      // DISTINCT sales sharing date AND price must get distinct urls (via order_id)
      // so both survive — the old date+price key collapsed them at modal prices.
      const sameDayPrice = reverbTransactionsToComps(picked[0], [
        { date: '2025-06-01', condition: 'Good', order_id: 111, price_final: { amount: '500.00', display: '$500' } },
        { date: '2025-06-01', condition: 'Good', order_id: 222, price_final: { amount: '500.00', display: '$500' } },
      ]);
      assert(sameDayPrice.length === 2, `distinct same-day same-price sales should both map, got ${sameDayPrice.length}`);
      assert(sameDayPrice[0].url !== sameDayPrice[1].url, 'distinct order_ids → distinct urls (so the url-keyed outer dedup keeps both)');
      const oldKey = (c) => `${picked[0].id}:${c.soldDate}:${c.price}`;
      assert(oldKey(sameDayPrice[0]) === oldKey(sameDayPrice[1]), 'regression witness: the OLD date+price key would have collapsed these two distinct sales');
      return { ok: true, picked: picked[0].id, comps: comps.length, prices: comps.map(c => c.price) };
    },
  },
  {
    name: 'login auto-close: wait on captcha/challenge, not on logged-in home',
    run: () => {
      // MUST keep waiting (NOT auto-close) — the user is mid human-verification.
      const challenge = [
        'https://www.ebay.com/splashui/captcha?ap=1&appName=orch&ru=https%3A%2F%2Fsignin.ebay.com%2Fsignin', // the reported eBay bug
        'https://www.depop.com/signup/google/',          // OAuth signup interstitial
        'https://www.linkedin.com/checkpoint/challenge/', // LinkedIn challenge
        'https://accounts.google.com/signin/v2/challenge/ipp',
        'https://example.com/account/verify-email',
        'https://example.com/login/2fa',
      ];
      for (const u of challenge) assert(isAuthChallengeUrl(u), `should WAIT (challenge) on ${u}`);

      // MUST NOT match — these are real logged-in landings; auto-close should fire.
      const loggedIn = [
        'https://www.ebay.com/', 'https://www.ebay.com/mye/myebay/summary',
        'https://poshmark.com/feed', 'https://www.mercari.com/mypage/',
        'https://www.facebook.com/', 'https://swappa.com/', 'https://reverb.com/',
        'https://www.depop.com/', 'https://www.linkedin.com/feed',
        'https://www.ziprecruiter.com/jobseeker/home', 'https://www.glassdoor.com/member/home/index.htm',
      ];
      for (const u of loggedIn) assert(!isAuthChallengeUrl(u), `should NOT block auto-close on logged-in home ${u}`);
      return { ok: true };
    },
  },
  {
    name: 'captcha inline extractor: accepts bare arrays and wrapped { items, yieldStats } results',
    run: () => {
      const bare = [{ title: 'A' }];
      const wrapped = { items: [{ title: 'B' }], yieldStats: { seen: 2, noFields: 1 } };
      assert(unwrapInlineExtractorItems(bare) === bare, 'bare extractor array passes through');
      assert(unwrapInlineExtractorItems(wrapped) === wrapped.items, 'wrapped extractor items are accepted by visible Solve flow');
      assert(unwrapInlineExtractorItems({ items: 'bad' }) === null, 'invalid wrapped extractor result is rejected');
      return { ok: true };
    },
  },
  {
    // The auto-close poller treats a configured PLATFORM_AUTH_COOKIES entry as a
    // definitive logged-in signal that can fire even while the window is still on a
    // login URL (Glassdoor suppresses its post-auth redirect → window loops on the
    // re-rendered login form). The cookie MUST be login-only, or it would false-close
    // the window mid-login. `at` is set only after a successful Glassdoor login;
    // gdId/gdsid/cass/GSESSIONID appear in anonymous sessions too and must NOT be added.
    name: 'auth-cookie contract: glassdoor uses login-only `at`, not both-state cookies',
    run: () => {
      const gd = PLATFORM_AUTH_COOKIES.glassdoor || [];
      assert(gd.includes('at'), 'glassdoor auth cookie should be `at` (access token, login-only)');
      const bothStateCookies = ['gdId', 'gdsid', 'cass', 'GSESSIONID', 'JSESSIONID', 'trs'];
      for (const c of bothStateCookies) {
        assert(!gd.includes(c), `glassdoor auth cookies must NOT include both-state cookie "${c}" (would false-close mid-login)`);
      }
      return { ok: true, glassdoor: gd };
    },
  },
  {
    name: 'auth-cookie contract: Reverb detects completed login without post-login navigation',
    run: () => {
      const reverb = PLATFORM_AUTH_COOKIES.reverb || [];
      assert(reverb.includes('user_credentials'), 'Reverb should auto-detect its signed credentials cookie');
      assert(!reverb.includes('has_logged_in'), 'Reverb historical login marker must not count as an active session');
      const config = getSellMonitorConfig('reverb');
      assert(config?.verifyUrl === 'https://reverb.com/my/selling/listings', 'Reverb should participate in verified selling-session checks');
      return { ok: true, reverb, verifyUrl: config.verifyUrl };
    },
  },
  {
    // The query LLM now returns a STRUCTURED location object so a board's location
    // FILTER never receives prose. deriveLocationParam flattens it deterministically
    // into the "City, ST" string actually sent to USAJobs/Dice/Indeed/ZR/Glassdoor/LinkedIn.
    name: 'deriveLocationParam: structured canonical → board-ready string (typo-corrected)',
    run: () => {
      // "denvr" → corrected structured object → clean "Denver, CO".
      assert(deriveLocationParam({ city: 'Denver', stateCode: 'CO', region: '', country: 'United States', isRemote: false, display: 'Denver, CO' }) === 'Denver, CO', 'city+state → "City, ST"');
      // city+state is built deterministically, NOT trusted from a possibly-prose display.
      assert(deriveLocationParam({ city: 'Denver', stateCode: 'CO', display: 'around the Denver metro area' }) === 'Denver, CO', 'city+state wins over prose display');
      assert(deriveLocationParam({ city: 'Austin', stateCode: '', region: '', display: 'Austin' }) === 'Austin', 'city-only falls through to city');
      assert(deriveLocationParam({ city: '', stateCode: '', region: 'Bay Area', display: 'Bay Area' }) === 'Bay Area', 'region when no city');
      // Remote → empty param (no geo filter sent → nationwide, which includes remote).
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', isRemote: true, display: 'Remote' }) === '', 'remote → empty param');
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', isRemote: false, display: 'Remote' }) === '', '"Remote" display is never sent as a geo filter');
      // Defensive: a non-object (legacy/empty) falls back to the raw input, never throws.
      assert(deriveLocationParam(null, 'denvr') === 'denvr', 'null struct → raw fallback');
      assert(deriveLocationParam({}, '') === '', 'empty struct + no fallback → ""');
      // Prose-leak guard: a model that ignores the schema and puts a sentence in
      // `display` must NOT have it reach a board's location field — fall back to raw.
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', display: 'somewhere in the midwest, ideally' }, 'midwest') === 'midwest', 'prose display rejected → raw fallback');
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', display: 'anywhere near the coast' }, '') === '', 'prose display + no fallback → "" (never sends prose)');
      // A genuine place-shaped display (no structured fields) is still accepted.
      assert(deriveLocationParam({ city: '', stateCode: '', region: '', display: 'San Francisco, CA' }) === 'San Francisco, CA', 'place-shaped display accepted');
      return { ok: true };
    },
  },
  {
    // Glassdoor's location filter is keyed by a numeric locId (locKeyword text is
    // ignored — confirmed empirically). This is the real findPopularLocationAjax
    // payload for "Denver": pickGlassdoorLocation must choose Denver, CO (1148170),
    // NOT Denver City, TX / Denver, PA / etc.
    name: 'pickGlassdoorLocation: resolves the correct homonym by state (real Glassdoor JSON)',
    run: () => {
      const denverResults = [
        { compoundId: 'C1148170', id: 'C1148170', label: 'Denver, CO (US)', locationId: 1148170, locationType: 'C', longName: 'Denver, CO (US)', realId: 1148170 },
        { compoundId: 'C1139288', id: 'C1139288', label: 'Denver City, TX (US)', locationId: 1139288, locationType: 'C', longName: 'Denver City, TX (US)', realId: 1139288 },
        { compoundId: 'C1152344', id: 'C1152344', label: 'Denver, PA (US)', locationId: 1152344, locationType: 'C', longName: 'Denver, PA (US)', realId: 1152344 },
        { compoundId: 'C1149511', id: 'C1149511', label: 'Denver, IA (US)', locationId: 1149511, locationType: 'C', longName: 'Denver, IA (US)', realId: 1149511 },
      ];
      const co = pickGlassdoorLocation(denverResults, 'Denver, CO');
      assert(co && co.locId === '1148170' && co.locT === 'C', `Denver, CO → 1148170/C, got ${JSON.stringify(co)}`);
      // Different state picks the right homonym, not the first result.
      const pa = pickGlassdoorLocation(denverResults, 'Denver, PA');
      assert(pa && pa.locId === '1152344', `Denver, PA → 1152344, got ${JSON.stringify(pa)}`);
      // No state given → first (most prominent) result.
      const bare = pickGlassdoorLocation(denverResults, 'Denver');
      assert(bare && bare.locId === '1148170', `bare "Denver" → first (1148170), got ${JSON.stringify(bare)}`);
      // Empty / malformed input → null, never throws.
      assert(pickGlassdoorLocation([], 'Denver, CO') === null, 'empty results → null');
      assert(pickGlassdoorLocation(null, 'Denver, CO') === null, 'null results → null');
      return { ok: true };
    },
  },
  {
    name: 'summarizeLocationAdherence: flags off-target survivors (the Miami-for-Denver leak)',
    run: () => {
      const jobs = [
        { title: 'Brand Manager', location: 'Denver, CO', source: 'indeed' },     // in-area (city)
        { title: 'Marketing Lead', location: 'Boulder, CO', source: 'dice' },     // in-area (same state)
        { title: 'Sr. Brand Mgr, BK', location: 'Miami, FL', source: 'linkedin' },// OFF-TARGET
        { title: 'Growth PM', location: 'Remote', source: 'remoteok' },           // remote bucket
        { title: 'Mystery role', location: '', source: 'google' },                // unknown
      ];
      const a = summarizeLocationAdherence(jobs, 'Denver, CO');
      assert(a.total === 5, 'counts all kept jobs');
      assert(a.matched === 2, `2 in-area (city + same-state), got ${a.matched}`);
      assert(a.remote === 1, '1 remote');
      assert(a.offTarget === 1, `1 off-target (Miami), got ${a.offTarget}`);
      assert(a.unknown === 1, '1 unknown (no location)');
      assert(a.offSamples.length === 1 && /Miami/.test(a.offSamples[0]), 'off-target sample names the Miami role');
      // No target location → nothing to audit.
      assert(summarizeLocationAdherence(jobs, '') === null, 'no canonical → null');
      return { ok: true, adherence: a };
    },
  },
  {
    name: 'summarizeLocationAdherence: remote-board listings count as remote (not off-target) even with a city',
    run: () => {
      const jobs = [
        { title: 'Estimator II', location: 'Pune Division', source: 'remoteok' },          // remote board + city → remote
        { title: 'Social Media Mod', location: 'Philippines', source: 'weworkremotely' },   // remote board + region → remote
        { title: 'Data Eng', location: 'Raleigh, NC', source: 'glassdoor' },               // hard-param source → off-target leak
      ];
      const a = summarizeLocationAdherence(jobs, 'Durham, Ontario, Canada');
      assert(a.remote === 2, `remote-board listings bucket as remote, got ${a.remote}`);
      assert(a.offTarget === 1, `only the glassdoor leak is off-target, got ${a.offTarget}`);
      assert(!a.offBySource.remoteok && !a.offBySource.weworkremotely, 'no remote board attributed to off-target');
      return { ok: true, adherence: a };
    },
  },
  {
    name: 'summarizeLocationAdherence: same Canadian province (code-only job) counts as in-area',
    run: () => {
      const jobs = [
        { title: 'Data Engineer', location: 'Whitby, ON', source: 'ziprecruiter' },     // exact city
        { title: 'Sr Data Engineer', location: 'Toronto, ON', source: 'ziprecruiter' }, // same province, code only
        { title: 'DBA', location: 'Ottawa, Ontario', source: 'glassdoor' },             // same province, spelled out
        { title: 'Analyst', location: 'Vancouver, BC', source: 'ziprecruiter' },        // different province → off-target
      ];
      const a = summarizeLocationAdherence(jobs, 'Whitby, Ontario, Canada');
      assert(a.matched === 3, `Whitby + both Ontario jobs are in-area, got ${a.matched}`);
      assert(a.offTarget === 1 && /Vancouver/.test(a.offSamples[0] || ''), `only BC is off-target, got ${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
  {
    name: 'summarizeLocationAdherence: country target "Canada" → any province is in-area, only cross-border is off',
    run: () => {
      const jobs = [
        { title: 'Data Engineer', location: 'Toronto, ON', source: 'ziprecruiter' },      // ON code → in Canada
        { title: 'DBA', location: 'Montreal, QC', source: 'ziprecruiter' },               // QC code → in Canada
        { title: 'Architect', location: 'Halifax, Nova Scotia', source: 'glassdoor' },    // full name → in Canada
        { title: 'Analyst', location: 'Vancouver, BC', source: 'indeed' },                // BC code → in Canada
        { title: 'Sales Mgr', location: 'Houston, TX', source: 'indeed' },                // US → cross-border leak
      ];
      const a = summarizeLocationAdherence(jobs, 'Canada');
      assert(a.country === 'Canada', `country target detected, got ${a.country}`);
      assert(a.matched === 4, `all 4 Canadian jobs in-area, got ${a.matched}`);
      assert(a.offTarget === 1 && /Houston/.test(a.offSamples[0] || ''), `only Houston TX is off, got ${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
  {
    name: 'summarizeLocationAdherence: a single-word CITY is not mistaken for a country',
    run: () => {
      // "Toronto" alone (no province/country) must stay a city match, not flip
      // into country mode — detectCountryTarget only fires on known country names.
      const jobs = [
        { title: 'Eng', location: 'Toronto, ON', source: 'ziprecruiter' },
        { title: 'Eng', location: 'Calgary, AB', source: 'ziprecruiter' }, // diff city, no country target → off
      ];
      const a = summarizeLocationAdherence(jobs, 'Toronto');
      assert(a.country === null, `"Toronto" is not a country, got ${a.country}`);
      assert(a.matched === 1 && a.offTarget === 1, `city match only: 1 in / 1 off, got ${a.matched}/${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
  {
    name: 'summarizeLocationAdherence: province target "Quebec, Canada" matches same-province jobs (not treated as a city)',
    run: () => {
      const jobs = [
        { title: 'Data Eng', location: 'Montreal, QC', source: 'ziprecruiter' },       // QC code → in-province
        { title: 'DBA', location: 'Quebec City, Quebec', source: 'glassdoor' },        // province name → in
        { title: 'Analyst', location: 'Laval, QC', source: 'indeed' },                 // QC code → in
        { title: 'SDE', location: 'Boston, MA', source: 'indeed' },                    // US → off (real leak)
      ];
      const a = summarizeLocationAdherence(jobs, 'Quebec, Canada');
      assert(a.country === null, `province search is not a bare-country target, got ${a.country}`);
      assert(a.matched === 3, `all 3 Quebec jobs in-area, got ${a.matched}`);
      assert(a.offTarget === 1 && /Boston/.test(a.offSamples[0] || ''), `only Boston off, got ${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
  {
    name: 'summarizeLocationAdherence: "Washington, DC" stays a city (Seattle, WA is NOT in-area)',
    run: () => {
      // Regression guard: the first segment "Washington" is a state NAME, but the
      // 2nd segment "DC" is the real subdivision — so it must stay a city search,
      // not flip to "Washington state" and count Seattle as in-area.
      const jobs = [
        { title: 'PM', location: 'Washington, DC', source: 'indeed' },   // in
        { title: 'Eng', location: 'Seattle, WA', source: 'indeed' },     // WA state → off
      ];
      const a = summarizeLocationAdherence(jobs, 'Washington, DC');
      assert(a.matched === 1 && a.offTarget === 1 && /Seattle/.test(a.offSamples[0] || ''),
        `DC city match only: Seattle off, got ${a.matched}/${a.offTarget}`);
      return { ok: true, adherence: a };
    },
  },
  {
    name: 'detectLanguage: Portuguese JD body (English title) → pt; near-tie garbage stays en',
    run: () => {
      // Real shape from a WeWorkRemotely listing: English title, Portuguese body.
      const ptBody = 'Data Quality Analyst I. Headquarters: BR. Conheça a nossa banda! Somos uma empresa inovadora e buscamos um analista de qualidade de dados para a nossa equipe, com experiência em SQL e responsabilidades de governança.';
      assert(detectLanguage(ptBody) === 'pt', `Portuguese body → pt, got ${detectLanguage(ptBody)}`);
      // English JD with a lone accented loanword must NOT be tagged.
      const enBody = 'Estimator II. About Us: Honeywell helps organizations solve the world\'s most complex challenges in automation and energy. You will prepare cost estimates, bids, and proposals. 5 years experience required.';
      assert(detectLanguage(enBody) === 'en', `English body → en, got ${detectLanguage(enBody)}`);
      return { ok: true };
    },
  },
  {
    name: 'repairMojibake: reverses UTF-8-as-Latin-1, leaves clean text + real accents alone',
    run: () => {
      const e2 = String.fromCharCode(0xe2);
      const moji = 'we' + e2 + String.fromCharCode(0x80, 0x99) + 'd love' + e2 + String.fromCharCode(0x80, 0x94) + 'apply';
      assert(hasMojibake(moji), 'C1 controls detected');
      assert(repairMojibake(moji) === 'we’d love—apply', `repaired → ${JSON.stringify(repairMojibake(moji))}`);
      // Real accents (no C1 controls) must pass through untouched.
      const fr = 'à Montréal — développeur d’expérience';
      assert(!hasMojibake(fr) && repairMojibake(fr) === fr, 'clean French unchanged');
      assert(repairMojibake('Senior Data Engineer') === 'Senior Data Engineer', 'plain English unchanged');
      // Field-level repair over a job array.
      const jobs = [{ title: 'Data Entry', snippet: 'we' + e2 + String.fromCharCode(0x80, 0x99) + 'd hire you' }];
      repairJobsMojibake(jobs);
      assert(jobs[0].snippet === 'we’d hire you' && !hasMojibake(jobs[0].snippet), `job repaired → ${jobs[0].snippet}`);
      return { ok: true };
    },
  },
  {
    name: 'scrapeOrder: EMA fold + manual-verification-first ordering',
    run: () => {
      // EMA fold: first sample seeds, then moves toward new samples.
      let s = foldVerificationSample(null, true);
      assert(s.ema === 1 && s.samples === 1, `seed → ema 1, got ${JSON.stringify(s)}`);
      s = foldVerificationSample(s, false);
      assert(Math.abs(s.ema - 0.7) < 1e-9 && s.samples === 2, `1→0 @α.3 → 0.7, got ${s.ema}`);
      // Below MIN_SAMPLES → neutral score 0 (don't reorder off one noisy run).
      assert(verificationScore({ ema: 0.9, samples: 1 }) === 0, 'one sample is not trusted');
      assert(verificationScore({ ema: 0.9, samples: 2 }) === 0.9, 'two samples trusted');

      const def = ['indeed', 'ziprecruiter', 'glassdoor', 'google'];
      // No data → default order unchanged (first run).
      assert(orderByVerification(def, {}).join() === def.join(), 'no data → default order');
      // Google + Glassdoor make the user solve often; Indeed/ZR clean → they lead.
      const stats = {
        google:    { ema: 0.8, samples: 4 },
        glassdoor: { ema: 0.5, samples: 4 },
        indeed:    { ema: 0.0, samples: 4 },
        ziprecruiter: { ema: 0.0, samples: 4 },
      };
      assert(orderByVerification(def, stats).join() === ['google', 'glassdoor', 'indeed', 'ziprecruiter'].join(),
        `manual-prone first, ties keep default: ${orderByVerification(def, stats).join()}`);
      // Indeed mid-ranked lands in the MIDDLE (true unified order, not pinned first/last).
      const stats2 = { google: { ema: 0.9, samples: 3 }, indeed: { ema: 0.6, samples: 3 }, glassdoor: { ema: 0.2, samples: 3 } };
      assert(orderByVerification(def, stats2).join() === ['google', 'indeed', 'glassdoor', 'ziprecruiter'].join(),
        `Indeed sits mid-order by data: ${orderByVerification(def, stats2).join()}`);
      return { ok: true, ordered: orderByVerification(def, stats) };
    },
  },
  {
    name: 'repairMojibake: segmented — fixes mojibake AROUND a genuine high-Unicode char',
    run: () => {
      const e2 = String.fromCharCode(0xe2);
      // Mojibake apostrophe + a genuine emoji (>0xFF) + more mojibake. The old
      // whole-string guard bailed on the emoji and left it all corrupted; the
      // segmented repair fixes the ≤0xFF runs and passes the emoji through.
      const mixed = 'we' + e2 + String.fromCharCode(0x80, 0x99) + 'd hire 🚀 you' + e2 + String.fromCharCode(0x80, 0x99) + 'll love it';
      const out = repairMojibake(mixed);
      assert(out === 'we’d hire 🚀 you’ll love it', `segmented repair → ${JSON.stringify(out)}`);
      assert(!hasMojibake(out), 'no C1 controls remain');
      assert(out.includes('🚀'), 'emoji preserved');
      return { ok: true, out };
    },
  },
  {
    name: 'detectLanguage: English JD stays English (no false-positive chip)',
    run: () => {
      const en = 'Senior Data Engineer. We are looking for an engineer to join our team. You will work on data pipelines and build scalable systems. Requirements: 5 years of experience with SQL and Python.';
      assert(detectLanguage(en) === 'en', `English JD should be en, got ${detectLanguage(en)}`);
      // A single accented loanword in an otherwise-English title must NOT flip it.
      assert(detectLanguage('Café Operations Manager') === 'en', 'one accent (café) is not a language signal');
      assert(detectLanguage('') === 'en' && detectLanguage(null) === 'en', 'empty/null default to en');
      return { ok: true };
    },
  },
  {
    name: 'detectLanguage: French / Spanish / German JDs are detected',
    run: () => {
      const fr = "Développeur Full Stack. Nous recherchons un développeur pour rejoindre notre équipe. Vous travaillerez sur des applications web et serez responsable du développement. Profil: 5 ans d'expérience avec le poste, les compétences et une bonne maîtrise du travail en équipe.";
      const es = 'Ingeniero de Software. Buscamos un ingeniero para unirse a nuestro equipo. Trabajarás con nuestra empresa en el desarrollo de aplicaciones. Requisitos: experiencia con los conocimientos y responsabilidades del puesto.';
      const de = 'Softwareentwickler. Wir suchen einen Mitarbeiter für unser Unternehmen. Sie werden mit dem Team an der Arbeit und den Aufgaben arbeiten. Erfahrung und Kenntnisse für die Stelle sind erforderlich.';
      assert(detectLanguage(fr) === 'fr', `French JD → fr, got ${detectLanguage(fr)}`);
      assert(detectLanguage(es) === 'es', `Spanish JD → es, got ${detectLanguage(es)}`);
      assert(detectLanguage(de) === 'de', `German JD → de, got ${detectLanguage(de)}`);
      // Title-only French (the authwalled fr.glassdoor.ca case) leans on diacritics.
      assert(detectLanguage('Développeur Logiciel Sénior') === 'fr', 'title-only French via diacritic fallback');
      return { ok: true };
    },
  },
  {
    name: 'tagJobLanguages + summarizeJobLanguages: tags non-English, leaves English untouched',
    run: () => {
      const jobs = [
        { title: 'Data Engineer', snippet: 'We are looking for an engineer to join our team and build pipelines with SQL and Python.', source: 'ziprecruiter', location: 'Toronto, ON' },
        { title: 'Développeur', snippet: "Nous recherchons un développeur pour rejoindre notre équipe et travailler sur des applications avec une bonne expérience du poste.", source: 'glassdoor', location: 'Montréal, QC' },
      ];
      tagJobLanguages(jobs);
      assert(jobs[0].language === undefined, `English job stays untagged, got ${jobs[0].language}`);
      assert(jobs[1].language === 'fr', `French job tagged fr, got ${jobs[1].language}`);
      const sum = summarizeJobLanguages(jobs);
      assert(sum.total === 2 && sum.nonEnglish === 1 && sum.byLang.fr === 1, `summary: 2 total, 1 fr → ${JSON.stringify(sum)}`);
      assert(/Montréal/.test(sum.samples.fr || ''), `fr sample names the listing → ${sum.samples.fr}`);
      return { ok: true, summary: sum };
    },
  },
  {
    name: 'hard login preflight (missing logins)',
    run: () => {
      const eqSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
      // Test mode scoped to poshmark, logged out → poshmark required & missing.
      assert(eqSet(computeMissingLogins([{ id: 'poshmark' }], { poshmark: { connected: false } }), ['poshmark']),
        'scoped poshmark logged-out → [poshmark]');
      // Same source logged in → nothing missing → run proceeds.
      assert(computeMissingLogins([{ id: 'poshmark' }], { poshmark: { connected: true } }).length === 0,
        'poshmark logged-in → no missing');
      // Full run: ebay-sold+ebay-active dedupe to one 'ebay'; only logged-out platforms returned.
      const full = computeMissingLogins(
        [{ id: 'ebay-sold' }, { id: 'ebay-active' }, { id: 'poshmark' }, { id: 'mercari' }, { id: 'pricecharting' }],
        { ebay: { connected: false }, poshmark: { connected: false }, mercari: { connected: true } },
      );
      assert(eqSet(full, ['ebay', 'poshmark']), `full run missing → ebay,poshmark (deduped, mercari ok, pricecharting no-login) → ${full}`);
      // A no-login-platform source (pricecharting) never imposes a requirement.
      assert(computeMissingLogins([{ id: 'pricecharting' }], {}).length === 0, 'pricecharting → no login requirement');
      return { ok: true };
    },
  },
  {
    name: 'marketplace renderer login preflight: required platforms derive from active comp sources',
    run: () => {
      const required = getRequiredCompLoginPlatformIds([
        { id: 'ebay-sold' },
        { id: 'ebay-active' },
        { id: 'poshmark' },
        { id: 'pricecharting' },
        { id: 'reverb' },
      ]);
      assert(required.join(',') === 'ebay,poshmark',
        `renderer preflight should dedupe login-backed sources and ignore no-login sources → ${required}`);
      assert(getRequiredCompLoginPlatformIds(['swappa', 'swappa-sold', 'mercari']).join(',') === 'swappa,mercari',
        'renderer preflight should accept source IDs and dedupe shared platform sessions');
      return { required };
    },
  },
  {
    name: 'settings auth verifier: soft login walls for marketplace platforms',
    run: () => {
      const facebookLoggedOut = 'Facebook Explore the things you love . Log into Facebook Email or mobile number Password Log in Forgot password? Create new account';
      assert(getSoftLoginWallMatch(facebookLoggedOut, getSellMonitorConfig('facebook')) === 'log into facebook',
        'facebook login page body must not cache connected:true');

      const poshmarkLoggedOut = 'Poshmark Login - Poshmark Log in to Poshmark Email Username Password';
      assert(getSoftLoginWallMatch(poshmarkLoggedOut, getSellMonitorConfig('poshmark')) === 'log in to poshmark',
        'poshmark login body must be detected');

      const mercariLoggedOut = 'Mercari Log in to Mercari Email address Password Log in Forgot password Sign up for Mercari';
      assert(getSoftLoginWallMatch(mercariLoggedOut, getSellMonitorConfig('mercari')) === 'log in to mercari',
        'mercari login body must be detected');

      const swappaLoggedOut = 'Swappa Log in to Swappa Email Password Sign in to Swappa';
      assert(getSoftLoginWallMatch(swappaLoggedOut, getSellMonitorConfig('swappa')) === 'log in to swappa',
        'swappa login body must be detected');

      const swappaLoggedIn = 'My Swappa - Swappa Find a good deal Search Swappa Loading search results Apple iPhone iPad';
      assert(getSoftLoginWallMatch(swappaLoggedIn, getSellMonitorConfig('swappa')) === null,
        'logged-in swappa trace should not false-positive as logged out');

      const missingMonitorConfigs = SELL_PLATFORMS
        .map(platform => platform.id)
        .filter(platformId => !getSellMonitorConfig(platformId));
      assert(missingMonitorConfigs.length === 0,
        `every Settings marketplace login must have a sell-monitor auth config; missing ${missingMonitorConfigs.join(', ')}`);
      assert(getSellMonitorConfig('depop')?.verifyUrl === 'https://www.depop.com/products/create/',
        'Depop must use its auth-gated create-listing page so cached login survives Settings reopen');

      for (const id of ['ebay', 'poshmark', 'mercari', 'swappa']) {
        assert(!!getSellMonitorConfig(id)?.connectedFinalUrlMustContain, `${id} should have a final URL guard`);
      }
      return { ok: true };
    },
  },
  {
    name: 'marketplace status badge label: unchecked vs checked unknown',
    run: () => {
      assert(getMarketplaceStatusLabel('unknown', null) === 'Not checked', 'unknown without timestamp means not checked');
      assert(getMarketplaceStatusLabel('unknown', '2026-06-03T19:39:47.686Z') === 'Unknown', 'unknown with timestamp means checked but inconclusive');
      assert(getMarketplaceStatusLabel('needs-login', '2026-06-03T19:39:47.686Z') === 'Needs login', 'needs-login label remains explicit');
      return { ok: true };
    },
  },
  {
    name: 'pricing notes: normalize and format for price synthesis prompt',
    run: () => {
      const notes = '  8x10 rug\n\nsmall coffee stain, pet home.  ';
      const normalized = normalizePricingNotes(notes);
      const promptBlock = formatPricingNotesForPrompt(notes);
      assert(normalized === '8x10 rug small coffee stain, pet home.', `pricing notes normalize whitespace → ${normalized}`);
      assert(promptBlock.includes('USER NOTES FROM SELLER') && promptBlock.includes(normalized), `pricing notes prompt block includes notes → ${promptBlock}`);
      assert(formatPricingNotesForPrompt('   ') === '', 'blank pricing notes do not add a prompt section');
      const long = normalizePricingNotes('x'.repeat(10_000));
      assert(long.length === 10_000, `pricing notes should remain uncapped, got ${long.length}`);
      return { ok: true };
    },
  },
  {
    name: 'price comp relevance: grossly off-target sources do not get forced round-robin slots',
    run: () => {
      const comps = [
        { source: 'ebay-sold', score: 10 },
        { source: 'ebay-sold', score: 8 },
        { source: 'mercari', score: 4 },
        { source: 'pricecharting', score: 1 },
        { source: 'pricecharting', score: 0.5 },
      ];
      const filtered = filterGrosslyOffTargetSources(comps, item => item.score);
      assert(filtered.sources.length === 1 && filtered.sources[0] === 'pricecharting',
        `only grossly off-target source rejected → ${JSON.stringify(filtered.sources)}`);
      assert(filtered.kept.length === 3 && filtered.rejected.length === 2, 'all good-source comps kept; wrong-source comps rejected');
      const oneSource = filterGrosslyOffTargetSources([{ source: 'only', score: 0 }], item => item.score);
      assert(oneSource.kept.length === 1 && oneSource.rejected.length === 0, 'never reject the only available source');
      return { ok: true };
    },
  },
  {
    name: 'marketplace pipeline report: bundle items and late retries are explicit',
    run: () => {
      const telemetry = getMarketplaceTelemetry();
      const saved = { ...telemetry };
      const now = Date.now();
      Object.assign(telemetry, {
        nodeId: 'bundle-hub',
        windowId: 7,
        analyze: null,
        scrape: {
          ts: now - 500,
          sources: 8, items: 2, sold: 30, active: 10, warnings: 1,
          blocked: 0, errored: 0, timedOut: 1, loginRequired: 0,
          bySource: {}, sourceWarnings: {},
          itemDetails: [
            { index: 0, query: 'watering timer', label: 'Watering Timer', sold: 20, active: 5, warnings: [] },
            { index: 1, query: 'glass jug', label: 'Glass Jug', sold: 10, active: 5, warnings: [{ sourceId: 'ebay-sold', code: 'scrape-timeout' }] },
          ],
        },
        resolves: {
          'ebay-sold': {
            ts: now - 50,
            extracted: 61,
            category: 'sold',
            via: 'bundle-rescrape',
            warningCount: 1,
            itemCounts: [{ count: 60 }, { count: 1, warning: 'zero-extracted' }],
          },
        },
        synthesis: null,
        syntheses: [
          { ts: now - 200, startedAt: now - 400, itemKey: 'primary', itemLabel: 'Watering Timer', soldFound: 0, activeFound: 0, soldUsed: 0, activeUsed: 0, recommendedPrice: null, matchQuality: 'none' },
          { ts: now - 100, startedAt: now - 190, itemKey: 'jug', itemLabel: 'Glass Jug', soldFound: 0, activeFound: 0, soldUsed: 0, activeUsed: 0, recommendedPrice: null, matchQuality: 'none' },
        ],
        bundle: {
          ts: now - 80,
          items: 2,
          unpriced: 0,
          sum: 40,
          quickPrice: 38,
          bundlePrice: 42,
          maxPrice: 46,
          synergy: 'premium',
          adjustmentPercent: 5,
          quickReductionPercent: 10,
          maxIncreasePercent: 10,
          bundleFactors: [{ direction: 'premium', percent: 8, reason: 'Complete ready-to-use system' }, { direction: 'discount', percent: 3, reason: 'Buyer must take both items' }],
          quickFactors: [{ percent: 10, reason: 'Focused buyer pool' }],
          maxFactors: [{ percent: 10, reason: 'Patient seller can wait for the right buyer' }],
          factorCapsApplied: null,
          rejectedFactors: null,
        },
        fit: null,
      });
      try {
        const report = buildMarketplacePipelineSnapshot(new Set(['bundle-hub']), 7);
        assert(report.includes('Item 1 — "Watering Timer" · q="watering timer"') && report.includes('Item 2 — "Glass Jug" · q="glass jug"'),
          'bundle report names each item scrape with its title');
        assert(!report.includes('query term(s) absent from the title'),
          'no drift flag when each query matches its item title');
        assert(report.includes('Price synthesis — Watering Timer') && report.includes('Price synthesis — Glass Jug'),
          'bundle report renders each item synthesis');
        assert(report.includes('arrived after AI pricing began'), 'late retry is explicitly marked as excluded from finalized pricing');
        assert(report.includes('1 retry warning(s) remained'),
          'retry warnings remain visible instead of being auto-accepted');
        assert(report.includes('Bundle factors: +8% Complete ready-to-use system; -3% Buyer must take both items')
            && report.includes('factor net=+5% vs sum'),
          'FULL marketplace report preserves attributable bundle factors and their derived net');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
  {
    name: 'marketplace pipeline report: query↔title drift flag fires when an item is priced against a different product',
    run: () => {
      const telemetry = getMarketplaceTelemetry();
      const saved = { ...telemetry };
      const now = Date.now();
      Object.assign(telemetry, {
        nodeId: 'drift-hub', windowId: 3, analyze: null,
        scrape: {
          ts: now - 100, sources: 8, items: 3, sold: 6, active: 2, warnings: 0,
          blocked: 0, errored: 0, timedOut: 0, loginRequired: 0, bySource: {}, sourceWarnings: {},
          itemDetails: [
            // The bug signature: the title is just the insert, but the query is a
            // bundle-wide string that drags in a second product (Exotac titanLIGHT).
            { index: 0, query: 'Zippo butane insert Exotac titanLIGHT lighter bundle', label: 'Zippo 65827 Butane Lighter Insert', sold: 3, active: 1, warnings: [] },
            { index: 1, query: 'Zippo Butane Fuel 115ml', label: 'Zippo Butane Fuel, 115ml', sold: 2, active: 1, warnings: [] },
            // NOT drift: a terse title + a legitimately broader query that only
            // adds the brand + a spec token (256gb). Just one foreign WORD
            // ("apple"); the alphanumeric spec is excluded → below the 2-word
            // floor, so a normal item isn't mis-flagged.
            { index: 2, query: 'Apple iPhone XS 256GB', label: 'iPhone XS', sold: 1, active: 0, warnings: [] },
          ],
        },
        resolves: {}, synthesis: null, syntheses: [], bundle: null, fit: null,
      });
      try {
        const report = buildMarketplacePipelineSnapshot(new Set(['drift-hub']), 3);
        const item1Line = report.split('\n').find(l => l.includes('Item 1')) || '';
        assert(/query term\(s\) absent from the title \([^)]*exotac[^)]*\)/i.test(item1Line),
          `drifted item 1 is flagged with the offending tokens — got: ${item1Line}`);
        const item2Line = report.split('\n').find(l => l.includes('Item 2')) || '';
        assert(!/query term\(s\) absent from the title/.test(item2Line),
          `the clean item 2 (query ⊆ title) is NOT flagged — got: ${item2Line}`);
        const item3Line = report.split('\n').find(l => l.includes('Item 3')) || '';
        assert(!/query term\(s\) absent from the title/.test(item3Line),
          `terse title + broader query with a spec token is NOT mis-flagged — got: ${item3Line}`);
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
  {
    name: 'marketplace pipeline report: browser-contention flag explains task-failed from a concurrent captcha-resolve',
    run: () => {
      const telemetry = getMarketplaceTelemetry();
      const saved = { ...telemetry };
      const now = Date.now();
      const baseScrape = {
        ts: now - 100, sources: 8, items: 1, sold: 50, active: 0, warnings: 2,
        blocked: 0, errored: 2, timedOut: 0, loginRequired: 0,
        bySource: {}, sourceWarnings: {},
      };
      // With contention: a job-side captcha-resolve closed the shared browser
      // mid-scrape and detached ebay-sold + poshmark → their task-failed results
      // are internal contention, not anti-bot. The report must SAY so rather than
      // leave the reader to correlate timestamps by hand (the FULL-report gap this
      // whole change closes).
      Object.assign(telemetry, {
        nodeId: 'contention-hub', windowId: 4, analyze: null,
        scrape: { ...baseScrape, browserContention: { handoffAt: now - 120, detachedSources: ['ebay-sold', 'poshmark'] } },
        resolves: {}, synthesis: null, syntheses: [], bundle: null, fit: null,
      });
      try {
        const report = buildMarketplacePipelineSnapshot(new Set(['contention-hub']), 4);
        // Match the distinctive bolded flag (the scrape-error footnote also
        // mentions "Browser contention" in prose, so a loose match would alias).
        const flagLine = report.split('\n').find(l => l.includes('**Browser contention**')) || '';
        assert(flagLine, 'contention run renders the bolded Browser contention flag line');
        assert(/ebay-sold, poshmark/.test(flagLine), 'contention line names the detached sources');
        assert(/INTERNAL contention/.test(flagLine) && /NOT anti-bot/i.test(flagLine),
          'contention line states the failures are internal, not anti-bot');
        // Control: no browserContention → no flag line (don't cry wolf on a
        // genuine block).
        telemetry.scrape = { ...baseScrape, browserContention: null };
        const clean = buildMarketplacePipelineSnapshot(new Set(['contention-hub']), 4);
        assert(!clean.includes('**Browser contention**'), 'no flag line when browserContention is null');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
  {
    name: 'listing status: aggregate never returns a blank diagnostic',
    run: () => {
      const fallback = aggregateStrongest([
        { url: 'https://www.ebay.com/itm/236855303972', urlLabel: 'listing', status: 'unknown', message: '' },
      ]);
      assert(fallback.status === 'unknown', `fallback status remains unknown, got ${fallback.status}`);
      assert(/No clear status signal/i.test(fallback.message), `blank unknown gets fallback message -> ${fallback.message}`);

      const preferred = aggregateStrongest([
        { url: 'https://www.ebay.com/itm/236855303972', urlLabel: 'listing', status: 'unknown', message: '   ' },
        { url: 'https://www.ebay.com/sh/lst/active', urlLabel: 'platform watch', status: 'unknown', message: '[platform watch] Identifier was not present on this page.' },
      ]);
      assert(preferred.message.includes('Identifier was not present'), `same-rank result with message is preferred -> ${preferred.message}`);
      return { ok: true };
    },
  },
  {
    name: 'listing status: attention is scoped to sources that located this listing (no dashboard bleed)',
    run: () => {
      const high = (h) => ({ urgency: 'high', category: 'offer', headline: h, evidence: h });
      // A deleted listing: its own page 4xx'd to `ended` (no attention); five
      // dashboards were no-match for it but each emitted a sibling listing's
      // high-urgency offer. None of that bleed should reach the card.
      const deleted = aggregateStrongest([
        { url: 'https://www.facebook.com/share/1FpnZtE25M/', urlLabel: 'listing', status: 'ended', message: 'gone (HTTP 400)' },
        ...Array.from({ length: 5 }, (_, i) => ({
          url: `https://fb.com/dash${i}`, urlLabel: 'platform watch', status: 'unknown', matched: false,
          message: 'not present', attention: [high(`sibling offer ${i}`)],
        })),
      ]);
      assert(deleted.status === 'ended', `ended wins, got ${deleted.status}`);
      assert(deleted.attention.length === 0, `no-match dashboard attention is dropped, got ${deleted.attention.length}`);

      // Legit attention is kept: the listing's own page, a matched watch page, and
      // a watch page that reached a definite verdict all count; only the no-match
      // unknown dashboard is dropped.
      const live = aggregateStrongest([
        { url: 'https://ebay.com/itm/1', urlLabel: 'listing', status: 'live', matched: true, message: 'live', attention: [high('own-page watcher spike')] },
        { url: 'https://ebay.com/active', urlLabel: 'platform watch', status: 'live', matched: true, message: 'active row', attention: [high('matched dashboard offer')] },
        { url: 'https://ebay.com/other', urlLabel: 'platform watch', status: 'unknown', matched: false, message: 'not present', attention: [high('bleed offer')] },
      ]);
      const heads = live.attention.map(a => a.headline);
      assert(heads.includes('own-page watcher spike'), 'listing own-page attention kept');
      assert(heads.includes('matched dashboard offer'), 'matched dashboard attention kept');
      assert(!heads.includes('bleed offer'), 'no-match unknown dashboard attention dropped');
      return { ok: true };
    },
  },
  {
    name: 'listing status: listing URL is required before watch URLs are scanned',
    run: async () => {
      const result = await checkListingStatusMultiSource({
        listingUrl: '',
        platformId: 'ebay',
        watchUrls: ['https://www.ebay.com/sh/lst/active'],
        productTitle: 'Apple iPhone 14 Pro',
      });
      assert(result.status === 'error', `blank listing URL should fail before scraping, got ${result.status}`);
      assert(/No listing URL/i.test(result.message), `message should ask for listing URL -> ${result.message}`);
      assert(Array.isArray(result.sources) && result.sources.length === 0, 'blank listing URL should not scan watch URLs');
      return { ok: true };
    },
  },
  {
    name: 'listing status: expired marketplace session returns needs-login before scraping',
    run: async () => {
      let verifiedPlatform = null;
      let wroteStatus = null;
      const result = await checkListingStatusMultiSource({
        listingUrl: 'https://www.facebook.com/marketplace/item/123456789',
        platformId: 'facebook',
        productTitle: 'Apple iPhone XS',
        sessionVerifier: async (platformId) => {
          verifiedPlatform = platformId;
          return { connected: false, reason: 'Redirected to https://www.facebook.com/login', trace: { finalUrl: 'https://www.facebook.com/login' } };
        },
        writeSessionStatus: async (platformId, connected, extras) => {
          wroteStatus = { platformId, connected, extras };
        },
      });
      assert(verifiedPlatform === 'facebook', `session verifier should run for facebook, got ${verifiedPlatform}`);
      assert(wroteStatus?.platformId === 'facebook' && wroteStatus.connected === false, 'expired session should be written to cache');
      assert(result.status === 'needs-login', `expired session should return needs-login, got ${result.status}`);
      assert(/log in to Facebook/i.test(result.message), `message should tell user to log in -> ${result.message}`);
      assert(result.sources?.[0]?.urlLabel === 'session', 'needs-login result should include a session source trace');
      return { ok: true };
    },
  },
  {
    name: 'listing status: cached disconnected marketplace session blocks before scraping',
    run: async () => {
      const cache = getStatusCacheSync();
      const hadPrior = Object.prototype.hasOwnProperty.call(cache, 'mercari');
      const prior = cache.mercari;
      await writeStatusCache('mercari', false, { lastReason: 'Verification fetch error: page.content() timed out' });
      try {
        let verifierCalled = false;
        const result = await checkListingStatusMultiSource({
          listingUrl: 'https://www.mercari.com/us/item/m44325565616/',
          platformId: 'mercari',
          productTitle: 'Calibrite ColorChecker Passport Video 2',
          sessionVerifier: async () => {
            verifierCalled = true;
            return { connected: true, reason: 'should not run' };
          },
        });
        assert(!verifierCalled, 'cached disconnected session should block before verifier/scrape');
        assert(result.status === 'needs-login', `cached disconnected session should return needs-login, got ${result.status}`);
        assert(/Mercari session needs login/i.test(result.message), `needs-login message should name Mercari -> ${result.message}`);
        assert(/page\.content\(\) timed out/i.test(result.message), `needs-login message should include cached verifier reason -> ${result.message}`);
        assert(result.sources?.[0]?.urlLabel === 'session', 'cached auth gate should include a session source trace');
      } finally {
        if (hadPrior) cache.mercari = prior;
        else delete cache.mercari;
      }
      return { ok: true };
    },
  },
  {
    name: 'listing status: hard client errors distinguish canonical listings from Facebook share links',
    run: () => {
      // 400 on most canonical listing pages is gone. Facebook listing URLs are
      // weaker evidence: seller-owned/in-review items can 400 to automation
      // while authenticated listing/dashboard evidence still shows them active.
      const canonicalDeleted = goneListingResult({ status: 400, url: 'https://www.ebay.com/itm/123456789/', urlLabel: 'listing' });
      assert(canonicalDeleted?.status === 'ended', `400 on non-Facebook canonical listing → ended, got ${canonicalDeleted?.status}`);
      assert(/removed, deleted, or sold/i.test(canonicalDeleted.message), `ended message explains removal -> ${canonicalDeleted?.message}`);
      const facebookCanonicalAmbiguous = goneListingResult({ status: 400, url: 'https://www.facebook.com/marketplace/item/123456789/', urlLabel: 'listing' });
      assert(facebookCanonicalAmbiguous?.status === 'unknown', `400 on Facebook canonical listing should be unknown, got ${facebookCanonicalAmbiguous?.status}`);
      assert(/active or in-review/i.test(facebookCanonicalAmbiguous.message), `Facebook canonical 400 message should explain ambiguity -> ${facebookCanonicalAmbiguous.message}`);
      const shareAmbiguous = goneListingResult({ status: 400, url: 'https://www.facebook.com/share/1FpnZtE25M/', urlLabel: 'listing' });
      assert(shareAmbiguous?.status === 'unknown', `400 on Facebook share URL should be unknown, got ${shareAmbiguous?.status}`);
      // The share message is SPECIALIZED (distinct from the canonical-item one):
      // it names the share-link cause and the actionable fix (paste /marketplace/item/).
      assert(/share link/i.test(shareAmbiguous.message), `share 400 message should name the share-link cause -> ${shareAmbiguous.message}`);
      assert(/marketplace\/item/i.test(shareAmbiguous.message), `share 400 message should point at the canonical URL -> ${shareAmbiguous.message}`);
      assert(shareAmbiguous.message !== facebookCanonicalAmbiguous.message, 'share message must differ from the canonical-item message');
      // 400 on a watch/dashboard URL is NOT a removal signal (could be a transient
      // dashboard hiccup) → no terminal verdict.
      assert(goneListingResult({ status: 400, url: 'https://www.facebook.com/marketplace/you/selling', urlLabel: 'platform watch' }) === null, '400 on a watch URL is not ended');
      // 404/410 stay "gone" for any page; non-gone statuses return null.
      assert(goneListingResult({ status: 404, url: 'x', urlLabel: 'platform watch' })?.status === 'ended', '404 on any page → ended');
      assert(goneListingResult({ status: 410, url: 'x', urlLabel: 'listing' })?.status === 'ended', '410 → ended');
      assert(goneListingResult({ status: 200, url: 'x', urlLabel: 'listing' }) === null, '200 is not gone');
      assert(goneListingResult({ status: 403, url: 'x', urlLabel: 'listing' }) === null, '403 (auth) is handled elsewhere, not ended');
      return { ok: true };
    },
  },
  {
    name: 'listing status: classifyOneUrl maps a non-Facebook 400 canonical listing page to ended before the LLM',
    run: async () => {
      const fetcher = async () => ({
        ok: true,
        status: 400,
        finalUrl: 'https://www.ebay.com/itm/123456789/',
        html: '<html><body>Something went wrong. This content is not available right now.</body></html>'.padEnd(400, ' '),
      });
      const res = await classifyOneUrl({
        url: 'https://www.ebay.com/itm/123456789/',
        listingIdentifier: '123456789',
        productTitle: 'Apple iPhone XS',
        platformId: undefined, // no monitor config → no soft-wall interception, no LLM reached
        urlLabel: 'listing',
        fetcher,
      });
      assert(res.status === 'ended', `400 listing page should classify ended without the LLM, got ${res.status}`);
      return { ok: true };
    },
  },
  {
    name: 'listing status: Facebook canonical 400 is ambiguous so live watch evidence can win',
    run: async () => {
      const fetcher = async () => ({
        ok: true,
        status: 400,
        finalUrl: 'https://www.facebook.com/marketplace/item/27086638057612157/',
        html: '<html><body>Something went wrong. This content is not available right now.</body></html>'.padEnd(400, ' '),
      });
      const listing = await classifyOneUrl({
        url: 'https://www.facebook.com/marketplace/item/27086638057612157/',
        listingIdentifier: '27086638057612157',
        productTitle: 'Lenovo ThinkPad T540p',
        platformId: 'facebook',
        urlLabel: 'listing',
        fetcher,
      });
      assert(listing.status === 'unknown', `Facebook canonical 400 should be unknown, got ${listing.status}`);

      const aggregate = aggregateStrongest([
        listing,
        {
          url: 'https://www.facebook.com/marketplace/you/selling',
          urlLabel: 'platform watch',
          status: 'live',
          matched: false,
          message: '[platform watch] Seller dashboard shows the listing as active/in review.',
        },
      ]);
      assert(aggregate.status === 'live', `live watch evidence should beat ambiguous Facebook 400, got ${aggregate.status}`);
      assert(/active\/in review/i.test(aggregate.message), `aggregate should use the live watch message -> ${aggregate.message}`);
      return { ok: true };
    },
  },
  {
    name: 'listing status: Facebook owner controls classify as live without treating action labels as sold',
    run: async () => {
      const reviewText = 'This listing is in review All listings go through a standard review before they become visible to others. Lenovo ThinkPad T540p $145 Delete Listing';
      const review = deterministicListingStatusFromText({
        text: reviewText,
        platformId: 'facebook',
        url: 'https://www.facebook.com/marketplace/item/27086638057612157/',
        urlLabel: 'listing',
        matched: false,
      });
      assert(review?.status === 'live', `Facebook review banner should classify as live/non-terminal, got ${review?.status}`);
      assert(review.attention?.[0]?.headline === 'Listing currently being reviewed', 'Facebook review banner should create an info attention item');

      const text = 'Calibrite ColorChecker Passport Video 2 (CCPPV2) $75 Mark as sold Mark as pending Boost listing Edit Share Details Seller information';
      const deterministic = deterministicListingStatusFromText({
        text,
        platformId: 'facebook',
        url: 'https://www.facebook.com/marketplace/item/763727366765755/',
        urlLabel: 'listing',
        matched: false,
      });
      assert(deterministic?.status === 'live', `Facebook owner controls should classify live, got ${deterministic?.status}`);
      assert(deterministic.matched === false, 'deterministic result should preserve the identifier match diagnostic');
      assert(deterministicListingStatusFromText({ text, platformId: 'facebook', urlLabel: 'platform watch' }) === null, 'owner-control shortcut should not run on dashboard/watch pages');

      const fetcher = async () => ({
        ok: true,
        status: 200,
        finalUrl: 'https://www.facebook.com/marketplace/item/763727366765755/',
        html: `<html><body>${text}</body></html>`.padEnd(400, ' '),
      });
      const res = await classifyOneUrl({
        url: 'https://www.facebook.com/marketplace/item/763727366765755/',
        listingIdentifier: '763727366765755',
        productTitle: 'Calibrite ColorChecker Passport Video 2 (CCPPV2)',
        platformId: 'facebook',
        urlLabel: 'listing',
        fetcher,
      });
      assert(res.status === 'live', `Facebook owner controls should return live before the LLM, got ${res.status}`);
      assert(/owner actions for an active listing/i.test(res.message), `live message should explain action labels -> ${res.message}`);
      return { ok: true };
    },
  },
  {
    name: 'listing status: statusCheckWrites persists a compact per-URL check trace',
    run: () => {
      const res = {
        status: 'unknown',
        message: '[listing] 400 …',
        attention: [],
        listingIdentifier: '1FpnZtE25M',
        sources: [
          { url: 'https://www.facebook.com/share/1FpnZtE25M/', urlLabel: 'listing', status: 'unknown', matched: false },
          { url: 'https://www.facebook.com/marketplace/you/selling', urlLabel: 'platform watch', status: 'unknown', matched: false },
        ],
      };
      const fields = { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked', trace: 'lastCheckTrace' };
      const writes = statusCheckWrites(res, fields);
      assert(writes.lastCheckTrace?.identifier === '1FpnZtE25M', 'trace keeps the identity anchor');
      assert(writes.lastCheckTrace?.sources?.length === 2, 'trace keeps per-URL rows');
      assert(writes.lastCheckTrace.sources[0].label === 'listing' && writes.lastCheckTrace.sources[0].status === 'unknown', 'trace row carries label + status');
      assert(writes.lastCheckTrace.sources[1].matched === false, 'trace row carries the identity-anchor match flag');
      assert(!('reason' in writes.lastCheckTrace.sources[0]), 'non-error rows carry no reason (would bloat the trace + break ×N collapse)');
      // An `error` row captures a bounded reason (the WHY behind a bare
      // `listing=error`), with the `[label]` prefix stripped and capped at 80 chars.
      const errRes = {
        status: 'live', message: '[platform watch] live', attention: [], listingIdentifier: '236855247964',
        sources: [
          { url: 'https://www.ebay.com/itm/236855247964', urlLabel: 'listing', status: 'error', matched: null, message: '[listing] Fetch failed: net::ERR_CONNECTION_RESET navigating the eBay item page after anti-bot rate-limit' },
          { url: 'https://www.ebay.com/sh/lst/active', urlLabel: 'platform watch', status: 'live', matched: true, message: '[platform watch] live in Active table' },
        ],
      };
      const errWrites = statusCheckWrites(errRes, fields);
      const errRow = errWrites.lastCheckTrace.sources[0];
      assert(errRow.reason && errRow.reason.startsWith('Fetch failed:'), `error row captures the reason with [label] stripped -> ${errRow.reason}`);
      assert(errRow.reason.length <= 80, `error reason is capped at 80 chars -> ${errRow.reason.length}`);
      assert(!('reason' in errWrites.lastCheckTrace.sources[1]), 'the live watch row that saved the card carries no reason');
      // Back-compat: a caller without a trace field never gets one written.
      const noTrace = statusCheckWrites(res, { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked' });
      assert(!('lastCheckTrace' in noTrace), 'trace omitted when fields.trace is absent');
      return { ok: true };
    },
  },
  {
    name: 'marketplace status roll-up: flags listing-err→watch rescues + needs-login; empty canvas → no section',
    run: () => {
      const card = (platformId, status, listingStatus, lastChecked) => ({
        type: 'marketplacecard',
        data: {
          platformId, status, lastChecked,
          lastCheckTrace: { sources: [
            { label: 'listing', status: listingStatus },
            { label: 'platform watch', status: status === 'live' ? 'live' : 'unknown' },
          ] },
        },
      });
      const now = Date.now();
      const nodes = [
        card('ebay', 'live', 'error', new Date(now - 1000).toISOString()),   // rescued
        card('ebay', 'live', 'error', new Date(now - 2000).toISOString()),   // rescued
        card('ebay', 'live', 'live', new Date(now - 3000).toISOString()),    // clean direct check
        card('mercari', 'needs-login', 'needs-login', new Date(now - 4000).toISOString()),
        card('facebook', 'unknown', 'unknown', new Date(now - 5000).toISOString()),
      ];
      const md = buildMarketplaceStatusRollup(nodes);
      assert(/## Marketplace Status Roll-up/.test(md), 'renders the roll-up section');
      assert(/5 listing card\(s\) across 3 platform\(s\)/.test(md), `counts cards + platforms -> ${md.split('\n').find(l => l.includes('listing card'))}`);
      assert(/2 card\(s\) had the \*\*listing-page check error, rescued by a platform-watch\*\* \(ebay ×2\)/.test(md), 'flags the eBay listing-err→watch rescues');
      assert(/1 needs-login \(mercari ×1\)/.test(md), 'flags the needs-login card');
      assert(/\| ebay \| 3 \| 3 \| 0 \| 0 \| 0 \| 0 \| 0 \| 2 \|/.test(md), `per-platform table: ebay 3 cards, 3 live, 2 rescued -> ${md.split('\n').find(l => l.startsWith('| ebay'))}`);
      // A canvas with no marketplace cards emits nothing (no empty section).
      assert(buildMarketplaceStatusRollup([{ type: 'jobcard', data: {} }]) === '', 'no marketplace cards → empty string');
      // A fully-clean run says so.
      const clean = buildMarketplaceStatusRollup([card('ebay', 'live', 'live', new Date().toISOString())]);
      assert(/✅ No errored, rescued, or needs-login cards/.test(clean), 'clean run gets the all-clear line');
      return { ok: true };
    },
  },
  {
    name: 'listing status writes: cached auth gate writes needs-login card state',
    run: () => {
      const res = cachedAuthNeedsLoginResult({
        platformId: 'mercari',
        name: 'Mercari',
        reason: 'Verification fetch error: page.content() timed out',
      });
      const writes = statusCheckWrites(res, { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked', trace: 'lastCheckTrace' });
      assert(writes.status === 'needs-login', `cached auth writes needs-login, got ${writes.status}`);
      assert(/Mercari session needs login/i.test(writes.statusMessage), `cached auth message names Mercari -> ${writes.statusMessage}`);
      assert(writes.lastCheckTrace?.sources?.[0]?.label === 'session', 'cached auth writes session trace');
      return { ok: true };
    },
  },
  {
    name: 'listing status writes: thrown errors clear stale attention',
    run: () => {
      const writes = statusErrorWrites(new Error('Browser closed'), {
        status: 'status',
        message: 'statusMessage',
        lastChecked: 'lastChecked',
        attention: 'attention',
      });
      assert(writes.status === 'error', `thrown error should write error status, got ${writes.status}`);
      assert(Array.isArray(writes.attention) && writes.attention.length === 0, 'thrown error should clear stale attention panels');
      assert(!!writes.lastChecked, 'thrown error should stamp lastChecked');
      return { ok: true };
    },
  },
  {
    name: 'marketplace platform support excludes Whatnot',
    run: () => {
      const sellIds = SELL_PLATFORMS.map(p => p.id);
      const schemaIds = PRICE_SYNTHESIS_SCHEMA.properties.recommended_platforms.items.properties.id.enum;
      assert(!sellIds.includes('whatnot'), `SELL_PLATFORMS should not include whatnot -> ${sellIds}`);
      assert(!schemaIds.includes('whatnot'), `recommended_platforms schema should not include whatnot -> ${schemaIds}`);
      assert(!Object.prototype.hasOwnProperty.call(PLATFORM_LOGIN_URLS, 'whatnot'), 'auth login registry should not include whatnot');
      return { ok: true };
    },
  },
  {
    name: 'comp scrape login-vs-selectors classification',
    run: () => {
      const SC = (extra) => `SITE_CHANGED: poshmark tile-grid-redesign extractor returned 0 — selectors or page structure may have changed [diag ${extra}]`;
      const loggedOut = { poshmark: { connected: false } };
      const loggedIn  = { poshmark: { connected: true } };

      // (a) Page-level login wall → promoted to login-required (sign in, don't fix selectors).
      const wall = classifyCompScrapeFailure(SC('cards=0 titleSel=0 path=/login LOGIN-WALL/anon-page'), 'poshmark', loggedOut);
      assert(wall.code === 'login-required' && wall.severity === 'block', `login wall → login-required, got ${wall.code}`);
      assert(/log in to poshmark/i.test(wall.suggestion), `login-required suggestion should name the platform → ${wall.suggestion}`);

      // (b) Real redesign (cards present, sub-selector gone) while logged IN → stale-selectors, no login noise.
      const redesign = classifyCompScrapeFailure(SC('cards=24 titleSel=0'), 'poshmark', loggedIn);
      assert(redesign.code === 'stale-selectors', `redesign → stale-selectors, got ${redesign.code}`);
      assert(!/log in/i.test(redesign.suggestion), `logged-in redesign must not suggest login → ${redesign.suggestion}`);

      // (c) No hard login wall but the platform isn't connected → still stale-selectors,
      //     but the suggestion nudges toward logging in first (softer corroborator).
      const ambiguous = classifyCompScrapeFailure(SC('cards=0 titleSel=0 path=/search'), 'poshmark', loggedOut);
      assert(ambiguous.code === 'stale-selectors', `ambiguous → stale-selectors, got ${ambiguous.code}`);
      assert(/not logged in/i.test(ambiguous.suggestion), `logged-out ambiguous should mention login → ${ambiguous.suggestion}`);

      // (d) A navigation TIMEOUT is its own bucket — NOT 'task-failed' (which implies
      //     a profile-lock/browser conflict). A 45s hang is a slow/hung site or tarpit.
      const timeout = classifyCompScrapeFailure('Scrape timed out after 45000ms for https://poshmark.com/search', 'poshmark', loggedOut);
      assert(timeout.code === 'scrape-timeout', `timeout → scrape-timeout, got ${timeout.code}`);
      assert(/tarpit/i.test(timeout.suggestion) && !/profile-lock conflict\.?$/i.test(timeout.suggestion), `timeout suggestion should say tarpit, not profile-lock → ${timeout.suggestion}`);
      assert(/not logged in/i.test(timeout.suggestion), `logged-out timeout should mention login → ${timeout.suggestion}`);

      // (e) A genuine internal throw (no "timeout" wording) → task-failed.
      const failed = classifyCompScrapeFailure('Protocol error: Target closed', 'poshmark', loggedOut);
      assert(failed.code === 'task-failed', `internal throw → task-failed, got ${failed.code}`);
      return { ok: true };
    },
  },
  {
    name: 'modelTag fallback reason',
    run: () => {
      // No model recorded → empty (older telemetry).
      assert(modelTag(null) === '', 'modelTag: null model is empty');
      // Top model, no fallback → bare model, no flags.
      assert(modelTag('gemini-3.1-pro-preview') === ' · model: `gemini-3.1-pro-preview`', 'modelTag: top model bare');
      // Lite model with no recorded reason → legacy bare weak-fallback flag.
      assert(modelTag('gemini-3.1-flash-lite') === ' · model: `gemini-3.1-flash-lite` ⚠️ weak fallback', 'modelTag: lite without reason');
      // Lite model WITH reason → reason is surfaced (the gap this closes): a
      // reader sees quota (external) vs truncation (our cap) without the logs.
      const quota = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit' });
      assert(quota.includes('⚠️ weak fallback (rate-limit: 3 stronger model(s) failed)'), `modelTag: lite with reason → ${quota}`);
      // Non-lite model that still fell back → lighter "↪ fell back" note.
      const partial = modelTag('gemini-3.5-flash', { attempts: 1, reason: 'truncation' });
      assert(partial.includes('↪ fell back (truncation: 1 stronger model(s) failed)'), `modelTag: non-lite partial fallback → ${partial}`);
      assert(!partial.includes('weak fallback'), 'modelTag: non-lite is not flagged weak');
      // MIXED chain (the reported trap): 2 quota + 1 truncation. `reason` alone
      // would say only "rate-limit" and hide the truncation (whose fix — raise our
      // cap — is the opposite of quota's). counts must drive a breakdown.
      const mixed = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit', counts: { 'rate-limit': 2, truncation: 1 } });
      assert(mixed.includes('rate-limit×2 + truncation×1: 3 stronger model(s) failed'), `modelTag: mixed chain must show breakdown → ${mixed}`);
      // Single-cause counts → no ×N noise, falls back to the plain reason.
      const single = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit', counts: { 'rate-limit': 3 } });
      assert(single.includes('(rate-limit: 3 stronger model(s) failed)'), `modelTag: single-cause stays plain → ${single}`);
      return { ok: true };
    },
  },
  {
    name: 'over-priced recommendation sanity flag',
    run: () => {
      // The reported case: recommended $849 above the $846.59 sold max → flagged.
      const f = overPricedSoldFlag(849, { max: 846.59, median: 625 }, null);
      assert(f && /ABOVE the highest actual sold comp \(\$846\.59\)/.test(f) && /Median sold was \$625/.test(f),
        `should flag $849 over $846.59 (incl. median) → ${f}`);
      // Within the sold range → no flag.
      assert(overPricedSoldFlag(800, { max: 846.59, median: 625 }, null) === null, 'at/below sold max → no flag');
      // An active listing at/above the recommendation justifies it → suppressed.
      assert(overPricedSoldFlag(849, { max: 846.59 }, { max: 900 }) === null, 'active >= rec suppresses the flag');
      // Robust to missing/zero/null stats.
      assert(overPricedSoldFlag(849, null, null) === null, 'no sold stats → no flag');
      assert(overPricedSoldFlag(null, { max: 800 }, null) === null, 'null price → no flag');
      assert(overPricedSoldFlag(849, { max: 0 }, null) === null, 'zero sold max → no flag');
      return { ok: true };
    },
  },
  {
    name: 'shared-profile lock serializes browser launchers (Indeed vs manual scraper)',
    run: async () => {
      // Two launchers must NOT overlap on the shared Chrome profile — the second
      // can't start until the first fully settles (launch→scrape→close).
      const order = [];
      let releaseA;
      const aGate = new Promise(r => { releaseA = r; });
      const p1 = withSharedProfileLock(async () => { order.push('A-start'); await aGate; order.push('A-end'); return 'a'; });
      const p2 = withSharedProfileLock(async () => { order.push('B-start'); return 'b'; });
      // Flush microtasks: A may start, but B must still be queued behind it.
      await new Promise(r => setTimeout(r, 0));
      assert(order.join(',') === 'A-start', `B must not start until A ends — got [${order.join(',')}]`);
      releaseA();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert(r1 === 'a' && r2 === 'b', 'each caller observes its own fn result');
      assert(order.join(',') === 'A-start,A-end,B-start', `B runs strictly after A — got [${order.join(',')}]`);
      // A rejection must NOT wedge the queue — the next acquirer still runs.
      const errMsg = await withSharedProfileLock(async () => { throw new Error('boom'); }).catch(e => e.message);
      const recovered = await withSharedProfileLock(async () => 'recovered');
      assert(errMsg === 'boom' && recovered === 'recovered', 'queue survives a rejected critical section');
      return { ok: true, order: order.join(',') };
    },
  },
  {
    name: 'status-check lock serializes checks across hubs/cards (FIFO, depth, rejection-safe)',
    run: async () => {
      // Two status checks (e.g. two "Check All"s) must NOT overlap — the second
      // can't start until the first settles, so the single-IP burst stays at one
      // check's worth.
      const order = [];
      let releaseA;
      const aGate = new Promise(r => { releaseA = r; });
      const before = getStatusCheckQueueDepth();
      const p1 = withStatusCheckLock(async () => { order.push('A-start'); await aGate; order.push('A-end'); return 'a'; });
      const p2 = withStatusCheckLock(async () => { order.push('B-start'); return 'b'; });
      // Both enqueued, neither settled → depth reflects two in flight ahead of any new caller.
      assert(getStatusCheckQueueDepth() === before + 2, `depth should count both pending checks — got ${getStatusCheckQueueDepth()}`);
      await new Promise(r => setTimeout(r, 0));
      assert(order.join(',') === 'A-start', `B must not start until A settles — got [${order.join(',')}]`);
      releaseA();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert(r1 === 'a' && r2 === 'b', 'each caller observes its own fn result');
      assert(order.join(',') === 'A-start,A-end,B-start', `B runs strictly after A — got [${order.join(',')}]`);
      assert(getStatusCheckQueueDepth() === before, `depth returns to baseline once settled — got ${getStatusCheckQueueDepth()}`);
      // A rejection must NOT wedge the queue.
      const errMsg = await withStatusCheckLock(async () => { throw new Error('boom'); }).catch(e => e.message);
      const recovered = await withStatusCheckLock(async () => 'recovered');
      assert(errMsg === 'boom' && recovered === 'recovered', 'queue survives a rejected critical section');

      // Abort-at-turn-start: a queued check whose window/card was deleted before
      // its turn should bail without running and without wedging the queue.
      let ranAborted = false;
      const abErr = await withStatusCheckLock(() => { ranAborted = true; return 'should-not-run'; }, { aborted: true }).catch(e => e.name);
      assert(ranAborted === false, 'an already-aborted queued status check must not run its fn');
      assert(abErr === 'AbortError', `aborted status check rejects with AbortError — got ${abErr}`);
      const afterAbort = await withStatusCheckLock(async () => 'after-abort');
      assert(afterAbort === 'after-abort', 'an aborted status check does not wedge the queue for the next caller');
      return { ok: true, order: order.join(',') };
    },
  },
  {
    name: 'status-check action queue serializes Check All + Check buttons and dedupes rapid same-button clicks',
    run: async () => {
      const order = [];
      let releaseA;
      const aGate = new Promise(r => { releaseA = r; });
      const before = getStatusCheckActionQueueDepth();

      const a = enqueueStatusCheckAction('check-all:marketplacecard:hub-a', async () => {
        order.push('A-card-1');
        await aGate;
        order.push('A-card-2');
        return 'a';
      });
      const duplicateA = enqueueStatusCheckAction('check-all:marketplacecard:hub-a', async () => {
        order.push('A-duplicate');
      });
      const c = enqueueStatusCheckAction('card:marketplace-card-c', async () => {
        order.push('C-single-check');
        return 'c';
      });
      const duplicateC = enqueueStatusCheckAction('card:marketplace-card-c', async () => {
        order.push('C-duplicate');
      });
      const b = enqueueStatusCheckAction('check-all:marketplacecard:hub-b', async () => {
        order.push('B-card-1');
        order.push('B-card-2');
        return 'b';
      });
      const d = enqueueStatusCheckAction('card:marketplace-card-d', async () => {
        order.push('D-single-check');
        return 'd';
      });

      assert(a.enqueued && !duplicateA.enqueued && c.enqueued && !duplicateC.enqueued && b.enqueued && d.enqueued,
        'rapid duplicate Check All / Check clicks are deduped while different actions queue');
      assert(c.queuedBehind === 1, `single Check queues behind the complete Check All batch — got ${c.queuedBehind}`);
      assert(b.queuedBehind === 2 && d.queuedBehind === 3,
        `alternating Check All / Check actions retain FIFO positions — got ${b.queuedBehind}, ${d.queuedBehind}`);
      assert(getStatusCheckActionQueueDepth() === before + 4, 'queue depth counts unique actions only');
      await new Promise(r => setTimeout(r, 0));
      assert(order.join(',') === 'A-card-1', `single Check must not interleave with Check All — got [${order.join(',')}]`);

      releaseA();
      const [aResult, cResult, bResult, dResult] = await Promise.all([a.promise, c.promise, b.promise, d.promise]);
      assert(aResult === 'a' && cResult === 'c' && bResult === 'b' && dResult === 'd', 'each action observes its own result');
      assert(order.join(',') === 'A-card-1,A-card-2,C-single-check,B-card-1,B-card-2,D-single-check',
        `alternating Check All / Check actions run FIFO without interleaving — got [${order.join(',')}]`);
      assert(!order.includes('A-duplicate') && !order.includes('C-duplicate'), 'duplicate action bodies never run');
      assert(getStatusCheckActionQueueDepth() === before, 'action queue depth returns to baseline');

      const failed = enqueueStatusCheckAction('check-all:marketplacecard:hub-fail', async () => { throw new Error('boom'); });
      const recovered = enqueueStatusCheckAction('card:marketplace-card-after-fail', async () => 'recovered');
      const error = await failed.promise.catch(err => err.message);
      assert(error === 'boom' && await recovered.promise === 'recovered', 'failed action does not wedge later buttons');
      assert(getStatusCheckActionQueueDepth() === before, 'action queue drains after rejection path');
      return { ok: true, order: order.join(',') };
    },
  },
  {
    name: 'marketplace browser lock serializes sell-side ops (FIFO, depth, rejection-safe, abort-at-turn-start)',
    run: async () => {
      // A price-check scrape and a captcha-resolve both drive the ONE shared
      // stealth browser; they must not overlap or the resolve's browser-close
      // detaches the scrape's in-flight pages ("Navigating frame was detached").
      // Same FIFO contract as the status-check lock, PLUS: a queued op whose
      // signal is already aborted must bail WITHOUT running fn (a cancelled price
      // check behind a long captcha-resolve shouldn't waste a scrape) and must
      // not wedge the queue for the next caller.
      const order = [];
      let releaseA;
      const aGate = new Promise(r => { releaseA = r; });
      const before = getMarketplaceBrowserQueueDepth();
      const p1 = withMarketplaceBrowserLock(async () => { order.push('A-start'); await aGate; order.push('A-end'); return 'a'; });
      const p2 = withMarketplaceBrowserLock(async () => { order.push('B-start'); return 'b'; });
      assert(getMarketplaceBrowserQueueDepth() === before + 2, `depth counts both pending ops — got ${getMarketplaceBrowserQueueDepth()}`);
      await new Promise(r => setTimeout(r, 0));
      assert(order.join(',') === 'A-start', `B must not start until A settles — got [${order.join(',')}]`);
      releaseA();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert(r1 === 'a' && r2 === 'b', 'each caller observes its own fn result');
      assert(order.join(',') === 'A-start,A-end,B-start', `B runs strictly after A — got [${order.join(',')}]`);
      assert(getMarketplaceBrowserQueueDepth() === before, `depth returns to baseline once settled — got ${getMarketplaceBrowserQueueDepth()}`);

      // A rejection must NOT wedge the queue.
      const errMsg = await withMarketplaceBrowserLock(async () => { throw new Error('boom'); }).catch(e => e.message);
      const recovered = await withMarketplaceBrowserLock(async () => 'recovered');
      assert(errMsg === 'boom' && recovered === 'recovered', 'queue survives a rejected critical section');

      // Abort-at-turn-start: an op whose signal is already aborted when it reaches
      // the head bails (AbortError) WITHOUT running fn; the next op still runs.
      let ranAborted = false;
      const abErr = await withMarketplaceBrowserLock(() => { ranAborted = true; return 'should-not-run'; }, { aborted: true }).catch(e => e.name);
      assert(ranAborted === false, 'an already-aborted queued op must not run its fn');
      assert(abErr === 'AbortError', `aborted op rejects with AbortError — got ${abErr}`);
      const afterAbort = await withMarketplaceBrowserLock(async () => 'after-abort');
      assert(afterAbort === 'after-abort', 'an aborted op does not wedge the queue for the next caller');
      assert(getMarketplaceBrowserQueueDepth() === before, `depth back to baseline after abort path — got ${getMarketplaceBrowserQueueDepth()}`);
      return { ok: true, order: order.join(',') };
    },
  },
  {
    name: 'comp progress aggregator: a source releases its terminal only after the LAST item (bundle)',
    run: () => {
      const events = [];
      const factory = createAggregatingProgress({ totalItems: 2, send: (p) => events.push(p) });
      // Item 0
      const e0 = factory(0);
      e0('ebay-sold', { status: 'searching', count: 0 }); // seeds the spinner
      e0('ebay-sold', { status: 'done', count: 10 });      // NOT the last item → interim
      // Item 1 (last)
      const e1 = factory(1);
      e1('ebay-sold', { status: 'searching', count: 0 });  // swallowed (only item 0 seeds)
      e1('ebay-sold', { status: 'done', count: 5 });        // last → real terminal, summed
      assert(events.length === 3, `expected seed+interim+done = 3 events — got ${events.length}`);
      assert(events[0].status === 'searching' && events[0].count === 0, `first event seeds the spinner — got ${JSON.stringify(events[0])}`);
      assert(events[1].status === 'searching' && events[1].count === 10 && events[1].total === 2,
        `item-0 terminal becomes an interim 'searching' with cumulative count — got ${JSON.stringify(events[1])}`);
      assert(events[2].status === 'done' && events[2].count === 15,
        `last item releases 'done' with the count summed across items — got ${JSON.stringify(events[2])}`);
      return { ok: true };
    },
  },
  {
    name: 'comp progress aggregator: block in any item → terminal error; single item passes straight through',
    run: () => {
      // Bundle: blocked in item 0, fine in item 1 → final terminal is error (sticky warning).
      const ev = [];
      const f = createAggregatingProgress({ totalItems: 2, send: (p) => ev.push(p) });
      const a = f(0);
      a('mercari', { status: 'searching', count: 0 });
      a('mercari', { status: 'error', count: 0, warning: { code: 'anti-bot', severity: 'block' } });
      const b = f(1);
      b('mercari', { status: 'done', count: 7 });
      const fin = ev[ev.length - 1];
      assert(fin.status === 'error', `blocked-in-any-item → terminal error — got ${fin.status}`);
      assert(fin.warning?.code === 'anti-bot', `sticky warning carried to the terminal — got ${JSON.stringify(fin.warning)}`);

      // Single item (totalItems=1): the terminal passes straight through unchanged.
      const ev2 = [];
      const f2 = createAggregatingProgress({ totalItems: 1, send: (p) => ev2.push(p) });
      const s = f2(0);
      s('ebay-sold', { status: 'searching', count: 0 });
      s('ebay-sold', { status: 'done', count: 12, url: 'u' });
      assert(ev2[1].status === 'done' && ev2[1].count === 12 && ev2[1].url === 'u',
        `single-item terminal is unchanged — got ${JSON.stringify(ev2[1])}`);
      return { ok: true };
    },
  },
  {
    name: 'bundlePricing: buildResearchItems (full item shape) orders primary-first + drops empty + threads per-item notes; buildItemQuery strips Unknown + dedups brand/model already in title; computeBundleTotal sums usable prices',
    run: () => {
      // buildItemQuery: explicit search_query/query win; else brand+model+title
      // with "Unknown"/blank tokens stripped (so a query never says "Unknown").
      assert(buildItemQuery({ search_query: 'iPhone XS 256GB', brand: 'X' }) === 'iPhone XS 256GB', 'search_query wins');
      assert(buildItemQuery({ brand: 'Diafield', model: 'Unknown', generated_title: 'Glass Jug' }) === 'Diafield Glass Jug',
        `"Unknown" model dropped — got "${buildItemQuery({ brand: 'Diafield', model: 'Unknown', generated_title: 'Glass Jug' })}"`);
      assert(buildItemQuery({ brand: '', model: '', generated_title: '' }) === '', 'empty item → empty query');
      // Dedup: a brand/model the title already leads with isn't repeated (the
      // "Zippo Zippo Butane Fuel" bug). Title-only when it fully covers them.
      assert(buildItemQuery({ brand: 'Zippo', model: '', generated_title: 'Zippo Butane Fuel, 115ml' }) === 'Zippo Butane Fuel, 115ml',
        `brand already in title not doubled — got "${buildItemQuery({ brand: 'Zippo', model: '', generated_title: 'Zippo Butane Fuel, 115ml' })}"`);
      assert(buildItemQuery({ brand: 'Zippo', model: '65827', generated_title: 'Zippo 65827 Butane Lighter Insert' }) === 'Zippo 65827 Butane Lighter Insert',
        'brand+model already in title → title only (no "Zippo 65827 Zippo 65827 …")');
      // Brand/model NOT in the title are still prepended (a complete query).
      assert(buildItemQuery({ brand: 'Sony', model: 'WH-1000XM4', generated_title: 'Noise Cancelling Headphones' }) === 'Sony WH-1000XM4 Noise Cancelling Headphones',
        'brand+model absent from title are prepended');
      // Word boundary: a brand that only appears as a substring ("Pro" inside
      // "Professional") is NOT treated as already-present.
      assert(buildItemQuery({ brand: 'Pro', model: '', generated_title: 'Professional Mixer' }) === 'Pro Professional Mixer',
        'substring-only brand still prepended (word-boundary dedup)');

      const product = { search_query: 'Apple iPhone XS 256GB', generated_title: 'iPhone XS', condition: 'Used - Good' };
      const extras = [
        // Full item shape now (title/brand/model/condition/notes), like the primary.
        { id: 'a', generated_title: 'Otterbox Defender case', brand: 'Otterbox', model: 'Unknown', condition: 'New', pricingNotes: 'sealed in box' },
        { id: 'b', generated_title: '', brand: '', model: '' },         // nothing to search → dropped
        { id: 'c', generated_title: 'screen protector' },               // no condition → inherits primary
      ];
      const items = buildResearchItems(product, extras, 'cracked back glass');
      assert(items.length === 3, `1 primary + 2 searchable extras — got ${items.length}`);
      assert(items[0].key === 'primary' && items[0].query === 'Apple iPhone XS 256GB',
        `primary first, query from search_query — got ${JSON.stringify(items[0])}`);
      assert(items[0].pricingNotes === 'cracked back glass', `primary carries the hub-level notes — got ${JSON.stringify(items[0].pricingNotes)}`);
      assert(items[1].query === 'Otterbox Defender case' && items[1].condition === 'New',
        `extra query dedups the brand the title already leads with (Unknown model dropped) + keeps its own condition — got ${JSON.stringify(items[1])}`);
      assert(items[1].label === 'Otterbox Defender case', `extra label = its title — got ${JSON.stringify(items[1].label)}`);
      assert(items[1].pricingNotes === 'sealed in box', `extra carries its OWN notes (not the primary's) — got ${JSON.stringify(items[1].pricingNotes)}`);
      assert(items[2].condition === 'Used - Good', `extra without condition inherits the primary's — got ${items[2].condition}`);
      assert(items[2].pricingNotes === '', `extra without notes → empty string, not the primary's — got ${JSON.stringify(items[2].pricingNotes)}`);

      const recoveredRefreshItems = buildRefreshResearchItems(product, [], [
        { key: 'primary', label: 'iPhone XS', query: 'Apple iPhone XS 256GB', condition: 'Used - Good' },
        { key: 'legacy-case', label: 'Otterbox Defender case', query: 'Otterbox Defender case', condition: 'New', pricingNotes: 'sealed' },
      ], 'cracked back glass');
      assert(recoveredRefreshItems.length === 2 && recoveredRefreshItems[1].query === 'Otterbox Defender case',
        `Refresh Prices recovers legacy saved bundle items when extraItems are missing — got ${JSON.stringify(recoveredRefreshItems)}`);
      const explicitRefreshItems = buildRefreshResearchItems(product, extras, [
        { key: 'primary', query: 'stale primary' },
        { key: 'stale-extra', query: 'stale extra' },
      ], 'cracked back glass');
      assert(explicitRefreshItems[1].key === 'a' && explicitRefreshItems[1].query === 'Otterbox Defender case',
        'Refresh Prices prefers current editable extraItems over stale saved itemPricings');

      assert(buildFinalListingTitle(product, null) === 'iPhone XS',
        'single-item final title remains the primary item name');
      assert(buildFinalListingTitle(product, [
        { key: 'primary', label: 'iPhone XS', query: 'Apple iPhone XS 256GB' },
        { key: 'case', label: 'Otterbox Defender case', query: 'Otterbox Defender case' },
        { key: 'protector', label: 'screen protector', query: 'screen protector' },
      ]) === 'iPhone XS + Otterbox Defender case + screen protector',
      'bundle final title joins every individual item name in order');
      assert(buildFinalListingTitle(product, [
        { key: 'primary', label: 'iPhone XS' },
        { key: 'legacy', query: 'legacy charger' },
        { key: 'blank' },
      ]) === 'iPhone XS + legacy charger + Item 3',
      'bundle final title still represents legacy items whose saved labels are missing');

      assert(computeBundleTotal([
        { pricing: { recommended_price: 300 } },
        { pricing: { recommended_price: 25 } },
        { pricing: { recommended_price: null } }, // skipped
        { pricing: { recommended_price: 0 } },    // unusable price, skipped
        { pricing: { recommended_price: -10 } },  // invalid price, skipped
        { pricing: { recommended_price: 0.001 } }, // displays as $0.00, skipped
      ]) === 325, 'bundle total sums positive recommended prices');
      assert(computeBundleTotal([
        { pricing: { recommended_price: 10.005 } },
        { pricing: { recommended_price: 10.005 } },
      ]) === 20.02, 'bundle total sums the same cent-rounded item prices shown to the user');
      assert(computeBundleTotal([{ pricing: { recommended_price: null } }]) === null, 'all-null bundle total → null (so UI can hide it)');
      assert(computeBundleTotal([{ pricing: { recommended_price: 0.001 } }]) === null, 'sub-cent-only bundle total → null instead of visible $0');
      return { ok: true };
    },
  },
  {
    name: 'bundlePricing: selectBundleHeadline prefers the AI synergy price, falls back to the sum, flags the reference line',
    run: () => {
      // AI moved the price above the sum (synergy premium) → headline = AI price,
      // show the "sum if sold separately" reference line.
      const premium = selectBundleHeadline({ bundle_price: 360, synergy: 'premium' }, 325);
      assert(premium.headline === 360 && premium.aiPrice === 360, `AI price is the headline — got ${JSON.stringify(premium)}`);
      assert(premium.showSumRef === true, 'AI price ≠ sum → show the sum reference line');
      assert(premium.synergy === 'premium', `synergy passed through — got ${premium.synergy}`);

      // No AI result → fall back to the arithmetic sum, no reference line.
      const fallback = selectBundleHeadline(null, 325);
      assert(fallback.headline === 325 && fallback.aiPrice === null, `null bundlePricing → sum headline — got ${JSON.stringify(fallback)}`);
      assert(fallback.showSumRef === false, 'no AI price → no separate reference line');

      // AI agreed with the sum exactly → headline = AI price but NO redundant ref line.
      const equal = selectBundleHeadline({ bundle_price: 325, synergy: 'neutral' }, 325);
      assert(equal.headline === 325 && equal.showSumRef === false, `AI == sum → single line — got ${JSON.stringify(equal)}`);

      // Both missing → null headline (UI shows "—").
      assert(selectBundleHeadline(null, null).headline === null, 'no data → null headline');
      assert(selectBundleHeadline({ bundle_price: -10 }, 325).headline === 325,
        'invalid non-positive bundle price falls back to the separate-item sum');
      assert(selectBundleHeadline({ bundle_price: -10, synergy: 'discount' }, 325).synergy === null,
        'invalid bundle result cannot leak a stale synergy label onto the fallback sum');
      return { ok: true };
    },
  },
  {
    name: 'bundlePricing: numeric relationship corrects contradictory synergy labels and explanations',
    run: () => {
      assert(bundleSynergyForPrices(49, 51.48) === 'discount', 'price below separate sum must be a discount');
      assert(bundleSynergyForPrices(54, 51.48) === 'premium', 'price above separate sum must be a premium');
      assert(bundleSynergyForPrices(51.48, 51.48) === 'neutral', 'price equal to separate sum must be neutral');

      const contradictory = {
        quick_sell_price: 44,
        bundle_price: 49,
        max_profit_price: 54,
        synergy: 'premium',
        justification: 'This bundle commands a premium over the individual sum.',
      };
      const corrected = normalizeBundlePricingResult(contradictory, 51.48, 3);
      assert(corrected.synergy === 'discount', `contradictory premium corrected to discount — got ${corrected.synergy}`);
      assert(corrected.justification.includes('$2.48') && corrected.justification.includes('below the $51.48'),
        `corrected explanation states the actual delta — got ${corrected.justification}`);
      assert(!corrected.justification.toLowerCase().includes('premium'),
        `contradictory premium prose is discarded — got ${corrected.justification}`);
      assert(corrected.justification.includes('$44') && corrected.justification.includes('$54'),
        'corrected explanation retains the quick/max tradeoff');

      const consistent = { ...contradictory, synergy: 'discount', justification: 'Purpose-built set offered below separate value.' };
      assert(normalizeBundlePricingResult(consistent, 51.48, 3) === consistent,
        'consistent model response is preserved unchanged');

      const correctLabelBadProse = { ...contradictory, synergy: 'discount' };
      const correctedProse = normalizeBundlePricingResult(correctLabelBadProse, 51.48, 3);
      assert(correctedProse.synergy === 'discount' && !correctedProse.justification.toLowerCase().includes('premium'),
        'contradictory explanation is corrected even when the categorical label was already right');

      const factorDerived = deriveBundlePricingResult({
        bundle_factors: [
          { direction: 'premium', percent: 8, reason: 'Convenience supports a modest premium.' },
          { direction: 'discount', percent: 13, reason: 'The forced bundle warrants a discount.' },
        ],
        quick_sell_factors: [],
        max_profit_factors: [],
      }, 100, 2);
      assert(normalizeBundlePricingResult(factorDerived, 100, 2) === factorDerived,
        'legacy prose correction preserves valid mixed factor explanations');
      return { ok: true };
    },
  },
  {
    name: 'bundlePricing: attributable AI factors deterministically derive synchronized bundle prices and explanation',
    run: () => {
      const result = deriveBundlePricingResult({
        bundle_factors: [
          { direction: 'premium', percent: 8, reason: 'The items form a complete ready-to-use system.' },
          { direction: 'discount', percent: 13, reason: 'A buyer must take all three items in one purchase.' },
        ],
        quick_sell_factors: [{ percent: 10, reason: 'The complete set has a focused buyer pool.' }],
        max_profit_factors: [{ percent: 10, reason: 'A patient seller can wait for a buyer seeking the complete set.' }],
      }, 51.48, 3);

      assert(result.bundle_price === 49 && result.quick_sell_price === 44 && result.max_profit_price === 54,
        `structured factors derive expected whole-dollar tiers — got ${JSON.stringify(result)}`);
      assert(result.synergy === 'discount' && result.bundle_adjustment_percent === -5,
        `relationship and signed adjustment derive by summing factors — got ${JSON.stringify(result)}`);
      assert(result.justification.includes('$2.48') && result.justification.includes('below the $51.48'),
        `exact arithmetic explanation derives from the resulting price — got ${result.justification}`);
      assert(result.justification.includes('+8%: The items form a complete ready-to-use system.')
          && result.justification.includes('-13%: A buyer must take all three items in one purchase.')
          && result.justification.includes('Net bundle adjustment: -5%'),
        `every bundle factor and the resulting net are explicit — got ${result.justification}`);

      const neutral = deriveBundlePricingResult({
        bundle_factors: [
          { direction: 'premium', percent: 8, reason: 'The items are convenient together.' },
          { direction: 'discount', percent: 8, reason: 'A buyer must take the full set.' },
        ],
        quick_sell_factors: [],
        max_profit_factors: [],
      }, 51.48, 2);
      assert(neutral.bundle_price === 51.48 && neutral.synergy === 'neutral' && neutral.bundle_adjustment_percent === 0,
        `offsetting factors derive a neutral result and preserve the sum — got ${JSON.stringify(neutral)}`);

      const malformed = deriveBundlePricingResult({
        bundle_factors: [],
        quick_sell_factors: [{ percent: 500, reason: 'Extremely narrow buyer pool.' }],
        max_profit_factors: [{ percent: 500, reason: 'A patient seller may test demand.' }],
      }, 8, 2);
      assert(malformed.bundle_price === 8 && malformed.synergy === 'neutral',
        `empty bundle factors preserve a neutral Best price — got ${JSON.stringify(malformed)}`);
      assert(malformed.quick_sell_price === 2 && malformed.max_profit_price === 16,
        `malformed tier percentages are bounded and low-value prices retain cents/scale — got ${JSON.stringify(malformed)}`);
      assert(malformed.factor_caps_applied?.quick && malformed.factor_caps_applied?.max,
        `applied factor caps are explicit — got ${JSON.stringify(malformed.factor_caps_applied)}`);

      const tinyLowValueAdjustment = deriveBundlePricingResult({
        bundle_factors: [{ direction: 'premium', percent: 0.01, reason: 'The paired items add slight convenience.' }],
        quick_sell_factors: [],
        max_profit_factors: [],
      }, 8, 2);
      assert(tinyLowValueAdjustment.bundle_price === 8.01,
        `tiny low-value adjustments move one cent instead of a whole dollar — got ${JSON.stringify(tinyLowValueAdjustment)}`);

      const tinyNormalValueAdjustment = deriveBundlePricingResult({
        bundle_factors: [{ direction: 'premium', percent: 0.01, reason: 'The paired items add slight convenience.' }],
        quick_sell_factors: [{ percent: 0.01, reason: 'A slight reduction improves liquidity.' }],
        max_profit_factors: [{ percent: 0.01, reason: 'A slight increase tests patient demand.' }],
      }, 10, 2);
      assert(tinyNormalValueAdjustment.bundle_price === 10.01
          && tinyNormalValueAdjustment.quick_sell_price === 10
          && tinyNormalValueAdjustment.max_profit_price === 10.02,
      `tiny factors move each tier by cents instead of becoming whole-dollar jumps or no-ops — got ${JSON.stringify(tinyNormalValueAdjustment)}`);

      const invalidOnlyFactor = deriveBundlePricingResult({
        bundle_factors: [{ direction: 'premium', percent: 20, reason: 'The bundle deserves a discount because buyers must take everything.' }],
        quick_sell_factors: [],
        max_profit_factors: [],
      }, 100, 2);
      assert(invalidOnlyFactor === null,
        'a response containing only contradictory factors is rejected instead of silently becoming neutral');
      const partiallyInvalidFactors = deriveBundlePricingResult({
        bundle_factors: [
          { direction: 'premium', percent: 20, reason: 'The items form a complete useful set.' },
          { direction: 'discount', percent: 30, reason: 'This bundle commands a premium.' },
        ],
        quick_sell_factors: [],
        max_profit_factors: [],
      }, 100, 2);
      assert(partiallyInvalidFactors === null,
        'a partially invalid factor list is rejected instead of pricing from a biased valid subset');
      const tooManyFactors = deriveBundlePricingResult({
        bundle_factors: Array.from({ length: 9 }, (_, index) => ({
          direction: index === 8 ? 'discount' : 'premium',
          percent: index === 8 ? 40 : 5,
          reason: index === 8 ? 'The buyer must take all items.' : `Convenience factor ${index + 1}.`,
        })),
        quick_sell_factors: [],
        max_profit_factors: [],
      }, 100, 2);
      assert(tooManyFactors === null,
        'an over-limit factor list is rejected instead of dropping factors that may reverse the net');
      assert(deriveBundlePricingResult({
        bundle_factors: [{ direction: 'discount', percent: 1, reason: 'Buyer must take both items.' }],
        quick_sell_factors: [],
        max_profit_factors: [],
      }, 0.01, 2) === null,
      'a factor response that would round the positive bundle price to zero is rejected');
      assert(deriveBundlePricingResult({
        bundle_factors: [],
        quick_sell_factors: [{ percent: 75, reason: 'Extremely limited liquidity.' }],
        max_profit_factors: [],
      }, 0.01, 2) === null,
      'a tier factor response that would round Quick to zero is rejected');
      assert(deriveBundlePricingResult({ bundle_factors: [] }, 100, 2) === null,
        'structurally incomplete factor response is rejected instead of silently becoming neutral');
      assert(deriveBundlePricingResult({ bundle_factors: [], quick_sell_factors: [], max_profit_factors: [] }, 0, 2) === null,
        'non-positive separate value cannot produce a fabricated bundle factor price');
      return { ok: true };
    },
  },
  {
    name: 'bundlePricing: result tiers are whole-bundle quick/best/max, with old-result fallback',
    run: () => {
      const itemPricings = [
        { pricing: { quick_sell_price: 18, recommended_price: 22, max_profit_price: 28 } },
        { pricing: { quick_sell_price: 15, recommended_price: 19, max_profit_price: 24 } },
      ];

      const explicit = selectListingPriceTiers({
        pricing: itemPricings[0].pricing,
        itemPricings,
        bundleTotal: 41,
        bundlePricing: { quick_sell_price: 38, bundle_price: 45, max_profit_price: 55 },
      });
      assert(explicit.isBundle === true, '2+ item prices produce bundle-level result tiers');
      assert(explicit.quick === 38 && explicit.best === 45 && explicit.max === 55,
        `explicit AI bundle tiers win over the primary item — got ${JSON.stringify(explicit)}`);

      // Old saved bundle results only have bundle_price. Scale the sums of the
      // individual quick/max tiers by the same 45/41 bundle adjustment.
      const legacy = selectListingPriceTiers({
        pricing: itemPricings[0].pricing,
        itemPricings,
        bundleTotal: 41,
        bundlePricing: { bundle_price: 45 },
      });
      assert(legacy.quick === 36 && legacy.best === 45 && legacy.max === 57,
        `legacy bundle result derives whole-listing tiers — got ${JSON.stringify(legacy)}`);

      const malformedLegacy = selectListingPriceTiers({
        pricing: itemPricings[0].pricing,
        itemPricings,
        bundleTotal: 41,
        bundlePricing: { quick_sell_price: 1, bundle_price: -10, max_profit_price: 2 },
      });
      assert(malformedLegacy.quick === 33 && malformedLegacy.best === 41 && malformedLegacy.max === 52,
        `invalid legacy Best rejects its stale explicit tiers and falls back consistently — got ${JSON.stringify(malformedLegacy)}`);

      const single = selectListingPriceTiers({ pricing: itemPricings[0].pricing });
      assert(single.isBundle === false && single.quick === 18 && single.best === 22 && single.max === 28,
        `single listing keeps its own tiers — got ${JSON.stringify(single)}`);
      const invalidSingle = selectListingPriceTiers({
        pricing: { quick_sell_price: -1, recommended_price: 0.001, max_profit_price: 0 },
      });
      assert(invalidSingle.quick === null && invalidSingle.best === null && invalidSingle.max === null,
        `single listing rejects prices that cannot display as positive currency — got ${JSON.stringify(invalidSingle)}`);
      return { ok: true };
    },
  },
  {
    name: 'browser pool: captcha resolve pause holds queued scrapes until released',
    run: async () => {
      const release = pauseBrowserPool('test-captcha-resolve');
      const controller = new AbortController();
      const queued = queueScrape(
        'https://example.com/browser-pool-pause-test',
        '() => []',
        { signal: controller.signal, sourceLabel: 'browser-pool-pause-test', timeoutMs: 1000 },
      ).then(
        () => 'resolved',
        (err) => err?.message || String(err),
      );

      let released = false;
      try {
        await new Promise(r => setTimeout(r, 0));
        let state = getBrowserPoolQueueState();
        assert(state.paused, 'queue is paused while captcha resolve owns the shared profile');
        assert(state.pauseDepth >= 1, `pause depth recorded (got ${state.pauseDepth})`);
        assert(state.pauseReasons.includes('test-captcha-resolve'), `pause reason recorded (${state.pauseReasons.join(',')})`);
        assert(state.queued >= 1, `scrape stays queued while paused (queued=${state.queued})`);
        assert(state.active === 0, `paused scrape must not become active (active=${state.active})`);

        controller.abort();
        const result = await queued;
        assert(result === 'Aborted', `queued scrape aborts cleanly while paused (got ${result})`);

        release();
        released = true;
        state = getBrowserPoolQueueState();
        assert(!state.paused, 'queue resumes after the captcha resolve pause is released');
        return { ok: true };
      } finally {
        controller.abort();
        await queued.catch(() => {});
        if (!released) release();
      }
    },
  },
  {
    name: 'job run staging: per-page ledger + resumable detection + cleanup',
    run: async () => {
      const dir = path.join(os.tmpdir(), `ic-jobstaging-${process.pid}`);
      fs.mkdirSync(dir, { recursive: true });
      const canvas = path.join(dir, 'test-canvas.json');
      const T0 = 1_000_000;   // fixed clock (test runner forbids Date.now())
      try {
        await startRun(canvas, { runId: 'r1', startedAt: T0, queries: ['swe'], sourceIds: ['indeed', 'google'] });
        await recordSourcePage(canvas, { sourceId: 'indeed', query: 'swe', page: 0, jobs: [{ title: 'A' }, { title: 'B' }], now: T0 + 1 });
        await recordSourcePage(canvas, { sourceId: 'indeed', query: 'swe', page: 1, jobs: [{ title: 'C' }], now: T0 + 2 });
        await markSourceStatus(canvas, 'indeed', 'done', T0 + 3);

        const staged = await readStagedJobs(canvas);
        assert(staged.length === 3 && staged[0].job.title === 'A' && staged[2].page === 1, `staged rows recovered (${staged.length})`);

        // recent + incomplete (stage still 'searching') → resumable, with ledger
        const st = await readRunState(canvas, T0 + 100);
        assert(st && st.incomplete && st.resumable, 'recent incomplete run is resumable');
        assert(st.manifest.sources.indeed.status === 'done', 'indeed marked done');
        assert(st.manifest.sources.indeed.queries.swe.lastPage === 1, 'indeed lastPage ledger = 1');
        assert(st.stagedJobs.length === 3, 'run state carries staged jobs');

        // older than the 24h window → still incomplete but NOT auto-resumable
        const stale = await readRunState(canvas, T0 + RESUMABLE_MAX_AGE_MS + 5);
        assert(stale.incomplete && !stale.resumable, 'stale run is not auto-resumable');

        // finished → not incomplete; clearRun removes both sidecars
        await setStage(canvas, 'done', T0 + 200);
        const done = await readRunState(canvas, T0 + 300);
        assert(done && !done.incomplete && !done.resumable, 'done run is not resumable');
        await clearRun(canvas);
        assert((await readRunState(canvas, T0 + 400)) === null, 'cleared run → null state');

        return { ok: true, staged: staged.length };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    // Regression: the per-source completion loop in jobs.js fires one
    // markSourceStatus per source WITHOUT awaiting — all concurrent. Before the
    // per-path mutex + unique tmp name, every write shared `<manifest>.<pid>.tmp`
    // so the first rename() won and the rest hit ENOENT (lost write), and stale
    // read-modify-write clobbered every source's status but the last. Fire many
    // concurrent writers and assert ALL land and `stage` is not reverted.
    name: 'job run staging: concurrent writers do not clobber or ENOENT',
    run: async () => {
      const dir = path.join(os.tmpdir(), `ic-jobstaging-conc-${process.pid}`);
      fs.mkdirSync(dir, { recursive: true });
      const canvas = path.join(dir, 'test-canvas.json');
      const T0 = 2_000_000;
      const sources = ['indeed', 'google', 'linkedin', 'remoteok', 'dice', 'glassdoor', 'ziprecruiter', 'weworkremotely', 'usajobs'];
      try {
        await startRun(canvas, { runId: 'rc', startedAt: T0, queries: ['swe'], sourceIds: sources });
        // All concurrent, no inter-await — exactly the jobs.js completion loop.
        await Promise.all([
          ...sources.map((s, i) => markSourceStatus(canvas, s, 'done', T0 + i + 1)),
          setStage(canvas, 'gathered', T0 + 100), // races the status writes
        ]);
        const st = await readRunState(canvas, T0 + 200);
        assert(st && st.manifest, 'manifest survived concurrent writes');
        const missing = sources.filter(s => st.manifest.sources[s]?.status !== 'done');
        assert(missing.length === 0, `every source persisted 'done' (missing: ${missing.join(',') || 'none'})`);
        assert(st.manifest.stage === 'gathered', `stage not reverted by a stale write (got '${st.manifest.stage}')`);
        return { ok: true, sources: sources.length };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'getNodesBounds: AABB over node dims (shared by copy/paste/extract/fit-view)',
    run: () => {
      const nodes = [
        { type: 'text', position: { x: 0, y: 0 } },           // 180x36
        { type: 'jobhub', position: { x: 500, y: 200 } },     // 280x350
        { type: 'text', position: { x: -100, y: -50 }, width: 60, height: 20 },
      ];
      const b = getNodesBounds(nodes);
      assert(b.minX === -100 && b.minY === -50, `min corner (got ${b.minX},${b.minY})`);
      assert(b.maxX === 780 && b.maxY === 550, `max corner = jobhub br (got ${b.maxX},${b.maxY})`);
      const empty = getNodesBounds([]);
      assert(empty.minX === Infinity && empty.maxX === -Infinity, 'empty set → Infinity sentinels');

      // Zoom-to-fit must fit only VISIBLE nodes: a hidden node at a stale far
      // position (collapsed job card) shouldn't stretch the box. The fit-view
      // hook filters `!n.hidden` before calling this; verify that excludes it.
      const withHidden = [
        ...nodes,
        { type: 'jobcard', position: { x: 5000, y: 5000 }, hidden: true }, // stale, far away
      ];
      const visibleOnly = getNodesBounds(withHidden.filter(n => !n.hidden));
      assert(visibleOnly.maxX === 780 && visibleOnly.maxY === 550, `visible-only bounds ignore hidden outlier (got ${visibleOnly.maxX},${visibleOnly.maxY})`);
      assert(getNodesBounds(withHidden).maxX === 5180, 'sanity: unfiltered DOES include the hidden outlier');
      return { ok: true, b };
    },
  },
  {
    name: 'getNodeDims: normalizes CSS pixel dimensions and rejects non-absolute values',
    run: () => {
      const cssPixels = getNodeDims({
        type: 'group',
        style: { width: '240px', height: '180' },
      });
      assert(cssPixels.w === 240 && cssPixels.h === 180, `pixel strings normalize to numbers (${JSON.stringify(cssPixels)})`);

      const nonAbsolute = getNodeDims({
        type: 'text',
        width: Number.NaN,
        measured: { width: 0, height: -1 },
        style: { width: '100%', height: 'auto' },
      });
      assert(nonAbsolute.w === 180 && nonAbsolute.h === 36, `invalid dimensions fall back by type (${JSON.stringify(nonAbsolute)})`);
      return { ok: true };
    },
  },
  {
    name: 'strokePoints: normalizes object/array/garbage strokes',
    run: () => {
      const arr = [{ x: 1, y: 2 }];
      assert(strokePoints(arr) === arr, 'bare array passes through');
      assert(strokePoints({ points: arr }) === arr, 'object → its points');
      assert(Array.isArray(strokePoints(null)) && strokePoints(null).length === 0, 'null → []');
      assert(strokePoints({ color: 'red' }).length === 0, 'object without points → []');
      return { ok: true };
    },
  },
  {
    name: 'marketplace retry merge: only clean non-empty retries clear a blocked source',
    run: () => {
      const prev = {
        sold: [{ source: 'ebay-sold', price: 1 }, { source: 'mercari', price: 2 }],
        active: [{ source: 'ebay-active', price: 3 }],
      };
      const merged = mergeSourceIntoComps(prev, {
        sourceId: 'ebay-sold', category: 'sold',
        items: [{ source: 'ebay-sold', price: 9 }],
      });
      // ebay-sold replaced, mercari kept, active carried through untouched
      assert(merged.sold.length === 2, `sold count (got ${merged.sold.length})`);
      assert(merged.sold.find(i => i.source === 'ebay-sold').price === 9, 'ebay-sold replaced with fresh item');
      assert(merged.sold.some(i => i.source === 'mercari'), 'other-source sold item retained');
      assert(merged.active === prev.active, 'untouched bucket carried through by reference');
      // missing/empty inputs are safe
      const fromNull = mergeSourceIntoComps(null, { sourceId: 's', items: [{ source: 's' }] });
      assert(fromNull.sold.length === 1 && fromNull.active.length === 0, 'null prev → seeded comps');
      const warnings = [{ sourceId: 'ebay-sold', code: 'scrape-timeout' }, { sourceId: 'poshmark', code: 'stale-selectors' }];
      const stillBlocked = updateResolvedSourceWarning(warnings, 'ebay-sold', { code: 'task-failed', severity: 'block' });
      assert(stillBlocked.length === 2 && stillBlocked.some(w => w.sourceId === 'ebay-sold' && w.code === 'task-failed'),
        'partial retry replaces the source warning instead of clearing it');
      const clean = updateResolvedSourceWarning(stillBlocked, 'ebay-sold', null);
      assert(clean.length === 1 && clean[0].sourceId === 'poshmark', 'clean retry clears only that source warning');
      const lowYield = { code: 'zero-extracted', severity: 'throttle' };
      assert(retryWarningRequiringAction(lowYield, [{ source: 'ebay-sold' }]) === lowYield,
        'partial data with any warning remains blocked until clean retry or explicit Skip');
      assert(retryWarningRequiringAction(null, [{ source: 'ebay-sold' }]) === null,
        'clean non-empty retry clears the blocked source');
      assert(retryWarningRequiringAction(lowYield, []) === lowYield,
        'zero-item low-yield retry should remain actionable');
      const silentEmpty = retryWarningRequiringAction(null, []);
      assert(silentEmpty?.severity === 'block' && silentEmpty?.code === 'retry-empty',
        'zero-item retry without a source warning must remain blocked until explicit Skip');
      const hardBlock = { code: 'captcha', severity: 'block' };
      assert(retryWarningRequiringAction(hardBlock, [{ source: 'ebay-sold' }]) === hardBlock,
        'hard blocks remain actionable even if partial items were recovered');
      // noChallengeConfirmed: a Solve that proved there was no challenge clears the
      // gate regardless of count — breaks the eBay "1 result" unclearable loop.
      assert(retryWarningRequiringAction(null, [], { noChallengeConfirmed: true }) === null,
        'no-challenge-confirmed empty retry clears the gate (no unclearable Solve loop)');
      assert(retryWarningRequiringAction(lowYield, [], { noChallengeConfirmed: true }) === null,
        'no-challenge-confirmed accepts the page even with a residual low-yield warning');
      // A BLOCK-severity timeout (e.g. swappa-sold's readiness-loop timeout on a
      // genuine 0-results page) ALSO clears under noChallengeConfirmed — this is
      // what lets a multi-item bundle whose source is truly empty finish instead
      // of stranding in error/retry-empty (the "swappa/ebay unable to finish" bug).
      assert(retryWarningRequiringAction(hardBlock, [], { noChallengeConfirmed: true }) === null,
        'no-challenge-confirmed clears even a block-severity empty (bundle truly-empty source can finish)');
      assert(retryWarningRequiringAction(lowYield, []) === lowYield,
        'WITHOUT the no-challenge proof, an empty low-yield retry still stays blocked');
      assert(retryWarningRequiringAction(hardBlock, []) === hardBlock,
        'WITHOUT the no-challenge proof, a block-severity empty retry still stays blocked');
      return { ok: true };
    },
  },
  {
    name: 'buildScoredJob: matched merge vs placeholder fallbacks (shared real-time/batch shape)',
    run: () => {
      const job = { title: 'X', company: 'Y' };
      const matched = buildScoredJob(job, { matchScore: 80, careerDirection: 'Eng' }, { fallbackScore: 50, allNull: false });
      assert(matched.matchScore === 80 && matched.careerDirection === 'Eng' && matched.title === 'X', 'matched: score fields spread onto the job');
      const lone = buildScoredJob(job, null, { fallbackScore: 50, allNull: false });
      assert(lone.matchScore === 50 && lone.reasoning === 'Unable to score' && lone.careerDirection === 'Other', 'lone miss → Unable to score');
      const dead = buildScoredJob(job, null, { fallbackScore: 50, allNull: true });
      assert(dead.reasoning === 'AI format error', 'whole-batch miss → AI format error');
      return { ok: true };
    },
  },
  {
    // Regression: a present-but-fully-unmatched scores array (empty, or all
    // indices out of range) must report 'AI format error' + a failedBatch,
    // identically to the real-time path (results.every(r=>!r)) — not the
    // softer 'Unable to score'/0 the old `allNull = !scores` produced.
    name: 'Batch reconcile: empty/out-of-range scores array == whole-batch failure (lockstep with live path)',
    run: () => {
      const batch = [{ id: 'a' }, { id: 'b' }];
      const empty = reconcileBatchScores([batch], { b0: { scores: [] } }, { fallbackScore: 50 });
      assert(empty.failedBatches === 1, `empty scores array → failedBatches=1 (got ${empty.failedBatches})`);
      assert(empty.scoredJobs.every(j => j.reasoning === 'AI format error'), 'empty scores → AI format error');
      const oob = reconcileBatchScores([batch], { b0: { scores: [{ index: 5, matchScore: 9 }, { index: 6, matchScore: 8 }] } }, { fallbackScore: 50 });
      assert(oob.failedBatches === 1, `all-out-of-range indices → failedBatches=1 (got ${oob.failedBatches})`);
      assert(oob.scoredJobs.every(j => j.reasoning === 'AI format error'), 'out-of-range → AI format error');
      // A partially-matched batch is NOT a whole-batch failure: the unmatched job
      // gets the lone-miss 'Unable to score', and the batch is not counted failed.
      const partial = reconcileBatchScores([batch], { b0: { scores: [{ index: 0, matchScore: 80, careerDirection: 'Eng' }] } }, { fallbackScore: 50 });
      assert(partial.failedBatches === 0, `partial match → failedBatches=0 (got ${partial.failedBatches})`);
      assert(partial.scoredJobs.find(j => j.id === 'b').reasoning === 'Unable to score', 'lone miss in good batch → Unable to score');
      return { ok: true, empty: empty.failedBatches, oob: oob.failedBatches, partial: partial.failedBatches };
    },
  },
  {
    // Regression: LinkedIn's oldest-bucket literal "30+ days ago" must parse so
    // a tight max-age filter actually drops it (the unparsed-null path kept it).
    name: 'parsePostedDate: "30+ days ago" parses; bare number does not fabricate a date',
    run: () => {
      const plus = parsePostedDate('30+ days ago');
      assert(plus instanceof Date, '"30+ days ago" should parse to a Date');
      const ageDays = Math.round((Date.now() - plus.getTime()) / 86400000);
      assert(ageDays === 30, `"30+ days ago" ≈ 30 days old (got ${ageDays})`);
      const kept = filterJobsByAge([{ posted: '30+ days ago', id: 'stale' }, { posted: '3 days ago', id: 'fresh' }], 7).map(j => j.id);
      assert(kept.length === 1 && kept[0] === 'fresh', `7-day filter drops "30+ days ago" (kept ${JSON.stringify(kept)})`);
      // Bare numeric strings are not dates — must NOT be parsed as a year/month.
      assert(parsePostedDate('2024') === null, 'bare "2024" → null (not a fabricated date)');
      assert(parsePostedDate('5') === null, 'bare "5" → null');
      // Normal relative strings still parse.
      assert(parsePostedDate('3 days ago') instanceof Date, '"3 days ago" still parses');
      return { ok: true, ageDays };
    },
  },
  {
    // Regression: the prose-recovery fallback must not silently return a stray
    // empty literal ("[ ]") scraped from prose when the real value didn't parse —
    // that masked failures and violated the fail-loud contract.
    name: 'parseGeminiJSON: stray empty "[ ]" in prose does not silently win → throws',
    run: () => {
      const raw = 'Use { } for objects and [ ] for arrays. Result: {"score": 9}';
      let threw = false;
      try { parseGeminiJSON(raw); } catch { threw = true; }
      assert(threw, 'prose with a stray "[ ]" + unparseable brace span must throw, not return []');
      // Sanity: a clean object after prose still recovers (no regression).
      assert(parseGeminiJSON('Here is the answer: {"score": 9}').score === 9, 'object-after-prose still recovers');
      // A genuine empty array as the whole clean response still parses to [].
      assert(Array.isArray(parseGeminiJSON('[]')) && parseGeminiJSON('[]').length === 0, 'clean "[]" still parses to []');
      return { ok: true };
    },
  },
  {
    // A page where the SITE ITSELF says "0 results" is genuinely empty, NOT a
    // block. matchesNoResultsSentinel must fire on real empty-states and stay
    // SILENT on populated pages (a false match would suppress a real warning).
    name: 'matchesNoResultsSentinel: fires on real empty-states, silent on populated/incidental pages',
    run: () => {
      // The actual Swappa empty page from the bug report.
      const swappaEmpty = '<h1>Search</h1><p>Showing <b>0</b> results for <b>Yamaha A3R ARE acoustic electric guitar</b></p><div class="well"><h2>No products match this criteria...</h2></div>';
      assert(matchesNoResultsSentinel(swappaEmpty), 'Swappa "No products match this criteria" / "Showing 0 results" → empty');
      // innerText form (no tags) — what the captcha-resolve probe sees.
      assert(matchesNoResultsSentinel('Search Showing 0 results for Yamaha A3R ARE acoustic electric guitar'), 'innerText "Showing 0 results" → empty');
      assert(matchesNoResultsSentinel('We couldn\'t find any listings matching your search.'), '"couldn\'t find any" → empty');
      assert(matchesNoResultsSentinel('0 results found'), '"0 results found" → empty');
      assert(matchesNoResultsSentinel('No listings found for this search'), '"no listings found" → empty');
      assert(matchesNoResultsSentinel('Your search did not match any documents.'), '"your search did not match any" → empty');
      // eBay's genuine-empty SRP — the exact markup + innerText from the bug report.
      // Previously missed: "0 results for" (no trailing found/match) and "No exact
      // matches found" (word between no+matches) → Solve window held the full 30s.
      const ebayEmptyHtml = '<h1 class="srp-controls__count-heading"><span class="BOLD">0</span> results for <span class="BOLD">iygiuygf</span></h1><div class="srp-save-null-search__title"><h3 class="srp-save-null-search__heading">No exact matches found</h3></div>';
      assert(matchesNoResultsSentinel(ebayEmptyHtml), 'eBay "No exact matches found" null-search (HTML) → empty');
      assert(matchesNoResultsSentinel('0 results for iygiuygf No exact matches found Save this search'), 'eBay empty innerText ("0 results for" + "No exact matches found") → empty');
      // ADVERSARIAL NEGATIVES — must NOT match (these would hide a real warning):
      assert(!matchesNoResultsSentinel('Showing 24 results for iPhone 14 Pro Max'), 'populated "Showing 24 results" → NOT empty');
      assert(!matchesNoResultsSentinel('28,000+ results for iphone 13'), 'populated eBay "28,000+ results for" → NOT empty');
      assert(!matchesNoResultsSentinel('<div>Cart: no items in your cart yet</div>'), 'incidental "no items in your cart" (no qualifier) → NOT empty');
      // A Swappa model-PICKER page (tiles, no empty-state copy) → must NOT match,
      // so it still falls through to the zero-extracted heuristic.
      assert(!matchesNoResultsSentinel('Select your model: iPhone 14 Series, iPhone 15 Series, MacBooks'), 'picker page (no empty-state copy) → NOT empty');
      assert(!matchesNoResultsSentinel(''), 'empty string → NOT a match (no throw)');
      return { ok: true };
    },
  },
  {
    // End-to-end through detectAntiBotSignal: the site's own "0 results" page must
    // return null (no warning), while a drifted/picker page with 0 items still
    // flags zero-extracted, and a real block that ALSO contains "no results" copy
    // still loses to the Layer-3 block verdict (block wins).
    name: 'detectAntiBotSignal: explicit 0-results → null; drift/picker still zero-extracted; block still wins',
    run: () => {
      const bigBody = (core) => core + ' '.repeat(60000); // > suspiciousBelow, not tiny
      // 1) Swappa legitimate empty → null (was zero-extracted/throttle).
      const empty = detectAntiBotSignal({
        html: bigBody('Showing 0 results for Yamaha A3R ARE acoustic electric guitar. No products match this criteria...'),
        itemsExtracted: 0, expectedMinItems: 3, sourceLabel: 'swappa',
        finalUrl: 'https://swappa.com/search?q=Yamaha%20A3R%20ARE',
      });
      assert(empty === null, `Swappa 0-results page → null (got ${JSON.stringify(empty)})`);
      // 2) Drift/picker: big body, 0 items, NO empty-state copy → still zero-extracted.
      const drift = detectAntiBotSignal({
        html: bigBody('Select your model below to see prices: iPhone 14 Series, MacBooks, PlayStation 5'),
        itemsExtracted: 0, expectedMinItems: 3, sourceLabel: 'swappa',
        finalUrl: 'https://swappa.com/search?q=whatever',
      });
      assert(drift?.code === 'zero-extracted', `picker/drift page (no empty-state) → zero-extracted (got ${JSON.stringify(drift)})`);
      // Reporting enhancement: the evidence must carry a page-text snippet so a
      // future report is self-diagnosing (picker vs drift) without pasting HTML.
      assert(/page text:/.test(drift.evidence) && /Select your model/.test(drift.evidence), `zero-extracted evidence includes a page-text snippet (got: ${drift.evidence})`);
      // 3) A real block page that ALSO contains "no results" must still be a block
      //    (Layer 3 keyword sniff runs first).
      const blocked = detectAntiBotSignal({
        html: 'Pardon Our Interruption... we noticed unusual traffic. No results found.',
        itemsExtracted: 0, expectedMinItems: 3, sourceLabel: 'ebay',
      });
      assert(blocked && blocked.code !== 'zero-extracted' && blocked.severity, `block page with "no results" copy still flags a block (got ${JSON.stringify(blocked)})`);
      // 4) Populated page (items >= threshold) never reaches the gate → null.
      const ok = detectAntiBotSignal({ html: bigBody('Showing 24 results'), itemsExtracted: 24, expectedMinItems: 3, sourceLabel: 'swappa' });
      assert(ok === null, `populated page → null (got ${JSON.stringify(ok)})`);
      return { ok: true };
    },
  },
  {
    // Layer 3.6: a sub-floor item count must NOT be a block when the scrape
    // SUCCEEDED on a genuinely-thin query — proven either by the site's own
    // result-count header (eBay "1 result") or by extractor health (seen ===
    // extracted, noFields === 0). This is what kills the eBay "1 result"
    // false zero-extracted + unclearable Solve loop. Drift must still flag.
    name: 'detectAntiBotSignal: claimedTotal / seen-noFields gate distinguishes thin-query from drift',
    run: () => {
      const bigBody = (core) => core + ' '.repeat(60000);
      const base = { html: bigBody('1 result for FastRack Glass Jug'), expectedMinItems: 3, sourceLabel: 'ebay-sold', finalUrl: 'https://www.ebay.com/sch/i.html?_nkw=x&LH_Sold=1' };
      // (a) eBay says "1 result" and we got 1 → genuine thin query → null.
      assert(detectAntiBotSignal({ ...base, itemsExtracted: 1, yieldStats: { seen: 1, noFields: 0, claimedTotal: 1 } }) === null,
        'site claims 1 + extracted 1 → suppressed (no false zero-extracted)');
      // (a') Selector/pagination drift: site claims 50, we extracted 1 → STILL flags.
      const drift = detectAntiBotSignal({ ...base, itemsExtracted: 1, yieldStats: { seen: 1, noFields: 0, claimedTotal: 50 } });
      assert(drift?.code === 'zero-extracted', `claims 50 but extracted 1 → still zero-extracted drift (got ${JSON.stringify(drift)})`);
      // (a'') claimedTotal takes EXCLUSIVE precedence — the consistent-looking
      // seen===extracted must NOT rescue a drift the count header contradicts.
      assert(detectAntiBotSignal({ ...base, itemsExtracted: 2, expectedMinItems: 5, yieldStats: { seen: 2, noFields: 0, claimedTotal: 40 } })?.code === 'zero-extracted',
        'claimed-count contradicting seen still flags (no seen-heuristic rescue)');
      // (b) No count header, extractor healthy (seen === extracted, noFields 0) → null.
      assert(detectAntiBotSignal({ ...base, sourceLabel: 'mercari', itemsExtracted: 2, yieldStats: { seen: 2, noFields: 0 } }) === null,
        'no count header + healthy extractor (seen===extracted) → suppressed');
      // (b') No count header but cards were DROPPED (seen > extracted) → drift flags.
      assert(detectAntiBotSignal({ ...base, sourceLabel: 'mercari', itemsExtracted: 1, yieldStats: { seen: 9, noFields: 8 } })?.code === 'zero-extracted',
        'dropped cards (seen >> extracted, noFields>0) → still zero-extracted');
      // (c) No yieldStats at all → unchanged legacy behavior (still flags).
      assert(detectAntiBotSignal({ ...base, itemsExtracted: 1 })?.code === 'zero-extracted',
        'no yieldStats → legacy zero-extracted preserved');
      return { ok: true };
    },
  },
  {
    // Regression for "Cloudflare block mislabeled as stale-selectors": when the
    // extractor throws SITE_CHANGED (0 cards), browserPool now DEFERS the throw and
    // asks detectAntiBotSignal to look at the same page with itemsExtracted=null,
    // then reroutes ONLY on a `block` verdict. This pins the two inputs that branch
    // drives, exactly as seen in the UPWOIGH report:
    //   • Mercari rescrape = Cloudflare "Just a moment…" (~4.5KB) → block
    //     (cloudflare-challenge) → card shows Solve, domain backs off as a block.
    //   • eBay = full ~1MB SRP, correct title, su-styled-text matched 0 → NOT a
    //     block → browserPool re-throws SITE_CHANGED → stays stale-selectors (Retry).
    name: 'detectAntiBotSignal: 0-card SITE_CHANGED page — Cloudflare → block, real drift → not-a-block',
    run: () => {
      // itemsExtracted=null is the exact value browserPool passes after a deferred
      // SITE_CHANGED throw (extractorResult stays null), so contentServed=false and
      // the Layer-3 keyword sniff runs — the whole point of deferring the throw.
      const cf = detectAntiBotSignal({
        html: '<html><head><title>Just a moment...</title></head><body>Just a moment... Checking your browser before accessing mercari.com. cf-browser-verification</body></html>',
        itemsExtracted: null, expectedMinItems: 0, sourceLabel: 'mercari',
        finalUrl: 'https://www.mercari.com/search/?keyword=x&status=sold_out',
      });
      assert(cf?.severity === 'block', `Cloudflare "Just a moment…" + 0-card throw → block (got ${JSON.stringify(cf)})`);
      assert(cf?.code === 'cloudflare-challenge', `→ cloudflare-challenge specifically (got ${cf?.code})`);
      // Full eBay SRP, 0 cards, NO challenge markers anywhere → must NOT be a block,
      // so the reroute's `warning?.severity === 'block'` is false and the original
      // SITE_CHANGED re-raises (genuine selector drift stays stale-selectors/Retry).
      const drift = detectAntiBotSignal({
        html: '<html><head><title>Upwoigh Water Container for sale | eBay</title></head><body>' + 'Shop by category. Save this search. Results matching fewer words. '.repeat(8000) + '</body></html>',
        itemsExtracted: null, expectedMinItems: 0, sourceLabel: 'ebay-sold',
        finalUrl: 'https://www.ebay.com/sch/i.html?_nkw=x&LH_Complete=1&LH_Sold=1',
      });
      assert(!drift || drift.severity !== 'block', `full eBay SRP with 0 cards must NOT be a block → re-throws as stale-selectors (got ${JSON.stringify(drift)})`);
      return { ok: true };
    },
  },
  {
    // The shared Chrome profile is OS-locked to one process. Two launch failures
    // mean "another Chrome holds it" and are safe to wait-and-retry; everything
    // else (missing binary, permission denial, crash) must NOT be retried.
    name: 'isProfileLockCollision: classifies the two shared-profile lock errors, not unrelated failures',
    run: () => {
      assert(isProfileLockCollision(new Error('The browser is already running for /Users/x/browser-data. Use a different `userDataDir` or stop the running browser first.')), 'headless "already running" → collision');
      assert(isProfileLockCollision('Failed to launch the browser process:  Code: 0  stderr:  Opening in existing browser session.'), 'visible "Opening in existing browser session" → collision');
      assert(!isProfileLockCollision(new Error('Failed to launch the browser process: spawn ENOENT')), 'missing Chrome → NOT a collision (must surface)');
      assert(!isProfileLockCollision(new Error('Navigation timeout of 30000 ms exceeded')), 'nav timeout → NOT a collision');
      assert(!isProfileLockCollision(null) && !isProfileLockCollision(undefined), 'nullish → NOT a collision (no throw)');
      return { ok: true };
    },
  },
  {
    // Persisted collision tally must survive the log ring buffer (the whole point):
    // count totals, track auto-recovery, ring-cap the event list, and snapshot-copy.
    name: 'browserLaunchTelemetry: records totals/recovery, caps the ring, returns a copy',
    run: () => {
      _resetLaunchCollisions();
      assert(getLaunchCollisions().total === 0, 'starts empty');
      recordLaunchCollision({ context: 'headless-scrape', attempts: 2, recovered: true, error: 'already running for x', ts: 1000 });
      recordLaunchCollision({ context: 'captcha-resolve-window', url: 'https://www.ebay.com/sch', attempts: 6, recovered: false, error: 'Opening in existing browser session', ts: 2000 });
      let snap = getLaunchCollisions();
      assert(snap.total === 2 && snap.recovered === 1, `total=2 recovered=1 (got ${snap.total}/${snap.recovered})`);
      assert(snap.events[snap.events.length - 1].context === 'captcha-resolve-window', 'last event is the most recent');
      assert(snap.events[1].error.length <= 200, 'error string is bounded');
      // Mutating the returned snapshot must not corrupt internal state.
      snap.events.push({ junk: true });
      assert(getLaunchCollisions().events.length === 2, 'getLaunchCollisions returns a copy, not the live array');
      // Ring cap at 12: push 15 more, expect exactly 12 retained, newest last.
      for (let i = 0; i < 15; i++) recordLaunchCollision({ context: `c${i}`, ts: 3000 + i });
      snap = getLaunchCollisions();
      assert(snap.events.length === 12, `ring caps at 12 (got ${snap.events.length})`);
      assert(snap.events[snap.events.length - 1].context === 'c14', 'newest event retained');
      assert(snap.total === 17, `total keeps counting past the ring cap (got ${snap.total})`);
      _resetLaunchCollisions();
      return { ok: true };
    },
  },
];

async function run() {
  let passed = 0;
  let failed = 0;

  console.log('\n[TEST RUNNER] Deterministic smoke tests\n');

  for (const test of tests) {
    try {
      const details = await test.run();
      console.log(`PASS ${test.name}`, details ? JSON.stringify(details) : '');
      passed++;
    } catch (error) {
      console.error(`FAIL ${test.name}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n[TEST RUNNER] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error('[TEST RUNNER] Fatal error:', error);
  process.exitCode = 1;
});
