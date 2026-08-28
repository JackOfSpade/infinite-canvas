import { CANVAS_ZOOM_LIMITS, CURRENT_SCHEMA_VERSION, EBAY_ACTIVE_EXTRACTOR, EBAY_SOLD_EXTRACTOR, FILE_CATEGORIES, GLASSDOOR_EXTRACTOR, GOOGLE_JOBS_EXTRACTOR, JOB_AUTH_PREFLIGHT_SOURCE_IDS, JOB_COLLECTION_LIMITS_DEFAULT, JOB_COLLECTION_PAGE_CEILING, JSDOM, MERCARI_SOLD_EXTRACTOR, MS_PER_WEEK, POSHMARK_SOLD_EXTRACTOR, SELLHUB_TRANSIENT_KEYS, TRANSIENT_PROCESSING_HUB_STATES, appendPhotoFiles, appendPhotoPaths, applyBugReportCode, applyFinalJobTitleRelevanceGate, assert, buildCustomizationDialogData, buildFilterSummaryMarkdown, buildGeoTermSet, buildJobTasks, calculatePriceDropSuggestion, canHubAcceptInitialDrop, canSellHubAcceptDisplayPhotoDrop, canSellHubReplaceFailedInitialPhotos, clearMissingPreviewRelinkCache, clearMissingPreviewRelinkDiagnostics, clearMissingPreviewSearchRoots, cloneNode, codeIncludesFull, compsForPricing, computeTidiedNodes, createJobSearchTestMode, createMarketplaceTestMode, createModuleRunQueue, createdAtMsFromCardId, decodeLocalFileRequestPath, deleteChildrenByHubId, describeJobCollectionLimits, distToSegment, edgeZoneForRadius, enqueueUniqueSourceResolve, extractIndeedJobsFromHtml, filesToDropPayloads, filesToProductImagePaths, filterJobsByAge, filterNodeCustomizationUpdates, filterWholeFeedJobsByTitleRelevance, findExactFilenameBelow, findNonOverlappingPlacement, fingerprint, fitViewDuration, fs, getConnectedHubCards, getFileCategoryInfo, getHubDropRejectLabel, getHubFileDropMode, getJobAuthPreflightSourceIds, getJobSearchTransientKeysForSave, getLocalFilePath, getMissingPreviewRelinkDiagnostics, getScopedCompSourceIds, glassdoorPostedBucket, gridSpacing, isCompSourceEnabledInScope, isPlaceholderIndeedJobKey, isPriceDropReminderDue, isProductImageExtension, isUnlimitedPages, jobRelevanceEvidence, jobRelevanceMatch, jobRelevanceRejection, jobScoringBatchSize, matchesQuery, matchesRedoShortcut, mergeNonRestorableNodeDataFromLive, migrateGroupNodes, migrateInterruptedJobHubResults, migrateJobHubPageCeiling, migrateLegacyJobHubResults, migrateStaleJobHubInputLock, migrateMarketplaceCardCreatedAt, nextSearchMatchIndex, nodeSupportsCustomization, normalizeJobCollectionLimits, normalizePhotoPathList, normalizePriceDropMustSellDate, normalizePriceDropReminderWeeks, normalizePriceDropStartingPrice, normalizePriceDropStartingTier, normalizePriceDropTargetPrice, oldestPriceDropCardCreatedAtIso, os, panDuration, parseJobSearchEnvBoolean, parseMarketplaceEnvBoolean, parsePostedDate, path, persistenceContentFingerprint, pixelEraseStroke, previewBugReportCode, priceDropDeadlineReminderDelayMs, priceDropMustSellDateMs, priceDropMustSellDayEndMs, priceDropReminderCountThroughMustSell, priceDropReminderDelayMs, priceDropStartingPrice, priceSynthesisMaxTokens, radialRadius, reassignCanvasDataIDs, refreshManualSourceUrlIndex, rememberMissingPreviewSearchRoot, removePhotoPathAt, resolveManualSourceStopReason, resolveMissingPreviewPath, resolvePageCeiling, resolvePendingApplicationWorkspaceForOwner, resolvePortableFilePaths, resolvePortableImagePath, resolvePriceDropStartingTier, runExtractorFixtureTest, runNodeMigrations, runZeroResultFixtureTest, sanitizeEdgesForSave, sanitizeNodesForSave, segmentCircleIntersections, shouldUseNativeTextUndo, spiralStep, summarizeFileExtensions, syncUncontrolledTextValue, toLocalFileUrl, viewportForZoomAtScreenPoint, sourceJobKey } from '../test-dependencies.js';
import { getJobSourceResolveConfig } from '../test-dependencies.js';
import { nextDescriptionRecoveryGuidance, partitionResolvedDescriptionRecoveryCandidates, reconcileResolvedDescriptionRecovery, selectResolvedDescriptionRecoveryCandidates } from '../test-dependencies.js';
import { buildResolvedDescriptionWarning } from '../test-dependencies.js';

import { JOBHUB_CAREER_IDENTITY_FIELDS, assessDescriptionPanelUpdate, assessDetailSelection, buildDescriptionCardTargets, buildHubHoverState, buildJobHubCareerClearPatch, buildPhysicalCardWalkPlan, createRunOwnershipGuard, descriptionExpansionStrategy, descriptionPanelPacing, descriptionPanelRetryAllowed, extractGlassdoorPanelResponseDetail, filePayloadFromDraggedNodes, glassdoorPanelResponseIdentity, hubHasAcceptedInitialDrop, inspectDescriptionCardTargetAvailability, inspectGlassdoorOpportunityModal, isGlassdoorPanelRateLimitResponse, isGoogleDescriptionPanelRateLimitResponse, mergeGlassdoorPanelDetail, readActiveGoogleDetailTitle, readDescriptionCardDomKey, readDescriptionPanelText, recordIndeedEnrichmentAttempt, selectGoogleApplyUrl } from '../test-dependencies.js';

export default [
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
    // A live bug report (2026-07-09) caught eBay serving the OLDER li.s-card/
    // su-styled-text generation two days after the extractor was switched to
    // ONLY read the newer div.su-item-card generation (commit 1834233) — every
    // scrape returned suItemCard=0 while liSCard/sCardTitle/priceSel were all
    // healthy. eBay is evidently flip-flopping generations (A/B test / gradual
    // rollout), so the extractor must recognize both by name. This fixture has
    // NO su-item-card markup at all — it locks in that the "legacy" branch
    // (EBAY_CARD_GEN_FN) still extracts real comps instead of throwing
    // SITE_CHANGED just because the newer generation isn't present.
    name: 'eBay extractor: legacy (pre-2026-07) li.s-card generation still extracts',
    run: () => {
      const legacyHtml = '<html><head><title>shark slider nano for sale</title></head><body>' +
        '<div class="srp-controls__count-heading">2 results for shark slider nano</div>' +
        '<ul class="srp-results">' +
        '<li class="s-card"><a class="s-card__link" href="https://www.ebay.com/itm/2000000001">' +
        '<span class="su-styled-text primary default">IFOOTAGE Shark Slider Nano II 660</span></a>' +
        '<span class="s-card__price">$120.00</span>' +
        '<span class="su-styled-text positive default">Sold Jul 5, 2026</span>' +
        '<span class="su-styled-text secondary default">Pre-Owned ·</span></li>' +
        '<li class="s-card"><a class="s-card__link" href="https://www.ebay.com/itm/2000000002">' +
        '<span class="su-styled-text primary default">IFOOTAGE Shark Slider Nano II 660 v2</span></a>' +
        '<span class="s-card__price">$135.50</span>' +
        '<span class="su-styled-text positive default">Sold Jul 6, 2026</span>' +
        '<span class="su-styled-text secondary default">Used ·</span></li>' +
        '</ul></body></html>';

      const soldDom = new JSDOM(legacyHtml, { url: 'https://www.ebay.com/sch/i.html?_nkw=shark+slider&LH_Sold=1', runScripts: 'outside-only' });
      const soldRaw = soldDom.window.eval(EBAY_SOLD_EXTRACTOR);
      assert(soldRaw && Array.isArray(soldRaw.items), 'legacy eBay sold: extractor did not return { items }');
      assert(soldRaw.items.length === 2, `legacy eBay sold: expected 2 items, got ${soldRaw.items.length}`);
      const soldSample = soldRaw.items[0];
      assert(soldSample.source === 'ebay-sold', 'legacy eBay sold: wrong source id');
      assert(soldSample.title === 'IFOOTAGE Shark Slider Nano II 660', `legacy eBay sold: wrong title → ${soldSample.title}`);
      assert(soldSample.price === 120, `legacy eBay sold: wrong price → ${soldSample.price}`);
      assert(soldSample.url === 'https://www.ebay.com/itm/2000000001', `legacy eBay sold: wrong url → ${soldSample.url}`);
      assert(soldSample.soldDate === 'Sold Jul 5, 2026', `legacy eBay sold: wrong soldDate → ${soldSample.soldDate}`);
      assert(soldSample.condition === 'Pre-Owned', `legacy eBay sold: wrong condition → ${soldSample.condition}`);

      const activeDom = new JSDOM(legacyHtml, { url: 'https://www.ebay.com/sch/i.html?_nkw=shark+slider', runScripts: 'outside-only' });
      const activeRaw = activeDom.window.eval(EBAY_ACTIVE_EXTRACTOR);
      assert(activeRaw && Array.isArray(activeRaw.items), 'legacy eBay active: extractor did not return { items }');
      assert(activeRaw.items.length === 2, `legacy eBay active: expected 2 items, got ${activeRaw.items.length}`);
      assert(activeRaw.items[0].source === 'ebay-active', 'legacy eBay active: wrong source id');
      assert(activeRaw.items[0].url === 'https://www.ebay.com/itm/2000000001', `legacy eBay active: wrong url → ${activeRaw.items[0].url}`);
      return { ok: true, soldCount: soldRaw.items.length, activeCount: activeRaw.items.length };
    },
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
    // Google exposes each list card through both .EimVGf and jscontroller. The
    // extractor must visit their DOM union once (not twice), retain the exact
    // list order, and carry htidocid through to description expansion. Losing
    // that opaque key makes the generic card clicker appear to jump over cards.
    name: 'Google Jobs extractor: visits every card once, in DOM order, with stable click identities',
    run: () => {
      const cards = [
        ['first-card', 'First Systems Architect'],
        ['second-card', 'Second Systems Architect'],
        ['third/card', 'Third Systems Architect'],
        ['fourth-card', 'Fourth Systems Architect'],
        ['fifth-card', 'Fifth Systems Architect'],
        ['sixth-card', 'Sixth Systems Architect'],
      ];
      const html = cards.map(([id, title], index) => {
        const opaqueId = encodeURIComponent(id);
        return `<div id="${id}" class="EimVGf" jscontroller="b11o3b"
          data-share-url="https://www.google.com/search?ibp=htl%3Bjobs&q=Systems+Architect&htidocid=${opaqueId}">
          <div class="GoEOPd"><div class="tNxQIb" role="heading">${title}</div><div>Acme ${index + 1}</div><div>Toronto, ON • via Acme</div></div>
          <span>${index + 1} day ago</span>
        </div>`;
      }).join('');
      const dom = new JSDOM(`<html><body>${html}</body></html>`, {
        url: 'https://www.google.com/search?q=Systems+Architect&udm=8',
        runScripts: 'outside-only',
      });
      // jsdom intentionally lacks innerText; Google extraction runs in Chrome,
      // where it is present. This compatible getter lets the test exercise the
      // exact shipped extractor string rather than a copied approximation.
      Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() { return this.textContent || ''; },
      });
      const jobs = dom.window.eval(GOOGLE_JOBS_EXTRACTOR);
      assert(jobs.length === cards.length,
        `Google card walk must emit every physical card exactly once, got ${jobs.length}/${cards.length}`);
      assert(jobs.map(job => job.title).join('|') === cards.map(([, title]) => title).join('|'),
        'Google card walk must preserve DOM order; never sample every Nth card');
      const extractedCardIds = jobs.map(job => new URL(job.googleCardUrl).searchParams.get('htidocid'));
      assert(extractedCardIds.join('|') === cards.map(([id]) => id).join('|'),
        'each extracted Google row must retain its card htidocid, including URL-encoded opaque IDs');
      assert(jobs.every(job => job.url === '' && job.googleCardUrl && job.applySource.startsWith('Acme')),
        'Google internal share routes must stay in googleCardUrl until the verified detail panel supplies a direct Apply-on URL');
      assert(extractedCardIds.every(id => dom.window.document.getElementById(id)),
        'each retained htidocid must resolve to the corresponding clickable list-card element');
      assert(new Set(jobs.map(sourceJobKey)).size === cards.length,
        'distinct Google htidocid values must remain distinct through source-level dedup');
      assert(jobs.every(job => job.snippet === ''),
        'Google list-card metadata must not occupy snippet; only a successful detail-panel read counts as description expansion');

      const targets = buildDescriptionCardTargets(jobs, 'google');
      assert(targets.map(target => target.index).join(',') === '0,1,2,3,4,5'
        && targets.map(target => target.key).join('|') === extractedCardIds.join('|'),
      'the sequential click pass must preserve every extracted htidocid target');
      const fullyPresent = inspectDescriptionCardTargetAvailability(targets, extractedCardIds);
      assert(fullyPresent.planned === cards.length && fullyPresent.available === cards.length && fullyPresent.missing.length === 0,
        'a fully mounted card list reports every planned click target available');
      // Simulate the Google inner scroller virtualizing the first half of the
      // list after reveal. This must be observable as specific target misses,
      // never silently reinterpreted as successful expansion of nearby cards.
      const virtualized = inspectDescriptionCardTargetAvailability(targets, extractedCardIds.slice(3));
      assert(virtualized.planned === cards.length && virtualized.available === 3
        && virtualized.missing.map(target => target.index).join(',') === '0,1,2',
      'a virtualized DOM window exposes exactly which sequential card targets disappeared');
      const physicalPlan = buildPhysicalCardWalkPlan(jobs, [jobs[0], jobs[3], jobs[5]]);
      assert(physicalPlan.physicalTotal === 6
        && physicalPlan.physicalIndexes.join(',') === '1,4,6',
      'a bounded card walk retains each selected job\'s physical DOM ordinal');
      const copiedPlan = buildPhysicalCardWalkPlan(jobs, [{ ...jobs[0] }, { ...jobs[3] }, { ...jobs[5] }]);
      assert(copiedPlan.physicalIndexes.join(',') === '1,4,6',
        'a normalized/copied recovery row retains its provider-list ordinal by stable identity');
      return { cards: jobs.length, identities: extractedCardIds, virtualizedMisses: virtualized.missing.length };
    },
  },
{
    name: 'Google Jobs apply links: prefers the list-card provider and removes Google tracking',
    run: () => {
      const selected = selectGoogleApplyUrl([
        { label: 'Apply on Indeed', href: 'https://example.indeed.test/viewjob?jk=1&utm_source=google_jobs_apply' },
        { label: 'Apply on Canada Life Careers', href: 'https://jobs.example.test/roles/42?utm_campaign=google_jobs_apply&utm_medium=organic&keep=yes' },
        { label: 'Apply on Google', href: 'https://www.google.com/search?udm=8' },
        { label: 'Review employer', href: 'https://unsafe.example.test/not-an-apply-link' },
      ], 'Canada Life Careers');
      assert(selected === 'https://jobs.example.test/roles/42?keep=yes',
        `Google Apply-on selection must prefer the card's via-provider and remove only Google tracking params (got ${selected})`);
      assert(selectGoogleApplyUrl([{ label: 'Apply on Google', href: 'https://google.com/search?udm=8' }]) === '',
        'Google internal routes must never be promoted to the public apply URL');
      return { selected };
    },
  },
{
    name: 'Google detail panel text ignores cached and preloaded aria-hidden panels',
    run: () => {
      const dom = new JSDOM(`
        <main>
          <section aria-hidden="true"><span class="OOyDTc">cached previous description</span></section>
          <section aria-hidden="false">
            <span class="OOyDTc">active description opening</span>
            <span class="ejCXj" style="display:none">active hidden continuation</span>
          </section>
          <section aria-hidden="true"><span class="OOyDTc">preloaded next description</span></section>
        </main>`, { runScripts: 'outside-only' });
      const text = readDescriptionPanelText(dom.window.document, 'span.OOyDTc, span.ejCXj', true);
      assert(text === 'active description opening\n\nactive hidden continuation',
        `Google active detail panel should exclude aria-hidden cache/preload panels, got ${JSON.stringify(text)}`);
      const activeTitle = readActiveGoogleDetailTitle(dom.window.document);
      assert(activeTitle === '', 'a panel with no heading should stay unverified rather than falsely mismatching');
      return { text };
    },
},
{
    name: 'Google Solve retains the persisted unresolved recovery pool when the visible slice is a duplicate',
    run: () => {
      const rawGoogleRows = 119;
      const ageDropped = 12;
      const complete = Array.from({ length: 24 }, (_, index) => ({
        source: 'google', title: `Complete ${index}`, company: 'Acme', location: 'US',
        url: `https://www.google.com/search?htidocid=complete-${index}`,
        snippet: 'D'.repeat(500),
      }));
      const deferred = Array.from({ length: 83 }, (_, index) => ({
        source: 'google', title: `Deferred ${index}`, company: 'Acme', location: 'US',
        url: `https://www.google.com/search?htidocid=deferred-${index}`,
        snippet: '', descriptionDeferredReason: 'description-rate-limited',
      }));
      // The visible resolve window returned only 10 rows that were already
      // complete in the original 119-row source universe.
      const resolved = reconcileResolvedDescriptionRecovery(
        [...complete, ...deferred], 'google', complete.slice(0, 10),
      );
      const warning = buildResolvedDescriptionWarning('google', null, resolved.completeRows, resolved.emptyRows);
      const initialMountedSlice = complete.slice(0, 10).map(job => ({ ...job, snippet: '' }));
      const fullyRevealedProviderList = [...complete, ...deferred].map(job => ({
        ...job, snippet: '', descriptionDeferredReason: undefined,
      }));
      const initialTargets = selectResolvedDescriptionRecoveryCandidates(
        [...complete, ...deferred], 'google', initialMountedSlice,
      );
      const fullTargets = selectResolvedDescriptionRecoveryCandidates(
        [...complete, ...deferred], 'google', fullyRevealedProviderList,
      );
      const partialPartition = partitionResolvedDescriptionRecoveryCandidates(
        [...complete, ...deferred], 'google', [...complete, ...deferred.slice(0, 82)].map(job => ({
          ...job, snippet: '', descriptionDeferredReason: undefined,
        })),
      );
      const firstNoMatch = nextDescriptionRecoveryGuidance(null, {
        unavailableRows: partialPartition.unavailable,
        providerRowsLoaded: 119,
        attempted: 0,
        recovered: 0,
        empty: 1,
        completeTotal: 71,
      });
      const retryWarning = buildResolvedDescriptionWarning(
        'google',
        {
          code: 'description-listing-unavailable',
          evidence: 'One unresolved listing is absent from the fully loaded provider list.',
          suggestion: 'The listing may have expired.',
          recoveryGuidance: firstNoMatch.guidance,
        },
        complete,
        deferred.slice(-1),
      );
      const secondNoMatch = nextDescriptionRecoveryGuidance(firstNoMatch.state, {
        unavailableRows: partialPartition.unavailable,
        providerRowsLoaded: 121,
        attempted: 0,
        recovered: 0,
        empty: 1,
        completeTotal: 71,
      });
      const skipWarning = buildResolvedDescriptionWarning(
        'google',
        {
          code: 'description-listing-unavailable',
          evidence: 'One unresolved listing is absent from the fully loaded provider list.',
          suggestion: 'The listing may have expired.',
          recoveryGuidance: secondNoMatch.guidance,
        },
        complete,
        deferred.slice(-1),
      );
      const resetAfterRealAttempt = nextDescriptionRecoveryGuidance(secondNoMatch.state, {
        unavailableRows: partialPartition.unavailable,
        providerRowsLoaded: 121,
        attempted: 1,
        recovered: 0,
        empty: 1,
        completeTotal: 71,
      });
      assert(rawGoogleRows === complete.length + deferred.length + ageDropped
        && resolved.recoveryJobs.length === 107
        && resolved.completeRows.length === 24
        && resolved.emptyRows.length === 83
        && initialTargets.length === 0
        && fullTargets.length === 83
        && partialPartition.candidates.length === 82
        && partialPartition.unavailable.length === 1
        && partialPartition.unavailable[0].title === 'Deferred 82'
        && retryWarning?.code === 'description-listing-unavailable'
        && retryWarning?.shortLabel === 'Retry recommended'
        && retryWarning?.actionLabel === 'Retry'
        && retryWarning?.evidence === '"Deferred 82" was not found in the current Google results. Retry once more; if it is still missing, Skip will be recommended.'
        && retryWarning?.suggestion === null
        && secondNoMatch.guidance.recommendation === 'skip'
        && skipWarning?.shortLabel === 'Skip recommended'
        && skipWarning?.actionLabel === 'Check anyway'
        && skipWarning?.evidence === '"Deferred 82" was not found in 2 consecutive checks. Skip is recommended, or choose Check anyway to retry.'
        && skipWarning?.suggestion === null
        && resetAfterRealAttempt.state.consecutiveNoMatchPasses === 0
        && resetAfterRealAttempt.guidance.recommendation === 'retry'
        && warning?.severity === 'block',
      'a 119-raw / 24-complete / 83-unresolved Google run must retain its pool, ignore the duplicate mounted slice, and target all deferred identities after full reveal');
      return { raw: rawGoogleRows, postAge: resolved.recoveryJobs.length, complete: resolved.completeRows.length, unresolved: resolved.emptyRows.length };
    },
},
{
    name: 'Glassdoor descriptions stay on the list-card panel with exact job identity',
    run: () => {
      const activeDescription = 'Active role description. '.repeat(24).trim();
      const dom = new JSDOM(`<html><body>
        <ul>
          <li data-test="jobListing" data-jobid="101">
            <a data-test="job-title" href="https://fr.glassdoor.ca/job-listing/platform-architect.htm?jl=101">
              <span class="title-child">Platform Architect</span>
            </a>
            <span data-test="employer-name">Acme</span>
            <span data-test="location">Toronto, ON</span>
            <span data-test="job-age">2d</span>
          </li>
          <li data-test="jobListing" data-jobid="102">
            <a data-test="job-title" href="https://www.glassdoor.ca/job-listing/cloud-architect.htm?jl=102">
              <span>Cloud Architect</span>
            </a>
            <span data-test="employer-name">Beta</span>
            <span data-test="location">Canada</span>
            <span data-test="job-age">3d</span>
          </li>
        </ul>
        <section aria-hidden="true">
          <div data-brandviews="joblisting-description">cached previous description</div>
        </section>
        <section aria-hidden="false">
          <div data-brandviews="joblisting-description">${activeDescription}</div>
        </section>
      </body></html>`, {
        url: 'https://www.glassdoor.ca/Job/canada-architect-jobs.htm',
        runScripts: 'outside-only',
      });
      Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() { return this.textContent || ''; },
      });

      const jobs = dom.window.eval(GLASSDOOR_EXTRACTOR);
      const targets = buildDescriptionCardTargets(jobs, 'glassdoor');
      const firstChild = dom.window.document.querySelector('[data-jobid="101"] .title-child');
      const wrongChild = dom.window.document.querySelector('[data-jobid="102"] span');
      const firstIdentity = readDescriptionCardDomKey(firstChild, {
        cardAttr: 'data-jobid', expectedKey: '101',
      });
      const wrongIdentity = readDescriptionCardDomKey(wrongChild, {
        cardAttr: 'data-jobid', expectedKey: '101',
      });
      const panelText = readDescriptionPanelText(
        dom.window.document,
        '[data-brandviews*="joblisting-description"], [class*="JobDetails_jobDescription"]',
      );

      assert(descriptionExpansionStrategy('glassdoor') === 'list-card-panel'
        && descriptionExpansionStrategy('ziprecruiter') === 'detail-navigation'
        && descriptionExpansionStrategy('unknown') === 'none',
      'Glassdoor must stay on the list-panel path while ZipRecruiter retains bounded detail navigation');
      assert(jobs.length === 2 && jobs[0].url.startsWith('https://fr.glassdoor.ca/'),
        'list extraction must retain the user-facing regional Glassdoor URL without navigating to it');
      assert(targets.map(target => target.key).join('|') === '101|102',
        'Glassdoor jl parameters must map to the exact data-jobid card identities in order');
      assert(firstIdentity === '101' && wrongIdentity === '102' && wrongIdentity !== targets[0].key,
        'a descendant resolves through its owning data-jobid card and a wrong card remains rejectable');
      assert(panelText === activeDescription && panelText.length >= 400,
        'the panel reader must select the active full description, never an aria-hidden cached panel');
      return { jobs: jobs.length, strategy: descriptionExpansionStrategy('glassdoor'), chars: panelText.length };
    },
  },
{
    name: 'Glassdoor repeated descriptions require a matching active detail title and stop on the exact panel 429 endpoint',
    run: () => {
      const sameDescription = 'Shared employer description. '.repeat(20).trim();
      const verifiedRepeat = assessDescriptionPanelUpdate({
        sourceId: 'glassdoor',
        previousText: sameDescription,
        currentText: sameDescription,
        expectedTitle: 'Maritime Technical Solutions Architect',
        selectedTitle: 'Maritime Technical Solutions Architect',
      });
      const staleRepeat = assessDescriptionPanelUpdate({
        sourceId: 'glassdoor',
        previousText: sameDescription,
        currentText: sameDescription,
        expectedTitle: 'Air System Integrator',
        selectedTitle: 'Maritime Technical Solutions Architect',
      });
      const glassdoor429 = isGlassdoorPanelRateLimitResponse({
        sourceId: 'glassdoor', status: 429,
        url: 'https://www.glassdoor.ca/job-listing/api/job-details?jobListingId=1010227285673&pageTypeEnum=SERP',
      });
      const unrelated429 = isGlassdoorPanelRateLimitResponse({
        sourceId: 'glassdoor', status: 429,
        url: 'https://www.glassdoor.ca/api/search?query=architect',
      });
      const googleCallback429 = isGoogleDescriptionPanelRateLimitResponse({
        sourceId: 'google', status: 429,
        url: 'https://www.google.com/sorry/index?continue=https://www.google.com/async/callback:8166',
      });
      const unrelatedGoogle429 = isGoogleDescriptionPanelRateLimitResponse({
        sourceId: 'google', status: 429,
        url: 'https://www.google.com/search?q=architect',
      });
      const glassdoorInitialPacing = descriptionPanelPacing('glassdoor', 0);
      const glassdoorCheckpointPacing = descriptionPanelPacing('glassdoor', 8);
      const ordinaryPacing = descriptionPanelPacing('google', 8);
      assert(verifiedRepeat.accepted && verifiedRepeat.reason === 'text-unchanged-title-verified',
        'identical Glassdoor detail text may be accepted only after the active panel independently confirms the clicked title');
      assert(!staleRepeat.accepted && staleRepeat.reason === 'text-unchanged-unverified',
        'an unchanged stale Glassdoor panel must remain rejectable when its visible title is different');
      assert(glassdoor429 && !unrelated429 && googleCallback429 && !unrelatedGoogle429,
        'only known Glassdoor and Google detail-panel HTTP 429 responses are throttles; unrelated API failures must not halt the card walk');
      assert(glassdoorInitialPacing.requestDelayMs === 4500 && !glassdoorInitialPacing.checkpointDue
        && glassdoorInitialPacing.checkpointCooldownMs === 12000
        && glassdoorCheckpointPacing.checkpointDue && glassdoorCheckpointPacing.checkpointCooldownMs === 12000
        && ordinaryPacing.requestDelayMs === 600 && !ordinaryPacing.checkpointDue,
      'Glassdoor panel requests must proactively use a human-scale gap plus a rolling-window pause, without slowing other card walkers');
      assert(!descriptionPanelRetryAllowed('glassdoor') && descriptionPanelRetryAllowed('google'),
        'Glassdoor must issue at most one panel request per listing while other panel sources retain their bounded retry');
      return { repeat: verifiedRepeat.reason, rateLimit: glassdoor429, checkpoint: glassdoorCheckpointPacing.checkpointCooldownMs };
  },
},
{
    // One panel 429 used to disable description enrichment for the WHOLE
    // remaining source: 19 more pages were walked with no descriptions, 275 of
    // 336 in-window rows were dropped by the scoring-evidence gate, and the run
    // still reported `completed`. The block now has a bounded cooldown.
    name: 'a source-wide detail block cools down and re-probes instead of lasting the whole source',
    run: () => {
      const source = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
      const numeric = (name) => Number((source.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`)) || [])[1]);
      const DETAIL_BLOCK_PROBE_CARDS_VALUE = numeric('DETAIL_BLOCK_PROBE_CARDS');
      const DESC_STALE_THRESHOLD_VALUE = numeric('DESC_STALE_THRESHOLD');
      assert(Number.isFinite(DETAIL_BLOCK_PROBE_CARDS_VALUE) && Number.isFinite(DESC_STALE_THRESHOLD_VALUE),
        'both the probe size and the stale-timeout threshold are readable constants');
      assert(source.includes('const DETAIL_BLOCK_COOLDOWN_MS = 120_000;')
        && source.includes('const DETAIL_BLOCK_MAX_REPROBES = 3;')
        && source.includes('sourceDetailReprobes < DETAIL_BLOCK_MAX_REPROBES'),
      'the detail block is time-bounded with a capped number of re-probes rather than latching for the rest of the source');

      // Walking while blocked issues no panel requests, so a 19-page remainder
      // finishes in ~40s and would never reach a 120s cooldown — the re-probe
      // would be dead code. The walk must spend that time waiting instead.
      assert(source.includes('const cooldownRemainingMs = DETAIL_BLOCK_COOLDOWN_MS - (Date.now() - sourceDetailBlockAt);')
        && source.includes('await sleepUnlessAborted(cooldownRemainingMs, signal);')
        && source.includes('function sleepUnlessAborted(ms, signal)'),
      'a blocked walk waits out the remaining cooldown before the next page instead of racing to the end collecting unusable rows');

      // An opportunistic re-probe must never leave the run worse than the skip
      // it replaced: a descError would set earlyExit and truncate the source.
      assert(source.includes('descWarning: detailResult.descWarning || detailResult.descError,')
        && source.includes('descError: null,')
        && source.includes('keeping the source block instead of ending the walk'),
      'a failed re-probe is demoted to a warning so it cannot escalate a recoverable throttle into a truncated source walk');

      // "Recovered" must mean the throttle actually lifted, and a recovery must
      // hand a later, unrelated block a fresh budget.
      assert(source.includes("const reBlocked = ['description-rate-limited', 'description-panel-http-error']")
        && source.includes('if (detailResult.expandedCount > 0 && !detailResult.descError && !reBlocked) {')
        && source.includes('sourceDetailReprobes = 0;')
        && source.includes('sourceDetailBlockPage = null;'),
      'only a genuinely cleared throttle counts as recovered, and it resets the re-probe budget and the reported block page');

      assert(source.includes('} else if (reprobeFailedThisPage && !sourceDetailBlockCode) {'),
        'a re-probe that fails with an unrecognised code still re-arms the block, so the next page cannot hammer a source we just watched fail');

      // A throttle is not always a matched 429 — a suppressed XHR just times
      // out, and DESC_STALE_THRESHOLD of those trips abortWithError. Probing a
      // whole page would both hammer the throttled endpoint and manufacture a
      // "stale selectors" error out of an external rate limit.
      assert(source.includes('const DETAIL_BLOCK_PROBE_CARDS = 2;')
        && source.includes('const probeJobs = jobsToExpand.slice(0, DETAIL_BLOCK_PROBE_CARDS);')
        && source.includes('...restJobs.map(job => ({ ...job, descriptionDeferredReason: reprobeOfCode })),'),
      'a cooldown re-probe touches only a couple of cards and leaves the remainder deferred, instead of walking a whole page against a throttled endpoint');
      assert(DETAIL_BLOCK_PROBE_CARDS_VALUE < DESC_STALE_THRESHOLD_VALUE,
        `the probe size (${DETAIL_BLOCK_PROBE_CARDS_VALUE}) must stay below the consecutive-timeout abort threshold (${DESC_STALE_THRESHOLD_VALUE})`);
      assert(source.includes("phase: 'detail-block-reprobe-failed'")
        && source.includes("'detail-block-reprobe', 'detail-block-reprobe-failed', 'detail-block-cleared'"),
      'a failed re-probe records its own anomaly row — the source warning slot is already held by the original block, so its evidence would otherwise be lost');

      // The skip branch must not masquerade as a selector failure.
      assert(source.includes('enrichment skipped for ${jobsToExpand.length} card(s) — source blocked by')
        && source.includes('no panel request issued'),
      'a page whose enrichment was skipped says so, instead of logging "0/N expanded (sel: …)" like a broken selector');
      return { cooldownMs: 120_000, maxReprobes: 3 };
  },
},
{
    name: 'Glassdoor same-request JSON enriches its exact card without replacing authoritative panel or list fields',
    run: () => {
      const responseDescription = '<p>Build secure marine systems and lead architecture reviews.</p>'.repeat(12);
      const employerBiography = '<p>We have been a global employer for many decades.</p>'.repeat(14);
      const detail = extractGlassdoorPanelResponseDetail({
        data: {
          jobListing: {
            jobDescriptionHtml: responseDescription,
            datePosted: '2026-08-20',
            salaryInfo: {
              min: 145000,
              max: 165000,
              payPeriod: 'ANNUAL',
              currencyCode: 'CAD',
            },
            employer: {
              name: 'Adaptive Marine Solutions',
              description: employerBiography,
            },
          },
        },
      });
      const identity = glassdoorPanelResponseIdentity({
        sourceId: 'glassdoor', status: 200,
        url: 'https://fr.glassdoor.ca/job-listing/api/job-details?jobListingId=1010227285673&pageTypeEnum=SERP',
      });
      const unrelatedIdentity = glassdoorPanelResponseIdentity({
        sourceId: 'glassdoor', status: 200,
        url: 'https://www.glassdoor.ca/api/search?jobListingId=1010227285673',
      });
      const domText = 'Authoritative visible panel text. '.repeat(18).trim();
      const domMerge = mergeGlassdoorPanelDetail({
        title: 'Maritime Technical Solutions Architect',
        salary: '$150,000/yr',
        posted: '2d',
        company: 'List Company',
        descriptionDeferredReason: 'description-rate-limited',
      }, { domText, responseDetail: detail });
      const jsonFallback = mergeGlassdoorPanelDetail({
        title: 'Maritime Technical Solutions Architect', salary: '', posted: '', company: '',
      }, { responseDetail: detail });
      const employerOnly = extractGlassdoorPanelResponseDetail({
        jobListing: { employer: { name: 'Employer Only', description: employerBiography } },
      });

      assert(identity?.key === '1010227285673' && identity.status === 200 && !unrelatedIdentity,
        'same-request capture must bind only the exact first-party job-details endpoint and its jobListingId');
      assert(detail?.description.length >= 400 && !detail.description.includes('global employer')
        && detail.salary === '$145,000 - $165,000/yr'
        && detail.posted === '2026-08-20'
        && detail.company === 'Adaptive Marine Solutions',
      'schema-tolerant extraction must recover job fields while excluding the employer biography from description candidates');
      assert(domMerge.job.snippet === domText && domMerge.descriptionSource === 'dom'
        && domMerge.job.salary === '$150,000/yr' && domMerge.job.posted === '2d' && domMerge.job.company === 'List Company'
        && !domMerge.job.descriptionDeferredReason
        && domMerge.recoveredFields.length === 0,
      'visible DOM description must clear an earlier deferral marker while usable list fields remain authoritative over response JSON');
      assert(jsonFallback.descriptionSource === 'json'
        && jsonFallback.job.descriptionCapture === 'glassdoor-panel-response-json'
        && jsonFallback.job.salary === '$145,000 - $165,000/yr'
        && jsonFallback.job.posted === '2026-08-20'
        && jsonFallback.job.company === 'Adaptive Marine Solutions'
        && jsonFallback.recoveredFields.join('|') === 'salary|posted|company',
      'the exact same response may backfill a full description and only genuinely missing structured fields');
      assert(!employerOnly?.description,
        'an employer biography must never be promoted to a job description when the response lacks a job-description field');
      return { key: identity.key, source: jsonFallback.descriptionSource, recovered: jsonFallback.recoveredFields };
    },
  },
{
    name: 'Glassdoor job-alert popup is recognized only with its exact safe close control',
    run: () => {
      const prompt = new JSDOM(`<main>
        <div role="dialog" aria-modal="true">
          <button aria-label="Close job alert"><svg></svg></button>
          <p>GLASSDOOR · indeed</p>
          <h2>Never Miss an Opportunity</h2>
          <p>Create a job alert for enterprise architect jobs in Toronto</p>
          <button>Continue with Google</button>
        </div>
        <div role="dialog"><button aria-label="Close"><svg></svg></button><p>Save this job</p></div>
      </main>`, { runScripts: 'outside-only' });
      const inspected = inspectGlassdoorOpportunityModal(prompt.window.document);
      assert(inspected.detected && inspected.reason === 'close-control-found'
        && inspected.close?.getAttribute('aria-label') === 'Close job alert',
      'only the exact Glassdoor Never Miss an Opportunity prompt may yield a close target');

      const noControl = new JSDOM(`<div role="dialog">
        <h2>Never Miss an Opportunity</h2><p>Create a job alert</p><button>Continue with Google</button>
      </div>`, { runScripts: 'outside-only' });
      const blocked = inspectGlassdoorOpportunityModal(noControl.window.document);
      assert(blocked.detected && blocked.reason === 'close-control-missing' && !blocked.close,
        'the job-alert prompt must be surfaced as blocked instead of clicking a generic page control');

      const unrelated = new JSDOM(`<div role="dialog"><button aria-label="Close"><svg></svg></button>
        <h2>Never Miss a Saved Search</h2><p>Save this job.</p></div>`, { runScripts: 'outside-only' });
      assert(!inspectGlassdoorOpportunityModal(unrelated.window.document).detected,
        'a different Glassdoor dialog must never qualify for automatic dismissal');
      return { detected: inspected.detected, blocked: blocked.reason };
    },
  },
{
    name: 'Google detail selection guard verifies an active heading without accepting an explicit mismatch',
    run: () => {
      const dom = new JSDOM(`
        <main>
          <article data-share-url="https://example.test/?htidocid=old"><h3>Old list card</h3></article>
          <section aria-hidden="false"><h2>Systems Architect — Platform</h2></section>
        </main>`, { runScripts: 'outside-only' });
      const selectedTitle = readActiveGoogleDetailTitle(dom.window.document);
      const verified = assessDetailSelection('Systems Architect', selectedTitle);
      const mismatch = assessDetailSelection('Systems Architect', 'Unrelated Product Manager');
      const absent = assessDetailSelection('Systems Architect', '');
      assert(selectedTitle === 'Systems Architect — Platform' && verified.selectionVerified && !verified.selectionMismatch,
        'the active detail heading should verify a title when it only adds a display suffix');
      assert(mismatch.selectionMismatch && !mismatch.selectionVerified,
        'an explicitly different active detail heading must be marked mismatched');
      assert(!absent.selectionMismatch && !absent.selectionVerified,
        'missing detail headings must remain resilient/unverified rather than becoming false mismatches');
      return { selectedTitle };
    },
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
      assert(jobs[0]._extractPath === 'dom', `Indeed DOM extraction: expected DOM provenance, got ${jobs[0]._extractPath}`);
      return { count: jobs.length, sample: jobs[0] };
    },
  },
{
    // Guards FACT 2 (phantom Indeed template/companion records): the id-shape
    // family must catch the exact synthetic ids observed in a live scrape plus
    // their immediate rotation/repeat family, while a false POSITIVE here would
    // silently discard a REAL job — every genuine key below is a real jobkey
    // pulled from a live scrape or canvas.jobs-history.csv.
    name: 'isPlaceholderIndeedJobKey: catches synthetic/rotated-hex filler without flagging real jobkeys',
    run: () => {
      const placeholders = [
        '789abcdef0123456', // observed phantom (McCain Foods row)
        'cdef0123456789ab', // observed phantom (Msitek LLC row)
        '0f1e2d3c4b5a6978', // observed phantom (nibble-complement family)
        'aaaaaaaaaaaaaaaa', // repeat family, any charset
        '11111111',         // repeat family, shortest accepted length
        '0123456789abcdef', // the base ascending run itself
        'fedcba9876543210', // full descending run
        '3456789abcdef012', // an unobserved rotation — same cyclic family
        '890abcdef0123456', // one malformed transition from the cyclic family
      ];
      for (const key of placeholders) {
        assert(isPlaceholderIndeedJobKey(key),
          `isPlaceholderIndeedJobKey must flag synthetic filler "${key}" — missing this lets a template/companion block through as a fake job`);
      }
      const genuine = [
        '2136516a5da5d5e0', 'b36bd069f99d6c51', 'cbf351c41691bab3', '7b94b7c15100eb51',
        'df5300d5ae5f3472', '0dd80eafa128e4d8', '9d7a8b67591b2443', 'ffb46192a788b229',
        'fb535a2465cfa509',
      ];
      for (const key of genuine) {
        assert(!isPlaceholderIndeedJobKey(key),
          `isPlaceholderIndeedJobKey must NOT flag genuine jobkey "${key}" — a false positive here silently discards a REAL job`);
      }
      return { placeholders: placeholders.length, genuine: genuine.length };
    },
  },
{
    name: 'Indeed extraction: DOM placeholder guard and per-path provenance stay observable',
    run: () => {
      const next = { title: 'Next role', company: 'Next Co', location: 'Toronto, ON', jobkey: '2136516a5da5d5e0', snippet: 'D'.repeat(500) };
      const mosaic = [{ title: 'Mosaic role', company: 'Mosaic Co', location: 'Toronto, ON', jobkey: 'b36bd069f99d6c51', snippet: 'D'.repeat(500) }];
      const html = `<html><body>
        <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { results: [next] } } })}</script>
        <div class="job_seen_beacon" data-jk="cbf351c41691bab3"><h2 class="jobTitle"><a href="/rc/clk?jk=cbf351c41691bab3">DOM role</a></h2><span data-testid="company-name">DOM Co</span><div data-testid="text-location">Toronto, ON</div><div data-testid="job-snippet">${'D'.repeat(500)}</div></div>
        <div class="job_seen_beacon" data-jk="890abcdef0123456"><h2 class="jobTitle"><a href="/rc/clk?jk=890abcdef0123456">Synthetic DOM filler</a></h2><span data-testid="company-name">Template Co</span><div data-testid="text-location">Toronto, ON</div></div>
      </body></html>`;
      const jobs = extractIndeedJobsFromHtml(html, mosaic);
      const paths = new Map(jobs.map(job => [job.jobkey, job._extractPath]));
      assert(paths.get(next.jobkey) === 'nextData', 'NEXT_DATA listing must retain nextData provenance');
      assert(paths.get(mosaic[0].jobkey) === 'mosaic', 'window mosaic listing must retain mosaic provenance');
      assert(paths.get('cbf351c41691bab3') === 'dom', 'DOM-only listing must retain dom provenance');
      assert(!paths.has('890abcdef0123456'), 'placeholder-shaped DOM card must be rejected before merge');
      return { count: jobs.length, paths: Object.fromEntries(paths) };
    },
  },
{
    name: 'Indeed enrichment diagnostics: per-job attempt trail is bounded',
    run: () => {
      const job = {};
      for (let i = 0; i < 6; i++) recordIndeedEnrichmentAttempt(job, { stage: `stage-${i}`, outcome: 'blank', length: i });
      assert(job._enrichAttempts.length === 4, `expected four bounded attempt records, got ${job._enrichAttempts.length}`);
      assert(job._enrichAttempts[0].stage === 'stage-2' && job._enrichAttempts[3].length === 5,
        'attempt trail must retain the newest bounded diagnostics in order');
      return { attempts: job._enrichAttempts.length };
    },
  },
{
    // Guards the same phantom problem as the test above via an INDEPENDENT
    // structural signal (no description at all), end-to-end through the real
    // extraction pipeline: a __NEXT_DATA__ payload carrying a real described
    // row, a same-title+company undescribed duplicate (must collapse away),
    // two genuinely distinct described postings sharing a title+company (must
    // both survive), and a placeholder-id phantom (must be rejected and
    // counted).
    name: 'Indeed extraction: placeholder ids are rejected and description-less duplicates collapse without erasing distinct postings',
    run: () => {
      const results = [
        { title: 'DevOps Manager', company: 'CirrusLabs North Inc.', jobkey: 'b36bd069f99d6c51', location: 'Remote', snippet: 'Full job description text for the real posting goes here.' },
        { title: 'DevOps Manager', company: 'CirrusLabs North Inc.', jobkey: 'df5300d5ae5f3472', location: 'Remote' },
        { title: 'Full Stack Developer', company: 'MetricAid', jobkey: '9d7a8b67591b2443', location: 'City A', snippet: 'Description one for req A.' },
        { title: 'Full Stack Developer', company: 'MetricAid', jobkey: 'ffb46192a788b229', location: 'City B', snippet: 'Description two for req B, different city.' },
        { title: 'Senior / Principal Software Engineer', company: 'Soma Energy', jobkey: 'cbf351c41691bab3', location: 'Austin, TX', snippet: 'Real description for the genuine posting.' },
        { title: 'Senior / Principal Software Engineer', jobkey: 'cdef0123456789ab' },
      ];
      const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { results } } })}</script></body></html>`;
      const jobs = extractIndeedJobsFromHtml(html);
      assert(jobs.length === 4, `expected 4 surviving jobs (1 described-wins pair + 2 distinct-postings pair + 1 real), got ${jobs.length}`);
      const byKey = new Map(jobs.map(j => [j.jobkey, j]));
      assert(byKey.has('b36bd069f99d6c51') && !byKey.has('df5300d5ae5f3472'),
        'the described CirrusLabs row must survive and its undescribed same-title+company duplicate must collapse away');
      assert(byKey.has('9d7a8b67591b2443') && byKey.has('ffb46192a788b229'),
        'two distinct DESCRIBED postings that merely share a title+company must both be kept, not collapsed');
      assert(byKey.has('cbf351c41691bab3') && !byKey.has('cdef0123456789ab'),
        'the real Soma Energy row must survive; its placeholder-id phantom must never reach the output');
      assert(jobs.rejectedPlaceholderCount === 1, `expected exactly 1 rejected placeholder, got ${jobs.rejectedPlaceholderCount}`);
      return { count: jobs.length, rejectedPlaceholderCount: jobs.rejectedPlaceholderCount };
  },
},
{
    // JSON legitimately contains more results than the visible card list on
    // some Indeed responses.  Only the already-suspicious zero-description
    // shape may be DOM-gated: a described JSON-only record must survive, a
    // description-less record with an exact DOM card must survive, and the
    // same weak shape with no card must be rejected.
    name: 'Indeed extraction: only description-less JSON records require a DOM anchor',
    run: () => {
      const results = [
        { title: 'JSON-only described role', company: 'Data North', jobkey: '2136516a5da5d5e0', location: 'Toronto, ON', snippet: 'A complete posting description that is intentionally JSON-only.' },
        { title: 'DOM-anchored weak role', company: 'Data North', jobkey: 'b36bd069f99d6c51', location: 'Toronto, ON' },
        { title: 'Unanchored weak role', company: 'Data North', jobkey: 'cbf351c41691bab3', location: 'Toronto, ON' },
      ];
      const html = `<html><body>
        <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { results } } })}</script>
        <div class="job_seen_beacon" data-jk="b36bd069f99d6c51">
          <h2 class="jobTitle"><a href="/rc/clk?jk=b36bd069f99d6c51">DOM-anchored weak role</a></h2>
          <span data-testid="company-name">Data North</span>
          <div data-testid="text-location">Toronto, ON</div>
        </div>
      </body></html>`;
      const jobs = extractIndeedJobsFromHtml(html);
      const byKey = new Map(jobs.map(job => [job.jobkey, job]));
      assert(byKey.has('2136516a5da5d5e0'),
        'a described JSON-only Indeed record must stay even when it has no DOM card');
      assert(byKey.has('b36bd069f99d6c51'),
        'a description-less JSON record must stay when the same listing appears in the DOM');
      assert(!byKey.has('cbf351c41691bab3'),
        'a description-less JSON-only record with no DOM anchor must be rejected as suspicious');
      assert(jobs.rejectedUnanchoredDescriptionlessCount === 1,
        `expected 1 rejected unanchored description-less JSON record, got ${jobs.rejectedUnanchoredDescriptionlessCount}`);
      return { count: jobs.length, rejectedUnanchoredDescriptionlessCount: jobs.rejectedUnanchoredDescriptionlessCount };
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
      assert(normal.includes('rerunOutcome') && normal.includes('rerunNotice'), 'Transient jobhub save rules: zero-new rerun notice should be session-only');
      assert(!sourcesReady.includes('scrapeWarnings'), 'Transient jobhub save rules: sources-ready should preserve scrapeWarnings');
      assert(sourcesReady.includes('errorMessage') && sourcesReady.includes('isRateLimit') && sourcesReady.includes('rerunNotice'), 'Transient jobhub save rules: sources-ready should still strip banners/notices');
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
        { id: 'hub', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'queued', queuedModuleRun: { position: 1 }, pendingJobs: [1], scrapeWarnings: [2], errorMessage: 'old', rerunOutcome: 'no-new-results', rerunNotice: 'old notice' } },
        { id: 'reanalyzing-hub', type: 'jobhub', position: { x: 0, y: 3 }, data: { hubState: 'scoring', queuedModuleRun: { position: 1 }, pendingJobs: [1], scrapeWarnings: [2], scoredJobs: [{ title: 'Saved result' }], resultCount: 1 } },
        { id: 'job', type: 'jobcard', position: { x: 1, y: 1 }, style: { opacity: 0.3, width: 180 }, data: { title: 'A', isDropTarget: true } },
        { id: 'paused-hub', type: 'jobhub', position: { x: 9, y: 9 }, data: { hubState: 'sources-ready', pendingJobs: [1], scrapeWarnings: [{ sourceId: 'indeed' }] } },
        { id: 'clean-source', type: 'jobsourcecard', position: { x: 2, y: 2 }, data: { persistedProgress: { status: 'done' } } },
        { id: 'blocked-source', type: 'jobsourcecard', position: { x: 3, y: 3 }, data: { persistedProgress: { status: 'error', warning: { code: 'captcha' } } } },
        // Warned cards persist ONLY when their hub keeps its run context across
        // the reload: a mid-run hub resets to 'empty' (its warned cards would
        // orphan Solve buttons), and a deleted hub leaves nothing to act on.
        { id: 'paused-blocked-source', type: 'jobsourcecard', position: { x: 5, y: 5 }, data: { hubId: 'paused-hub', persistedProgress: { status: 'error', warning: { code: 'captcha' } } } },
        { id: 'midrun-blocked-source', type: 'jobsourcecard', position: { x: 6, y: 6 }, data: { hubId: 'hub', persistedProgress: { status: 'error', warning: { code: 'captcha' } } } },
        { id: 'orphan-blocked-source', type: 'jobsourcecard', position: { x: 7, y: 7 }, data: { hubId: 'deleted-hub', persistedProgress: { status: 'error', warning: { code: 'captcha' } } } },
        { id: 'marketplace-note', type: 'marketplacecard', position: { x: 8, y: 8 }, data: { platformId: 'ebay', notes: 'Lower price on Monday' } },
        { id: 'group', type: 'group', position: { x: 4, y: 4 }, data: { isDropTarget: true, canvasData: { nodes: [
          { id: 'inner-job', type: 'jobcard', position: { x: 0, y: 0 }, style: { opacity: 0.1 }, data: { title: 'Inner' } },
          { id: 'inner-reanalyzing-hub', type: 'jobhub', position: { x: 0, y: 2 }, data: { hubState: 'scoring', pendingJobs: [1], scoredJobs: [{ title: 'Nested saved result' }] } },
        ], edges: [], drawings: [] } } },
      ];
      const sanitized = sanitizeNodesForSave(nodes);
      const hub = sanitized.find(n => n.id === 'hub');
      const reanalyzingHub = sanitized.find(n => n.id === 'reanalyzing-hub');
      const job = sanitized.find(n => n.id === 'job');
      assert(hub.data.hubState === 'empty', 'Serialization sanitizes transient state: active jobhub should reset to empty');
      assert(!('pendingJobs' in hub.data) && !('scrapeWarnings' in hub.data) && !('queuedModuleRun' in hub.data) && !('rerunOutcome' in hub.data) && !('rerunNotice' in hub.data), 'Serialization sanitizes transient state: jobhub transient buffers/notices should be stripped');
      assert(reanalyzingHub.data.hubState === 'done' && reanalyzingHub.data.scoredJobs.length === 1
        && !('pendingJobs' in reanalyzingHub.data) && !('scrapeWarnings' in reanalyzingHub.data) && !('queuedModuleRun' in reanalyzingHub.data),
      'Serialization restores interrupted re-analysis to done while stripping its transient buffers');
      assert(!('isDropTarget' in job.data) && job.style.opacity === undefined && job.style.width === 180, 'Serialization sanitizes transient state: node transient UI state should be stripped');
      assert(!sanitized.some(n => n.id === 'clean-source'), 'Serialization sanitizes transient state: clean source card should be dropped');
      assert(sanitized.some(n => n.id === 'blocked-source'), 'Serialization sanitizes transient state: blocked source card should persist');
      assert(sanitized.some(n => n.id === 'paused-blocked-source'), 'Serialization: warned card of a sources-ready hub persists (Solve/Skip recovery)');
      assert(!sanitized.some(n => n.id === 'midrun-blocked-source'), 'Serialization: warned card of a mid-run hub (resets to empty) is dropped, not orphaned');
      assert(!sanitized.some(n => n.id === 'orphan-blocked-source'), 'Serialization: warned card whose hub is gone is dropped');
      const pausedHub = sanitized.find(n => n.id === 'paused-hub');
      assert(pausedHub.data.hubState === 'sources-ready' && Array.isArray(pausedHub.data.pendingJobs), 'Serialization: sources-ready hub keeps its paused run context');
      assert(sanitized.find(n => n.id === 'marketplace-note').data.notes === 'Lower price on Monday', 'Serialization: marketplace listing notes should persist');
      assert(sanitized.find(n => n.id === 'group').data.canvasData.nodes[0].style === undefined, 'Serialization sanitizes transient state: nested nodes should be sanitized');
      const nestedReanalyzingHub = sanitized.find(n => n.id === 'group').data.canvasData.nodes.find(n => n.id === 'inner-reanalyzing-hub');
      assert(nestedReanalyzingHub.data.hubState === 'done' && nestedReanalyzingHub.data.scoredJobs.length === 1 && !('pendingJobs' in nestedReanalyzingHub.data),
        'Serialization restores interrupted re-analysis in nested canvases too');
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
      const loadedSignature = persistenceContentFingerprint({ nodes: migrated, edges: [], drawings: [] });
      const runtimeOnlyChange = [{
        ...migrated[0],
        selected: true,
        measured: { width: 240, height: 180 },
      }];
      assert(
        persistenceContentFingerprint({ nodes: runtimeOnlyChange, edges: [], drawings: [] }) === loadedSignature,
        'Persistence fingerprint: ReactFlow selection/measurement state should not make a loaded canvas dirty'
      );
      const nestedTextEdit = [{
        ...migrated[0],
        data: {
          ...migrated[0].data,
          canvasData: {
            ...migrated[0].data.canvasData,
            nodes: migrated[0].data.canvasData.nodes.map((node) => ({
              ...node,
              data: { ...node.data, text: 'B' },
            })),
          },
        },
      }];
      assert(
        persistenceContentFingerprint({ nodes: nestedTextEdit, edges: [], drawings: [] }) !== loadedSignature,
        'Persistence fingerprint: a nested edit that preserves node/edge/drawing counts must remain dirty'
      );
      assert(nextSearchMatchIndex(0, -1, 3) === 3, 'Search navigation: initial previous should wrap to the final match');
      assert(nextSearchMatchIndex(0, 1, 3) === 1, 'Search navigation: initial next should start at the first match');
      return { migratedNodes: migrated[0].data.canvasData.nodes.length };
    },
  },
{
    name: 'Document text reload waits for in-flight writes before reading disk',
    run: () => {
      // DocumentNode is JSX and is not imported by this Node-only runner, so
      // keep a focused source contract around the ordering that prevents the
      // reload/read -> late-write race.
      const source = fs.readFileSync(path.resolve('src/nodes/DocumentNode.jsx'), 'utf8');
      const start = source.indexOf('const handleReloadFromDisk');
      const end = source.indexOf('const handleKeepEdits', start);
      const handler = start >= 0 && end > start ? source.slice(start, end) : '';
      const barrierIndex = handler.indexOf('await writeBarrier');
      const fetchIndex = handler.indexOf('await fetch(');
      assert(
        barrierIndex >= 0 && fetchIndex > barrierIndex,
        'Document text reload: the existing write chain must settle before disk is fetched'
      );
      assert(
        handler.includes('gen !== loadGenerationRef.current')
          && handler.includes('filePathRef.current !== reloadPath')
          && handler.includes('!isMountedRef.current'),
        'Document text reload: stale generation, relink, and unmount guards must protect the re-read'
      );
      return { writeBarrierBeforeFetch: true };
    },
  },
{
    name: 'Document watcher reconciles own and external writes after the write chain',
    run: () => {
      const source = fs.readFileSync(path.resolve('src/nodes/DocumentNode.jsx'), 'utf8');
      const start = source.indexOf('// When the file watcher fires');
      const end = source.indexOf('// Collapsing an expanded text node', start);
      const watcher = start >= 0 && end > start ? source.slice(start, end) : '';
      const barrierIndex = watcher.indexOf('await writeBarrier');
      const fetchIndex = watcher.indexOf('await fetch(');
      assert(
        barrierIndex >= 0 && fetchIndex > barrierIndex,
        'Document watcher: disk reconciliation must wait for the current write chain'
      );
      assert(
        !watcher.includes('activeWritePathRef.current === filePath) return')
          && watcher.includes('lastSettledWriteRef.current')
          && watcher.includes('reflectsOwnWrite')
          && watcher.includes('setExternalChange(true)'),
        'Document watcher: own writes should be classified without dropping genuine external changes'
      );
      assert(
        watcher.includes('draftRevision !== latestDraftRevisionRef.current')
          && watcher.includes('filePathRef.current === watchedPath')
          && watcher.includes('isMountedRef.current')
          && watcher.includes('gen === loadGenerationRef.current'),
        'Document watcher: reconciliation must guard draft, path, mount, and generation changes'
      );
      return { deferredReconciliation: true };
    },
  },
{
    name: 'Document watcher suspends pending and queued writes until classification',
    run: () => {
      const source = fs.readFileSync(path.resolve('src/nodes/DocumentNode.jsx'), 'utf8');
      const watcherStart = source.indexOf('// When the file watcher fires');
      const watcherEnd = source.indexOf('// Collapsing an expanded text node', watcherStart);
      const watcher = watcherStart >= 0 && watcherEnd > watcherStart
        ? source.slice(watcherStart, watcherEnd)
        : '';
      const writeStart = source.indexOf('const writeToDisk');
      const writeEnd = source.indexOf('// When the file watcher fires', writeStart);
      const writeToDiskSource = writeStart >= 0 && writeEnd > writeStart
        ? source.slice(writeStart, writeEnd)
        : '';
      const cancelIndex = watcher.indexOf('clearTimeout(saveTimerRef.current)');
      const barrierIndex = watcher.indexOf('await writeBarrier');
      assert(
        cancelIndex >= 0 && barrierIndex > cancelIndex
          && watcher.includes('pendingWriteRef.current = null')
          && watcher.includes('discardedThroughRevisionRef.current = Math.max'),
        'Document watcher suspension: debounce and queued revisions must be stopped before the write barrier'
      );
      assert(
        writeToDiskSource.includes("watcherWriteSuspensionRef.current?.filePath === filePath")
          && writeToDiskSource.includes('do not arm a timer'),
        'Document watcher suspension: edits during reconciliation must remain timer-free'
      );
      assert(
        watcher.includes('if (reflectsOwnWrite || convergedWithDraft)')
          && watcher.includes('writeToDisk(currentDraft)')
          && watcher.includes('Reload and Keep Mine'),
        'Document watcher suspension: only own/converged classification may resume the draft'
      );
      return { pendingWritesSuspended: true };
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
    // Application generation uses the same renderer-side queue as the other
    // expensive AI workflows.  Keep this test application-shaped rather than
    // merely testing queue length: each card owns its own marker, a deleted
    // waiting card clears only itself, and a failed active run releases the
    // next card.  That is the contract the JobCard callbacks rely on.
    name: 'Application generation queue is FIFO, cancellation-safe, failure-safe, and keeps card markers isolated',
    run: async () => {
      const queue = createModuleRunQueue();
      const markers = new Map();
      const starts = [];
      const callbacksFor = (nodeId) => ({
        onQueued: ({ position }) => markers.set(nodeId, `Queued · #${position}`),
        onQueueUpdate: ({ position }) => markers.set(nodeId, `Queued · #${position}`),
        onStart: () => {
          starts.push(nodeId);
          markers.set(nodeId, 'Generating…');
        },
        onFinish: () => markers.set(nodeId, null),
        onCancel: () => markers.set(nodeId, null),
      });

      const a = await queue.acquireModuleRun({
        nodeId: 'application-card-a', kind: 'application', label: 'Application: A', ...callbacksFor('application-card-a'),
      });
      const bPromise = queue.acquireModuleRun({
        nodeId: 'application-card-b', kind: 'application', label: 'Application: B', ...callbacksFor('application-card-b'),
      });
      const cPromise = queue.acquireModuleRun({
        nodeId: 'application-card-c', kind: 'application', label: 'Application: C', ...callbacksFor('application-card-c'),
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      assert(queue.getSnapshot().active?.nodeId === 'application-card-a', 'first application starts immediately');
      assert(queue.getSnapshot().queued.map(entry => entry.nodeId).join(',') === 'application-card-b,application-card-c', 'later applications wait in click order');
      assert(markers.get('application-card-a') === 'Generating…', 'active card has only its active marker');
      assert(markers.get('application-card-b') === 'Queued · #1' && markers.get('application-card-c') === 'Queued · #2', 'each waiting card receives its own queue position');

      const cancelled = queue.cancelQueuedRunsForNode('application-card-b', 'Card deleted');
      const cancelError = await bPromise.catch(error => error?.message || String(error));
      assert(cancelled === 1 && cancelError === 'Card deleted', 'deleting one queued card cancels only that application');
      assert(markers.get('application-card-b') === null, 'cancelled card marker is cleared');
      assert(markers.get('application-card-c') === 'Queued · #1', 'remaining card marker is renumbered without being cleared by another card');

      a.release();
      const c = await cPromise;
      assert(starts.join(',') === 'application-card-a,application-card-c', `remaining application starts after active release (${starts.join(',')})`);
      assert(markers.get('application-card-a') === null && markers.get('application-card-c') === 'Generating…', 'finishing one card never corrupts another card marker');
      c.release();
      assert(markers.get('application-card-c') === null && queue.getSnapshot().active === null, 'last application releases its marker and drains the queue');

      const rejected = queue.runExclusive({
        nodeId: 'application-card-fail', kind: 'application', label: 'Application: failure', ...callbacksFor('application-card-fail'),
      }, async () => {
        throw new Error('generation failed');
      });
      const recovered = queue.runExclusive({
        nodeId: 'application-card-after-fail', kind: 'application', label: 'Application: recovered', ...callbacksFor('application-card-after-fail'),
      }, async () => 'generated');
      const failure = await rejected.catch(error => error?.message || String(error));
      assert(failure === 'generation failed' && await recovered === 'generated', 'a rejected generation releases the next queued application');
      assert(markers.get('application-card-fail') === null && markers.get('application-card-after-fail') === null, 'rejection path leaves no stale card marker');

      // The lease must cover the durable save too.  If it were released after
      // the model call but before saveApplication, the next card could start
      // and race the first card's output/folder work.
      const lifecycle = [];
      let finishFirstSave;
      const firstSaveGate = new Promise(resolve => { finishFirstSave = resolve; });
      const first = queue.runExclusive({ nodeId: 'application-card-save-a', kind: 'application', label: 'Application: save A' }, async () => {
        lifecycle.push('A-generate');
        await firstSaveGate;
        lifecycle.push('A-save');
      });
      const second = queue.runExclusive({ nodeId: 'application-card-save-b', kind: 'application', label: 'Application: save B' }, async () => {
        lifecycle.push('B-generate');
        lifecycle.push('B-save');
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert(lifecycle.join(',') === 'A-generate', `second application must not begin before the first save settles (${lifecycle.join(',')})`);
      finishFirstSave();
      await Promise.all([first, second]);
      assert(lifecycle.join(',') === 'A-generate,A-save,B-generate,B-save', `application lease spans generation plus save (${lifecycle.join(',')})`);
      return { starts: starts.length, cancellationSafe: true, rejectionSafe: true };
  },
},
{
    name: 'Application workspace discard capability requires the exact registered path and sender',
    run: () => {
      const workDir = path.resolve('/tmp', 'jobapp-discard-capability-fixture');
      const pending = { senderId: 41, resumeHtmlPath: path.join(workDir, 'application.html') };
      const records = new Map([[workDir, pending]]);

      const owned = resolvePendingApplicationWorkspaceForOwner(workDir, records, 41);
      assert(owned.resolvedWorkDir === workDir && owned.pending === pending, 'exact owner resolves its registered workspace');

      let foreignError = '';
      try { resolvePendingApplicationWorkspaceForOwner(workDir, records, 42); }
      catch (error) { foreignError = error?.message || String(error); }
      assert(foreignError.includes('different window') && records.get(workDir) === pending,
        'a different renderer cannot resolve or remove another sender\'s workspace');

      let arbitraryError = '';
      try { resolvePendingApplicationWorkspaceForOwner('/tmp/not-a-registered-application', records, 41); }
      catch (error) { arbitraryError = error?.message || String(error); }
      assert(arbitraryError.includes('no longer available') && records.size === 1,
        'an arbitrary client path cannot become a cleanup target');
      return { senderBound: true, exactRegistrationRequired: true };
    },
},
{
    // This project deliberately keeps node components free of a heavyweight
    // DOM test harness.  Lock the integration seams down here instead: these
    // are the ordering and guard invariants that cannot be established by the
    // generic queue unit test alone.
    name: 'Job Card application integration acquires before mutable reads, releases after local handoff, and guards duplicate/deleted calls',
    run: () => {
      const source = fs.readFileSync(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const indexOf = (needle) => source.indexOf(needle);
      const generationStart = indexOf('const generateApplication = useCallback');
      const generationEnd = indexOf('\n  return (', generationStart);
      const generationScope = source.slice(generationStart, generationEnd);
      const generationIndexOf = (needle) => generationStart + generationScope.indexOf(needle);
      const latchGuard = generationIndexOf('applicationSubmissionRef.current || hasApplicationRun || localJobPending) return;');
      const latchSet = generationIndexOf('applicationSubmissionRef.current = true;');
      const acquire = generationIndexOf('lease = await acquireModuleRun({');
      const currentCanvasRead = generationIndexOf('const canvasFilePath = nav?.getCurrentFile ? nav.getCurrentFile() : nav?.currentFile ?? null;');
      const originRead = generationIndexOf('const originHub = getNode(originHubId);');
      const queueIpc = generationIndexOf('await window.electronAPI.queueLocalApplication({');
      const release = generationIndexOf('lease?.release();');
      const canvasSource = fs.readFileSync(path.resolve('src/Canvas.jsx'), 'utf8');
      const applicationIpcSource = fs.readFileSync(path.resolve('electron/ipc/jobApplication.js'), 'utf8');
      const localApplicationIpcSource = fs.readFileSync(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      const preloadSource = fs.readFileSync(path.resolve('electron/preload.js'), 'utf8');

      assert(latchGuard >= 0 && latchSet > latchGuard && acquire > latchSet,
        'a synchronous per-card latch must reject duplicate clicks before a queue lease is requested');
      assert(acquire >= 0 && currentCanvasRead > acquire && originRead > currentCanvasRead,
        'queued cards must re-read the current canvas path, career data, and achievement cache after owning their FIFO lease');
      assert(source.includes('nav?.getCurrentFile ? nav.getCurrentFile() : nav?.currentFile'),
        'a null latest canvas path must not fall back to a stale closure-captured path while queued');
      assert(generationScope.includes('queueLocalApplication({')
        && generationScope.includes('canvasFilePath,'),
      'a Local AI handoff must receive the post-lease saved canvas path, so its job folder is canvas-local');
      assert(source.includes('getLocalApplicationStatus({ jobId, canvasFilePath })')
        && source.includes('canvasFilePath: queuedCanvasFilePath || canvasFilePath')
        && source.includes('expectedResultSha256')
        && source.includes('openLocalApplicationFolder({ jobId: localApplication.id, canvasFilePath })'),
      'poll, import, and open operations must keep using the canvas path that owns the queued job');
      assert(queueIpc > originRead && release > queueIpc,
        'the lease must cover creation of the durable local handoff, then release after the queue write settles');
      assert(!generationScope.includes('generateApplication({') && !generationScope.includes('saveApplication({'),
        'Application Generate must never enter the retired remote generation/save path');
      assert(source.includes("kind: 'application'") && source.includes('onQueued: ({ position })')
        && source.includes('onQueueUpdate: ({ position })') && source.includes('Queued · #${displayedApplicationRun.position}'),
      'queued applications must have an application identity and an isolated visible queue position');
      assert(source.includes('snapshot: moduleRunSnapshot') && source.includes('const displayedApplicationRun = queuedApplicationRun')
        && source.includes('const hasApplicationRun = displayedApplicationRun.state !== \'idle\';')
        && source.includes('applicationSubmissionRef.current || hasApplicationRun || localJobPending')
        && source.includes('disabled={hasApplicationRun || localJobPending || !!data.locked}'),
      'the global queue snapshot must keep a remounted card visibly disabled and synchronously reject a duplicate enqueue');
      assert(canvasSource.includes('const getCurrentFile = useCallback(() => currentFileRef.current, []);')
        && canvasSource.includes('currentFile, getCurrentFile'),
      'Canvas navigation must expose a stable latest-file accessor for queued Save As operations');
      assert(!generationScope.includes('if (!isMountedRef.current) return;')
        && generationScope.includes('if (!getLiveJobCard(idRef.current)) {')
        && generationScope.includes('const expectedPriorLocalApplication = getLiveJobCard(idRef.current)?.data?.localApplication || null;')
        && generationScope.includes('const settlement = queuedLocalApplicationSettlement(')
        && generationScope.includes('expectedPriorLocalApplication,')
        && generationScope.includes('discardLocalApplication'),
      'a hidden-but-extant card must persist or deliberately replace its durable handoff globally, while an actually deleted or superseded card discards that exact handoff');
      assert(source.includes("cancelQueuedRunsForNode(id, 'Job card dismissed before generation started')")
        && source.includes('if (!getLiveJobCard(idRef.current))') && source.includes('cancelledBeforeStart = true;'),
      'a removed queued card must be cancelled or rejected at turn start before it can invoke generation IPC');
      assert(source.includes('Additional notes for AI')
        && source.includes('additionalNotes: additionalNotes.trim()')
        && source.includes('updateGlobal(id, { additionalNotes: additionalNotes.trim() })')
        && localApplicationIpcSource.includes('normalizeApplicationAdditionalNotes(args.additionalNotes)'),
      'job-specific applicant notes must persist on the card, reach the local handoff, and stay bounded at IPC');
      assert(!preloadSource.includes("ipcRenderer.invoke('generate-application'")
        && !applicationIpcSource.includes("handleSafe('generate-application'"),
      'remote application generation must not be exposed through preload or registered in the main process');
      return { lifecycleOrdered: true, remountSafe: true, currentCanvasAtLease: true, hiddenCardContinues: true, localOnly: true };
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
          notes: 'Lower price on Monday',
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

      const notesEdited = { ...checked, data: { ...checked.data, notes: 'Buyer asked about accessories' } };
      assert(
        fingerprint({ nodes: [base], edges: [], drawings: [] }) !== fingerprint({ nodes: [notesEdited], edges: [], drawings: [] }),
        'Undo fingerprints ignore marketplace status checks: user note edits should remain undoable'
      );

      const liveEdited = {
        ...checked,
        data: {
          ...checked.data,
          listingUrl: edited.data.listingUrl,
          notes: notesEdited.data.notes,
        },
      };
      const restored = mergeNonRestorableNodeDataFromLive([base], [liveEdited]);
      assert(restored[0].data.listingUrl === base.data.listingUrl, 'Undo restore should still restore undoable listing URL data');
      assert(restored[0].data.notes === base.data.notes, 'Undo restore should still restore user-authored listing notes');
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
    // A jobhub saved mid-parse had its hubState rewritten to 'empty' while
    // inputLocked survived, so it reloaded refusing new drops, claiming
    // "Career files retained" with nothing retained, and hiding its Re-run
    // button (no resumeProfile) — unrecoverable except by deleting the module.
    name: 'migrateStaleJobHubInputLock (v5): a preflight lock with no career input behind it is cleared',
    run: () => {
      const stranded = { id: 'h1', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', inputLocked: true, targetRole: 'System Architect', preferredLocation: 'Canada' } };
      const parsed = { id: 'h2', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'done', inputLocked: true, resumeProfile: { skills: [] } } };
      const withPaths = { id: 'h3', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', inputLocked: true, careerFilePaths: ['/tmp/cv.pdf'] } };
      const unlocked = { id: 'h4', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty' } };
      const nonJobhub = { id: 'sell', type: 'sellhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', inputLocked: true } };
      const nodes = [stranded, parsed, withPaths, unlocked, nonJobhub];

      const out = migrateStaleJobHubInputLock(nodes);
      assert(out !== nodes, 'migration: a stranded lock was present → new array ref');
      const healed = out.find(n => n.id === 'h1');
      assert(!('inputLocked' in healed.data), 'migration: a lock with no career input behind it is removed, not left false');
      assert(healed.data.targetRole === 'System Architect' && healed.data.preferredLocation === 'Canada',
        'migration: the hub keeps every configured field — only the stranded lock goes');
      assert(out.find(n => n.id === 'h2') === parsed,
        'migration: a hub that really parsed a profile stays locked (same ref) — its lock is backed by real career data');
      assert(out.find(n => n.id === 'h3') === withPaths,
        'migration: retained career file paths are career input, so that lock is genuine (same ref)');
      assert(out.find(n => n.id === 'h4') === unlocked, 'migration: an unlocked hub has nothing to migrate (same ref)');
      assert(out.find(n => n.id === 'sell') === nonJobhub,
        'migration: a sellhub carrying the same-shaped flag is never touched — the gate is type==="jobhub"');

      const out2 = migrateStaleJobHubInputLock(out);
      assert(out2 === out, 'migration: idempotent — a second run over already-migrated nodes is a same-ref no-op');

      assert(CURRENT_SCHEMA_VERSION >= 5, 'migration: schema version advanced to include the stranded-lock clear');
      const nested = runNodeMigrations([{
        id: 'grp-lock', type: 'group', position: { x: 0, y: 0 },
        data: { canvasData: { nodes: [{ id: 'inner', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', inputLocked: true } }] } },
      }], 4);
      assert(!('inputLocked' in nested[0].data.canvasData.nodes[0].data),
        'migration: the runner reaches a stranded hub nested inside a group sub-canvas');

      // The healed hub is droppable again — the whole point of the migration.
      assert(canHubAcceptInitialDrop({ type: 'jobhub', data: healed.data }),
        'migration: after healing, the hub accepts a fresh career-file drop instead of dead-ending');
      return { strandedCleared: true, genuineLocksKept: true };
    },
  },
  {
    name: 'migrateInterruptedJobHubResults (v6): a pre-v6 re-analysis saved as empty restores its done card',
    run: () => {
      const interrupted = { id: 'h1', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', resumeProfile: { skills: ['React'] }, scoredJobs: [{ title: 'Saved role' }] } };
      const noCareerIdentity = { id: 'h2', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', scoredJobs: [{ title: 'Orphaned role' }] } };
      const noResults = { id: 'h3', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', resumeProfile: { skills: ['React'] }, scoredJobs: [] } };
      const nested = { id: 'group', type: 'group', position: { x: 0, y: 0 }, data: { canvasData: { nodes: [
        { id: 'inner', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'empty', careerData: 'Career evidence', scoredJobs: [{ title: 'Nested saved role' }] } },
      ], edges: [], drawings: [] } } };
      const direct = migrateInterruptedJobHubResults([interrupted, noCareerIdentity, noResults]);
      assert(direct.find(n => n.id === 'h1').data.hubState === 'done',
        'migration restores the exact empty + scored results + career identity shape');
      assert(direct.find(n => n.id === 'h2') === noCareerIdentity && direct.find(n => n.id === 'h3') === noResults,
        'migration does not promote orphaned results or genuinely empty hubs');
      const viaRunner = runNodeMigrations([nested], 5);
      assert(viaRunner[0].data.canvasData.nodes[0].data.hubState === 'done',
        'v6 runner applies the recovery recursively to group sub-canvases');
      assert(CURRENT_SCHEMA_VERSION >= 6
        && runNodeMigrations(viaRunner, CURRENT_SCHEMA_VERSION) === viaRunner,
      'migration advances the schema and is a no-op for an already-current workspace');
      return { schema: CURRENT_SCHEMA_VERSION, restored: 2 };
    },
  },
  {
    name: 'sanitizeNodesForSave: a mid-parse jobhub does not persist its preflight drop lock',
    run: () => {
      const midParse = [{ id: 'h1', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'parsing', inputLocked: true, targetRole: 'System Architect' } }];
      const saved = sanitizeNodesForSave(midParse)[0];
      assert(saved.data.hubState === 'empty', 'save: a transient processing state is rewritten to empty');
      assert(!('inputLocked' in saved.data),
        'save: the preflight lock must not outlive the hubState that justified it — keeping it strands the hub');
      assert(saved.data.targetRole === 'System Architect', 'save: configured fields survive the strip');
      assert(canHubAcceptInitialDrop({ type: 'jobhub', data: saved.data }),
        'save: the reloaded hub can accept career files again');

      // A hub that finished parsing stays locked on its real career data.
      const parsed = sanitizeNodesForSave([{ id: 'h2', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'done', inputLocked: true, resumeProfile: { skills: [] } } }])[0];
      assert(!canHubAcceptInitialDrop({ type: 'jobhub', data: parsed.data }),
        'save: stripping the flag never unlocks a hub whose resumeProfile already binds it');
      return { lockNotPersisted: true };
    },
  },
{
    name: 'migrateJobHubPageCeiling (v4): retired 10-page default resets to "All", explicit/already-null values are left alone',
    run: () => {
      const withOldDefault = { id: 'h1', type: 'jobhub', position: { x: 0, y: 0 }, data: { collectionLimits: { jobsPerPlatform: null, pagesPerPlatform: 10 } } };
      const withExplicit25 = { id: 'h2', type: 'jobhub', position: { x: 0, y: 0 }, data: { collectionLimits: { jobsPerPlatform: null, pagesPerPlatform: 25 } } };
      const withAlreadyNull = { id: 'h3', type: 'jobhub', position: { x: 0, y: 0 }, data: { collectionLimits: { jobsPerPlatform: null, pagesPerPlatform: null } } };
      const nonJobhub = { id: 'txt', type: 'text', position: { x: 0, y: 0 }, data: { collectionLimits: { pagesPerPlatform: 10 } } };
      const nodes = [withOldDefault, withExplicit25, withAlreadyNull, nonJobhub];

      const out = migrateJobHubPageCeiling(nodes);
      assert(out !== nodes, 'migration: the retired default was present → new array ref');
      assert(out.find(n => n.id === 'h1').data.collectionLimits.pagesPerPlatform === null,
        'migration: a hub persisted with the old shipped default (10) resets to "All" (null)');
      assert(out.find(n => n.id === 'h1').data.collectionLimits.jobsPerPlatform === null,
        'migration: the untouched jobsPerPlatform field is preserved as-is');
      assert(out.find(n => n.id === 'h2') === withExplicit25,
        'migration: an explicitly-set 25 is a deliberate user value, not the shipped default — left untouched (same ref)');
      assert(out.find(n => n.id === 'h3') === withAlreadyNull,
        'migration: an already-null pagesPerPlatform has nothing to migrate — left untouched (same ref)');
      assert(out.find(n => n.id === 'txt') === nonJobhub,
        'migration: a non-jobhub node carrying the same-shaped data is never touched — the gate is type==="jobhub", not shape sniffing');

      // Idempotent: running again over the migrated output changes nothing.
      const out2 = migrateJobHubPageCeiling(out);
      assert(out2 === out, 'migration: idempotent — a second run over already-migrated nodes is a same-ref no-op');

      // Registered in the versioned runner (v4) and reaches a hub nested inside
      // a group sub-canvas via applyStepRecursive, same as every other step.
      assert(CURRENT_SCHEMA_VERSION >= 4, 'migration: schema version advanced to include the page-ceiling reset');
      const nestedTree = [{
        id: 'grp-pc', type: 'group', position: { x: 0, y: 0 },
        data: { canvasData: { nodes: [
          { id: 'nested-hub', type: 'jobhub', position: { x: 0, y: 0 }, data: { collectionLimits: { jobsPerPlatform: null, pagesPerPlatform: 10 } } },
        ], edges: [], drawings: [] } },
      }];
      const viaRunner = runNodeMigrations(nestedTree, 3);
      const nestedHub = viaRunner[0].data.canvasData.nodes[0];
      assert(nestedHub.data.collectionLimits.pagesPerPlatform === null,
        'migration: runs via runNodeMigrations from v3 and reaches a hub nested in a group sub-canvas');
      return { migrated: out.filter((n, i) => n !== nodes[i]).length };
    },
  },
{
    name: 'Price-drop reminder: createdAt migration + due math + undo isolation',
    run: () => {
      // ── createdAtMsFromCardId: real spawn ids carry a Date.now() suffix.
      const spawnMs = Date.UTC(2025, 4, 1, 12, 0, 0);
      assert(createdAtMsFromCardId(`mkt-hub-1-ebay-${spawnMs}`) === spawnMs, 'reminder: id timestamp recovered');
      assert(createdAtMsFromCardId('mkt-hub-1-ebay') === null, 'reminder: no suffix → null');
      assert(createdAtMsFromCardId('mkt-hub-1-ebay-123') === null, 'reminder: implausibly small suffix rejected');
      assert(createdAtMsFromCardId(`mkt-h-ebay-${Date.now() + 86400000 * 30}`) === null, 'reminder: future suffix rejected');

      // ── Migration v3: stamps createdAt from the id when absent, else "now".
      const cards = [
        { id: `mkt-hub-1-ebay-${spawnMs}`, type: 'marketplacecard', position: { x: 0, y: 0 }, data: { platformId: 'ebay' } },
        { id: 'mkt-legacy-nostamp', type: 'marketplacecard', position: { x: 0, y: 0 }, data: { platformId: 'mercari' } },
        { id: 'mkt-already', type: 'marketplacecard', position: { x: 0, y: 0 }, data: { platformId: 'poshmark', createdAt: '2024-02-01T00:00:00.000Z' } },
        { id: 'txt', type: 'text', position: { x: 0, y: 0 }, data: { text: 'hi' } },
      ];
      const before = Date.now();
      const migrated = migrateMarketplaceCardCreatedAt(cards);
      assert(migrated !== cards, 'reminder migration: changed → new ref');
      assert(Date.parse(migrated[0].data.createdAt) === spawnMs, 'reminder migration: createdAt recovered from id suffix');
      const fallbackMs = Date.parse(migrated[1].data.createdAt);
      assert(fallbackMs >= before && fallbackMs <= Date.now(), 'reminder migration: missing data → current date fallback');
      assert(migrated[2] === cards[2], 'reminder migration: already-stamped card untouched (same ref)');
      assert(migrated[3] === cards[3], 'reminder migration: non-marketplace node untouched');
      assert(migrateMarketplaceCardCreatedAt(migrated) === migrated, 'reminder migration: idempotent — second run is a same-ref no-op');

      // Registered in the versioned runner: a v2 file heals, a current file is free.
      const viaRunner = runNodeMigrations(cards.map(c => ({ ...c, data: { ...c.data } })), 2);
      assert(Date.parse(viaRunner.find(n => n.id === cards[0].id).data.createdAt) === spawnMs, 'reminder migration: runs via runNodeMigrations from v2');
      assert(CURRENT_SCHEMA_VERSION >= 3, 'reminder migration: schema version advanced');

      // v3 must reach cards nested inside a 'group' sub-canvas (the runner recurses
      // on type==='group' via applyStepRecursive); otherwise a nested card never
      // gets its createdAt anchor and its price-drop reminder silently never fires.
      const nestedSpawnMs = Date.UTC(2025, 2, 15, 9, 0, 0);
      const nestedTree = [{
        id: 'grp-1', type: 'group', position: { x: 0, y: 0 },
        data: { canvasData: { nodes: [
          { id: `mkt-nested-ebay-${nestedSpawnMs}`, type: 'marketplacecard', position: { x: 0, y: 0 }, data: { platformId: 'ebay' } },
        ], edges: [], drawings: [] } },
      }];
      const nestedCard = runNodeMigrations(nestedTree, 2)[0].data.canvasData.nodes[0];
      assert(Date.parse(nestedCard.data.createdAt) === nestedSpawnMs, 'reminder migration: stamps a card nested in a group sub-canvas, recovered from its id suffix');

      // ── Due math: every connected card shares a fixed cadence from the
      // oldest card's creation date; acknowledgments do not shift that cadence.
      const now = Date.now();
      const anchor = new Date(now - 2 * MS_PER_WEEK).toISOString();
      const laterCardCreatedAt = new Date(now - MS_PER_WEEK).toISOString();
      const connectedReminderCards = getConnectedHubCards({
        nodes: [
          { id: 'hub-reminder', type: 'sellhub', data: {} },
          { id: 'old-card', type: 'marketplacecard', data: { hubId: 'hub-reminder', createdAt: anchor } },
          { id: 'new-card', type: 'marketplacecard', data: { hubId: 'hub-reminder', createdAt: laterCardCreatedAt } },
          { id: 'other-card', type: 'marketplacecard', data: { hubId: 'other-hub', createdAt: '2020-01-01T00:00:00.000Z' } },
        ],
        edges: [],
        hubId: 'hub-reminder',
        cardType: 'marketplacecard',
      });
      assert(oldestPriceDropCardCreatedAtIso(connectedReminderCards) === anchor,
        'reminder scheduling: oldest connected listing card starts the shared cadence');
      assert(oldestPriceDropCardCreatedAtIso([
        { id: `mkt-legacy-ebay-${spawnMs}`, type: 'marketplacecard', data: {} },
      ]) === new Date(spawnMs).toISOString(),
      'reminder scheduling: oldest-card lookup falls back to the spawn timestamp in a legacy id');
      assert(oldestPriceDropCardCreatedAtIso([
        { id: 'future-card-without-valid-id', type: 'marketplacecard', data: { createdAt: new Date(now + MS_PER_WEEK).toISOString() } },
      ], now) === null, 'reminder scheduling: impossible future card creation timestamps are not schedule origins');
      assert(isPriceDropReminderDue({ scheduleStartedAtIso: anchor, weeks: 2, nowMs: now }) === true,
        'reminder due: shared start + interval == now fires (inclusive)');
      assert(isPriceDropReminderDue({ scheduleStartedAtIso: laterCardCreatedAt, weeks: 2, nowMs: now }) === false,
        'reminder due: a newer card would not be due on its own, proving the oldest-card origin changes its timing');
      assert(isPriceDropReminderDue({ scheduleStartedAtIso: anchor, weeks: 2.5, nowMs: now }) === false,
        'reminder due: decimal interval not yet elapsed');
      assert(isPriceDropReminderDue({ scheduleStartedAtIso: anchor, weeks: 1.5, nowMs: now }) === true,
        'reminder due: elapsed shared cadence step fires');
      assert(isPriceDropReminderDue({ scheduleStartedAtIso: anchor, weeks: 0, nowMs: now }) === false,
        'reminder due: weeks=0 → reminders off');
      assert(isPriceDropReminderDue({ scheduleStartedAtIso: null, weeks: 2, nowMs: now }) === false,
        'reminder due: missing shared start → never fires');
      assert(normalizePriceDropReminderWeeks('1.5') === 1.5, 'reminder input: numeric decimal string accepted');
      assert(normalizePriceDropReminderWeeks('1.5 weeks') === 0, 'reminder input: partial numeric garbage rejected instead of parseFloat acceptance');
      assert(normalizePriceDropReminderWeeks('0x10') === 0 && normalizePriceDropReminderWeeks(true) === 0, 'reminder input: non-decimal/non-numeric types rejected');
      assert(normalizePriceDropReminderWeeks(-2) === 0 && normalizePriceDropReminderWeeks(Infinity) === 0, 'reminder input: non-positive/non-finite values disable');
      assert(priceDropReminderDelayMs({ scheduleStartedAtIso: anchor, weeks: 2.5, nowMs: now }) === 0.5 * MS_PER_WEEK,
        'reminder scheduling: next shared cadence returns exact remaining delay');
      assert(priceDropReminderDelayMs({ scheduleStartedAtIso: anchor, weeks: 2, nowMs: now }) === 0,
        'reminder scheduling: elapsed shared cadence returns zero');
      assert(priceDropReminderDelayMs({
        scheduleStartedAtIso: anchor,
        lastAcknowledgedAtIso: new Date(now + 60 * 60 * 1000).toISOString(),
        weeks: 1,
        nowMs: now + 60 * 60 * 1000,
      }) === MS_PER_WEEK - 60 * 60 * 1000,
      'reminder scheduling: a late acknowledgment does not drift interval-only reminders');
      assert(priceDropReminderDelayMs({ scheduleStartedAtIso: 'bad', weeks: 2, nowMs: now }) === null,
        'reminder scheduling: invalid shared start is unschedulable');
      assert(priceDropReminderDelayMs({
        scheduleStartedAtIso: new Date(now).toISOString(),
        cardCreatedAtIso: new Date(now).toISOString(),
        weeks: 0.5,
        nowMs: now,
      }) === 0.5 * MS_PER_WEEK,
      'reminder scheduling: a newly created oldest listing starts at its selected price and waits a full interval');
      // A card spawned mid-schedule (no ack) must NOT fire for grid points that
      // elapsed before it existed — it joins at the next shared grid point.
      assert(priceDropReminderDelayMs({
        scheduleStartedAtIso: anchor,                     // oldest card: 2 weeks ago
        cardCreatedAtIso: new Date(now).toISOString(),    // this card: just spawned
        weeks: 2,
        nowMs: now,
      }) === 2 * MS_PER_WEEK,
      'reminder scheduling: a card spawned mid-schedule joins the next shared grid point, not the elapsed one');
      assert(priceDropReminderDelayMs({ scheduleStartedAtIso: anchor, weeks: 2, nowMs: now }) === 0
        && priceDropReminderDelayMs({
          scheduleStartedAtIso: anchor,
          cardCreatedAtIso: anchor,                        // oldest card itself
          weeks: 2,
          nowMs: now,
        }) === 0,
      'reminder scheduling: the oldest card (created at the shared start) still fires on its own cadence');
      assert(priceDropReminderDelayMs({
        scheduleStartedAtIso: anchor,
        cardCreatedAtIso: new Date(now + MS_PER_WEEK).toISOString(), // corrupt/skewed future
        weeks: 2,
        nowMs: now,
      }) === 0,
      'reminder scheduling: a future card creation time is ignored, not used to defer reminders');

      // ── Must-sell plan: strict editor normalization + a linear schedule whose
      // final reminder ON OR BEFORE the date reaches the exact target price.
      assert(normalizePriceDropMustSellDate('2028-02-29') === '2028-02-29', 'reminder plan: valid leap date accepted');
      assert(normalizePriceDropMustSellDate('2027-02-29') === '', 'reminder plan: impossible calendar date rejected');
      assert(normalizePriceDropMustSellDate('06/15/2026') === '', 'reminder plan: non-date-input format rejected');
      assert(Number.isFinite(priceDropMustSellDateMs('2028-02-29')), 'reminder plan: valid date resolves to local midnight');
      assert(priceDropMustSellDayEndMs('2026-01-29') === new Date(2026, 0, 30).getTime(),
        'reminder plan: day-end cutoff is the start of the day after the must-sell date');
      assert(normalizePriceDropTargetPrice('42.50') === 42.5 && normalizePriceDropTargetPrice('19.99') === 19.99,
        'reminder plan: target price accepts positive currency');
      assert(normalizePriceDropTargetPrice('0') === 0 && normalizePriceDropTargetPrice(0) === 0,
        'reminder plan: target price accepts zero as a free-listing target');
      assert(normalizePriceDropTargetPrice(-5) === null && normalizePriceDropTargetPrice('abc') === null,
        'reminder plan: negative or malformed target price is rejected');
      assert(normalizePriceDropStartingTier('quick') === 'quick' && normalizePriceDropStartingTier('other') === 'best',
        'reminder plan: starting tier is constrained with Best as default');
      assert(normalizePriceDropStartingPrice('42.50') === 42.5 && normalizePriceDropStartingPrice(0) === null,
        'reminder plan: snapshotted starting price must remain positive currency');
      const tierPrices = { quick: 35, best: 42, max: 55 };
      assert(resolvePriceDropStartingTier(tierPrices, 'max') === 'max' && priceDropStartingPrice(tierPrices, 'max') === 55,
        'reminder plan: selected tier supplies the starting price');
      assert(resolvePriceDropStartingTier({ quick: 35, best: null, max: null }, 'best') === 'quick',
        'reminder plan: missing selected tier falls back to an available price');

      const scheduleStartMs = new Date(2026, 0, 1).getTime();
      const scheduleStartIso = new Date(scheduleStartMs).toISOString();
      const scheduleArgs = {
        startingPrice: 100,
        targetPrice: 10,
        scheduleStartedAtIso: scheduleStartIso,
        mustSellDate: '2026-01-29',
        weeks: 1,
      };
      assert(priceDropReminderCountThroughMustSell(scheduleArgs) === 4,
        'reminder plan: a cadence reminder landing on the must-sell day counts as the final reminder');
      assert(priceDropDeadlineReminderDelayMs({
        ...scheduleArgs,
        nowMs: scheduleStartMs,
      }) === MS_PER_WEEK, 'reminder plan: first trigger follows the fixed oldest-card cadence');
      assert(priceDropDeadlineReminderDelayMs({
        ...scheduleArgs,
        lastAcknowledgedAtIso: new Date(scheduleStartMs + MS_PER_WEEK + 60 * 60 * 1000).toISOString(),
        nowMs: scheduleStartMs + MS_PER_WEEK + 60 * 60 * 1000,
      }) === MS_PER_WEEK - 60 * 60 * 1000,
      'reminder plan: a late acknowledgment does not drift the next fixed trigger');
      assert(priceDropDeadlineReminderDelayMs({
        ...scheduleArgs,
        nowMs: scheduleStartMs + 4 * MS_PER_WEEK,
      }) === 0, 'reminder plan: an unacked reminder landing on the must-sell day still fires (on-the-day reduction)');
      assert(priceDropDeadlineReminderDelayMs({
        ...scheduleArgs,
        lastAcknowledgedAtIso: new Date(scheduleStartMs + 4 * MS_PER_WEEK).toISOString(),
        nowMs: scheduleStartMs + 4 * MS_PER_WEEK,
      }) === null, 'reminder plan: after acknowledging the final on-day reminder, none is scheduled');
      assert(priceDropDeadlineReminderDelayMs({
        ...scheduleArgs,
        nowMs: scheduleStartMs + 5 * MS_PER_WEEK,
      }) === null, 'reminder plan: reopening after the must-sell day does not trigger an overdue reminder');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, nowMs: scheduleStartMs + MS_PER_WEEK }) === 77.5,
        'reminder plan: first of four reminders takes one linear step');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, nowMs: scheduleStartMs + 2 * MS_PER_WEEK }) === 55,
        'reminder plan: second reminder takes the next linear step');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, nowMs: scheduleStartMs + 3 * MS_PER_WEEK }) === 32.5,
        'reminder plan: third reminder takes the next linear step');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, nowMs: scheduleStartMs + 4 * MS_PER_WEEK }) === 10,
        'reminder plan: the final on-day reminder reaches the exact target');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, nowMs: scheduleStartMs + 10 * MS_PER_WEEK }) === 10,
        'reminder plan: overdue reminder catches up without dropping below target');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, targetPrice: 0, nowMs: scheduleStartMs + 4 * MS_PER_WEEK }) === 0,
        'reminder plan: the final reminder can reach a free target');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, targetPrice: 0, nowMs: scheduleStartMs + 10 * MS_PER_WEEK }) === 0,
        'reminder plan: overdue reminder stays at a free target');
      assert(priceDropReminderCountThroughMustSell({ ...scheduleArgs, mustSellDate: '2026-01-22' }) === 3,
        'reminder plan: an earlier must-sell day includes its own on-day reminder');
      assert(priceDropReminderCountThroughMustSell({ ...scheduleArgs, mustSellDate: '2026-01-08' }) === 1,
        'reminder plan: a deadline on the first cadence keeps that single on-day reminder');
      assert(priceDropReminderCountThroughMustSell({ ...scheduleArgs, mustSellDate: '2026-01-06' }) === 0,
        'reminder plan: a deadline before the first cadence reminder fits none');
      assert(calculatePriceDropSuggestion({
        ...scheduleArgs,
        mustSellDate: '2026-01-08',
        nowMs: scheduleStartMs + MS_PER_WEEK,
      }) === 10, 'reminder plan: a single on-day reminder reaches the target in one step');
      assert(calculatePriceDropSuggestion({
        ...scheduleArgs,
        mustSellDate: '2026-01-06',
        nowMs: scheduleStartMs + MS_PER_WEEK,
      }) === null, 'reminder plan: infeasible deadline does not falsely claim the target can be reached');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, mustSellDate: '', nowMs: now }) === null,
        'reminder plan: optional missing must-sell date disables suggestions');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, targetPrice: undefined, nowMs: scheduleStartMs + 3 * MS_PER_WEEK }) === null,
        'reminder plan: no target price → no suggested price (generic reminders only)');
      assert(calculatePriceDropSuggestion({ ...scheduleArgs, targetPrice: 100, nowMs: scheduleStartMs + 3 * MS_PER_WEEK }) === null
        && calculatePriceDropSuggestion({ ...scheduleArgs, targetPrice: 150, nowMs: scheduleStartMs + 3 * MS_PER_WEEK }) === null,
        'reminder plan: a target at or above the starting price is not a valid drop');
      for (const startingPrice of [19.99, 55, 181, 9999.99]) {
        for (const fraction of [0.01, 0.25, 0.5, 0.9]) {
          const targetPrice = Math.floor(startingPrice * fraction * 100) / 100;
          if (!(targetPrice > 0 && targetPrice < startingPrice)) continue;
          const finalSuggestion = calculatePriceDropSuggestion({
            ...scheduleArgs,
            startingPrice,
            targetPrice,
            nowMs: scheduleStartMs + 4 * MS_PER_WEEK,
          });
          assert(finalSuggestion === targetPrice,
            `reminder plan: final reminder reaches the exact target (${startingPrice} → ${targetPrice})`);
        }
      }

      // ── Undo isolation: clock-driven reminder fields neither dirty the undo
      // fingerprint nor get rolled back by a restore; createdAt stays undoable.
      const base = { id: 'mc', type: 'marketplacecard', position: { x: 0, y: 0 }, data: { platformId: 'ebay', listingUrl: 'u', createdAt: '2026-01-01T00:00:00.000Z' } };
      const liveReminderState = { ...base, data: { ...base.data, priceDropReminderDue: true, lastPriceDropAt: new Date(now).toISOString() } };
      assert(
        fingerprint({ nodes: [base], edges: [], drawings: [] }) === fingerprint({ nodes: [liveReminderState], edges: [], drawings: [] }),
        'reminder undo: live reminder fields do not dirty the undo fingerprint'
      );
      const restored = mergeNonRestorableNodeDataFromLive([base], [liveReminderState]);
      assert(restored[0].data.priceDropReminderDue === true && restored[0].data.lastPriceDropAt === liveReminderState.data.lastPriceDropAt, 'reminder undo: restore keeps LIVE reminder state');
      return { schema: CURRENT_SCHEMA_VERSION };
    },
  },
{
    name: 'Node customization: compatibility filtering and dialog sources stay aligned',
    run: () => {
      assert(nodeSupportsCustomization('marketplacecard'), 'customization: listing cards support static glow');
      assert(!nodeSupportsCustomization('sellhub'), 'customization: unsupported nodes stay excluded');
      assert(!nodeSupportsCustomization('toString'), 'customization: object-prototype names stay excluded');

      const mixedUpdates = {
        fontSize: 18,
        backgroundColor: '#111111',
        staticGlowColor: '#00ff00',
        unknownField: 'drop-me',
      };
      assert(
        JSON.stringify(filterNodeCustomizationUpdates({ type: 'text', data: {} }, mixedUpdates))
          === JSON.stringify({ fontSize: 18, backgroundColor: '#111111' }),
        'customization: text receives only supported fields',
      );
      assert(
        JSON.stringify(filterNodeCustomizationUpdates({ type: 'marketplacecard', data: {} }, mixedUpdates))
          === JSON.stringify({ staticGlowColor: '#00ff00' }),
        'customization: listing cards receive only static glow',
      );
      assert(
        Object.keys(filterNodeCustomizationUpdates({ type: 'sellhub', data: {} }, mixedUpdates)).length === 0,
        'customization: unsupported nodes produce a no-op update',
      );
      assert(
        Object.keys(filterNodeCustomizationUpdates({ type: 'marketplacecard', data: { staticGlowColor: '#00ff00' } }, mixedUpdates)).length === 0,
        'customization: unchanged compatible values produce a no-op update',
      );

      const dialog = buildCustomizationDialogData([
        { id: 'listing', type: 'marketplacecard', data: { staticGlowColor: '#00ff00' } },
        { id: 'text', type: 'text', data: { fontSize: 22, fontFamily: 'serif', textColor: '#ffffff', backgroundColor: '#222222' } },
        { id: 'group', type: 'group', data: { titleSpacing: 8 } },
      ]);
      assert(dialog.showFont && dialog.showSpacing && dialog.showBackground && dialog.showStaticGlow,
        'customization: mixed compatible selection exposes every supported section');
      assert(dialog.fontSize === 22 && dialog.titleSpacing === 8 && dialog.backgroundColor === '#222222',
        'customization: each section uses the first compatible baseline');
      assert(dialog.staticGlowColor === '#00ff00', 'customization: static glow baseline comes from the listing card');
      assert(buildCustomizationDialogData([{ id: 'hub', type: 'sellhub', data: {} }]) === null,
        'customization: unsupported-only selections do not open an empty dialog');
      return { ok: true };
    },
  },
{
    name: 'Search matching: item name finds hub AND its marketplace cards',
    run: () => {
      const q = (s) => s.toLowerCase();
      const hub = { id: 'h', type: 'sellhub', data: { product: { generated_title: 'WiFi Router Storage Box', brand: 'Calibrite', model: 'CCPV2' } } };
      const card = { id: 'c', type: 'marketplacecard', data: { platformId: 'ebay', productSnapshot: { title: 'WiFi Router Storage Box' }, notes: 'Lower price on Monday', listingUrl: 'https://www.ebay.com/itm/123' } };

      // Item name (case-insensitive, substring) → hub and card both match.
      assert(matchesQuery(hub, q('wifi router')), 'search: sellhub matches by generated_title');
      assert(matchesQuery(card, q('wifi router')), 'search: marketplacecard matches by productSnapshot.title');
      assert(matchesQuery(hub, q('CALIBRITE')) && matchesQuery(hub, q('ccpv2')), 'search: sellhub matches by brand/model (parity with listing)');

      // Card-specific content: user notes and pasted listing URL.
      assert(matchesQuery(card, q('monday')), 'search: marketplacecard matches by notes');
      assert(matchesQuery(card, q('ebay.com/itm')), 'search: marketplacecard matches by listing URL');
      assert(!matchesQuery(card, q('poshmark')), 'search: marketplacecard non-match stays false');

      // Bundle: a SECONDARY item's name still finds the hub pricing it.
      const bundleHub = { id: 'b', type: 'sellhub', data: { product: { generated_title: 'Pelican Kayak' }, itemPricings: [
        { label: 'Pelican Kayak' }, { label: 'Carlisle Paddle', query: 'carlisle magic plus paddle' }, { notes: 'no label' },
      ] } };
      assert(matchesQuery(bundleHub, q('carlisle paddle')), 'search: bundle hub matches by secondary item label');
      assert(matchesQuery(bundleHub, q('magic plus')), 'search: bundle hub matches by secondary item query');
      assert(!matchesQuery(bundleHub, q('snowboard')), 'search: bundle hub non-match stays false');

      // Pre-existing type behaviors preserved; malformed nodes are safe.
      assert(matchesQuery({ type: 'text', data: { text: 'Call the buyer' } }, q('buyer')), 'search: text node still matches');
      assert(matchesQuery({ type: 'jobcard', data: { title: 'Engineer', company: 'Acme' } }, q('acme')), 'search: jobcard still matches');
      assert(!matchesQuery({ type: 'sellhub', data: {} }, q('x')), 'search: hub without product is a safe non-match');
      assert(!matchesQuery({ type: 'marketplacecard' }, q('x')) && !matchesQuery(null, q('x')), 'search: missing data / null node are safe non-matches');
      return { ok: true };
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
    name: 'Job Search hover distinguishes career documents from Job Boards',
    run: () => {
      const target = { id: 'search-copy', type: 'jobhub', data: { hubState: 'empty' } };
      const documentNode = { id: 'career-doc', type: 'document', data: { filePath: '/tmp/Work Experience.md', filename: 'Work Experience.md' } };
      const boardNode = { id: 'results-board', type: 'jobboard', data: { hubState: 'empty' } };

      const documentPayload = filePayloadFromDraggedNodes([documentNode]);
      assert(documentPayload.length === 1 && documentPayload[0].filePath === '/tmp/Work Experience.md',
        'a canvas document must expose its underlying career-file path to the Job Search drop route');
      const documentHover = buildHubHoverState(target, [documentNode]);
      assert(documentHover?.kind === 'accept' && documentHover?.label === 'Use as resume',
        'an empty copied Job Search must advertise acceptance while a career document is over it');

      assert(filePayloadFromDraggedNodes([boardNode]).length === 0,
        'a Job Board owns results rather than career files and must never be reinterpreted as a file payload');
      const boardHover = buildHubHoverState(target, [boardNode]);
      assert(boardHover?.kind === 'reject' && boardHover?.label === 'Drop a career file instead',
        'dragging a Job Board over Job Search must explain the correct input before release');
      return { document: documentHover.label, board: boardHover.label };
    },
  },
{
    name: 'Clearing a job hub\'s career files reopens it for a fresh drop while every search setting survives',
    run: () => {
      const parsed = {
        hubState: 'empty',
        inputLocked: true,
        resumeProfile: {},
        careerData: 'x',
        resumeSummary: 's',
        resumeFingerprint: 'f',
        resumeContext: {},
        filePath: '/a',
        filePaths: ['/a'],
        careerFilePaths: ['/a'],
        achievements: {},
        achievementsMining: 123,
        queries: ['q'],
        queryCacheKey: 'k',
        queryModel: 'm',
        queryCount: 1,
        canonicalLocation: 'X',
        targetRole: 'ROLE',
        preferredLocation: 'LOC',
        maxAgeDays: 7,
        collectionLimits: {},
        enabledSourceIds: ['indeed'],
        batchScoring: true,
      };
      const patch = buildJobHubCareerClearPatch();
      const merged = { ...parsed, ...patch };

      assert(hubHasAcceptedInitialDrop({ type: 'jobhub', data: parsed }),
        'the fixture must start as a hub that has accepted career files, or the clear assertions below prove nothing');
      assert(!hubHasAcceptedInitialDrop({ type: 'jobhub', data: merged }),
        'a cleared hub still reading as "already dropped" would keep rejecting the fresh career files the user is trying to add');
      // Cross-check against the CONSUMERS, not just the reader: the drop lock and
      // the drop-mode router are what actually gate the replacement drop.
      assert(canHubAcceptInitialDrop({ type: 'jobhub', data: merged }),
        'a cleared hub that cannot accept an initial drop leaves the user with a dead module and no way to swap career files');
      assert(getHubFileDropMode({ type: 'jobhub', data: merged }) === 'initial-input',
        'a cleared hub must route the next file drop as initial input, otherwise fresh career files land as nothing at all');

      for (const settingKey of ['targetRole', 'preferredLocation', 'maxAgeDays', 'collectionLimits', 'enabledSourceIds', 'batchScoring']) {
        assert(!Object.prototype.hasOwnProperty.call(patch, settingKey),
          `clearing career files must not touch ${settingKey} — wiping search settings defeats the point of clearing in place instead of rebuilding the module`);
      }
      assert(merged.targetRole === 'ROLE' && merged.preferredLocation === 'LOC' && merged.maxAgeDays === 7
        && merged.enabledSourceIds.length === 1 && merged.batchScoring === true,
      'a cleared hub that loses its role, location, age window or platform selection forces the user to re-enter every search setting');

      // Career-derived caches: none of these are fingerprint-keyed, so a survivor
      // is silently reused against the NEW files. achievements is the worst case —
      // JobCardNode mines only when the ledger is absent, so a stale ledger would
      // write new résumés from the old files' figures.
      for (const cacheKey of ['achievements', 'achievementsMining', 'queries', 'queryCacheKey', 'queryModel', 'queryCount', 'canonicalLocation']) {
        assert(patch[cacheKey] === null,
          `clearing career files must null ${cacheKey} — it is derived from the old files with no fingerprint keying, so a survivor (the unkeyed achievements ledger above all) would silently seed the next run from the previous person's history`);
      }

      // Reader/writer drift guard: the patch (WRITER) must overwrite EVERY field
      // the reader consults, each one on its own. The field list comes from the
      // reader's own export so adding a field there fails here until the patch
      // covers it; the patch keeps its literal spelling so this stays a real
      // comparison rather than two views of the same array.
      assert(patch.inputLocked === false,
        'the clear patch must unlock the hub — inputLocked short-circuits the reader ahead of every identity field, so leaving it set keeps the hub refusing drops no matter what else is cleared');
      for (const identityKey of JOBHUB_CAREER_IDENTITY_FIELDS) {
        assert(Object.prototype.hasOwnProperty.call(patch, identityKey),
          `the clear patch never writes ${identityKey}, so that field survives the clear and keeps the hub locked against replacement career files`);
        assert(!hubHasAcceptedInitialDrop({ type: 'jobhub', data: { [identityKey]: patch[identityKey] } }),
          `the clear patch writes a value for ${identityKey} that still reads as an accepted drop — it must be cleared, not merely rewritten`);
      }
      const identityFixtures = {
        inputLocked: true,
        ...Object.fromEntries(JOBHUB_CAREER_IDENTITY_FIELDS.map(field => [
          field,
          field.endsWith('Paths') ? ['/a'] : (field === 'resumeProfile' ? {} : '/a'),
        ])),
      };
      for (const [identityKey, identityValue] of Object.entries(identityFixtures)) {
        assert(hubHasAcceptedInitialDrop({ type: 'jobhub', data: { [identityKey]: identityValue } }),
          `${identityKey} alone must read as an accepted drop, otherwise this drift guard is testing nothing`);
        assert(!hubHasAcceptedInitialDrop({ type: 'jobhub', data: { [identityKey]: identityValue, ...patch } }),
          `the clear patch does not cover ${identityKey}, so a hub carrying only that field stays permanently locked against a replacement drop`);
      }
      return { clearedKeys: Object.keys(patch).length, settingsKept: 6 };
    },
  },
{
    // Clearing must dismantle every latch that would otherwise wedge the hub:
    // initialDropAcceptedRef is the likeliest — it is latched true by the
    // identity effect and never reset by data changes, so a UI that reopens
    // still bounces the drop inside acceptCareerFiles. The cancel quartet stops
    // a late-settling parse from writing the old profile straight back, and the
    // sidecar discards must read their tokens before updateGlobal nulls them.
    name: 'Clearing career files tears down the refs, in-flight work and sidecars that would wedge the reopened job hub',
    run: () => {
      const source = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const clearStart = source.indexOf('const handleClearCareerFiles = useCallback');
      assert(clearStart >= 0, 'the clear-career-files handler is missing, so the empty-state button cannot do anything');
      const clearEnd = source.indexOf('const isProcessing = PROCESSING_STATES', clearStart);
      assert(clearEnd > clearStart, 'the clear handler must sit before the render-phase code it is sliced against, or this contract silently checks the whole file');
      const clear = source.slice(clearStart, clearEnd);

      const guarded = [
        ['initialDropAcceptedRef.current = false', 'the latched initial-drop ref would keep acceptCareerFiles bouncing every replacement drop'],
        ['lastDroppedPathsRef.current = null', 'the previous files\' paths would let Re-run silently re-parse the cleared career files'],
        ['buildJobHubCareerClearPatch()', 'the career identity and its derived caches would survive the clear'],
        ['discardJobBatch', 'an abandoned batch sidecar would keep billing and could report results onto a cleared hub'],
        ['discardJobRun', 'the staged run sidecar would linger and re-offer a resume for career files that are gone'],
        ['setResumeOffer(null)', 'the resume banner would stay up offering to continue the very run this clear just discarded'],
        ['epoch.bump()', 'a late-settling parse would write the old profile straight back onto the cleared hub'],
        ['cancelNodeTask', 'the backend scrape would keep running and bounce the hub out of its cleared empty state'],
        ['cancelQueuedRunsForNode', 'a queued module run would start against career files that no longer exist'],
        ['addToast(', 'a clear refused because a run is in flight would be a silent dead button'],
      ];
      for (const [needle, consequence] of guarded) {
        assert(clear.includes(needle), `clearing career files is missing ${needle}: ${consequence}`);
      }

      assert(clear.indexOf('const runId =') >= 0 && clear.indexOf('const runId =') < clear.indexOf('updateGlobal('),
        'the run token must be captured before updateGlobal nulls pendingBatch/jobRunId, otherwise the recovery sidecars are orphaned on disk forever');

      // peekJobRun/discardJobRun are keyed by canvasFilePath ALONE — one staged
      // run per canvas — so the banner this hub happens to be showing may be
      // another job hub's recoverable run.
      assert(clear.includes('resumeOffer?.runId === runId'),
        'the resume banner must only be dismissed when the offered run is the one this hub just discarded with its own token');
      assert(!clear.includes('runId: resumeOffer'),
        'clearing this hub must never discard the offered run by its own id: the offer is canvas-scoped, so that trashes a DIFFERENT hub\'s recoverable run');

      // With the offer left standing, the Resume button is the only thing left
      // to degrade — and handleResumeRun DESTROYS the staged run when either the
      // profile or the run's queries are missing, so the button must not be
      // offered without both.
      assert(source.includes('const resumeRunActionable = canResumeOffer')
        && source.includes('resumeOffer?.nodeId === id')
        && source.includes('info?.found && info?.resumable && info?.nodeId === id ? info : null')
        && source.includes('if (resumeOffer?.nodeId !== id) return;')
        && source.includes('hasReusableCareerProfile')
        && source.includes('((resumeOffer?.queries?.length ?? 0) > 0)'),
      'only the matching hub exposes or can discard a recovery, and its Resume button still requires a career profile and staged queries');
      assert(source.includes('resumeRunId: offer.runId || null'),
        'the crash-resume IPC request carries the offered run token for backend ownership validation');
      assert(source.includes('{resumeRunActionable && <button'),
        'the Resume button must be rendered off resumeRunActionable, not the location-only canResumeOffer');
      assert(source.includes(' Start fresh — this run cannot be resumed from this module.')
        && !source.includes('this hub no longer has career files'),
      'the banner must report the observation (this run cannot be resumed here) rather than asserting a history a virgin hub never had — the offer is canvas-scoped and may come from another module entirely');
      return { guardedBehaviours: guarded.length };
    },
  },
{
    name: 'Job workflow omits applied-state tracking while preserving bundle generation and seen-history',
    run: () => {
      const cardSource = fs.readFileSync(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const searchSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const preloadSource = fs.readFileSync(path.resolve('electron/preload.js'), 'utf8');
      const mainSource = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
      assert(cardSource.includes('const generateApplication = useCallback')
        && cardSource.includes('Generate the application bundle'),
      'application-bundle generation remains available on disposable job cards');
      for (const removed of ['markJobApplied', 'unmarkJobApplied', 'isJobApplied', 'Mark applied', 'hiddenApplied', 'filterOutApplied']) {
        assert(!cardSource.includes(removed), `job card no longer references ${removed}`);
        assert(!searchSource.includes(removed), `search pipeline no longer references ${removed}`);
        assert(!preloadSource.includes(removed), `preload no longer exposes ${removed}`);
        assert(!mainSource.includes(removed), `main process no longer registers ${removed}`);
      }
      assert(!fs.existsSync(path.resolve('electron/ipc/appliedJobs.js'))
        && !fs.existsSync(path.resolve('src/utils/locationIdentity.js')),
      'the retired applied store and its private identity helper are removed');
      assert(searchSource.includes('dedupAgainstHistory'),
        'shown-job history dedup remains the source of truth for later searches');
      return { bundleGeneration: true, appliedTracking: false, historyDedup: true };
    },
  },
{
    name: 'Application Generate preserves an existing achievement ledger without starting API mining',
    run: () => {
      const source = fs.readFileSync(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const generationStart = source.indexOf('const generateApplication = useCallback');
      const generationEnd = source.indexOf('\n  return (', generationStart);
      const generationScope = source.slice(generationStart, generationEnd);
      assert(generationScope.includes('const cachedAchievements = originHub.data?.achievements || null;')
        && generationScope.includes('achievements: cachedAchievements,')
        && generationScope.includes('mineAllowed,'),
      'the local handoff must receive the hub ledger and an explicit signal when no cached ledger exists');
      assert(!generationScope.includes('achievementsMining')
        && !generationScope.includes('generateApplication({')
        && !generationScope.includes('updateGlobal(originHubId, { achievements:'),
      'the renderer must not start or write back remote achievement mining during local-only generation');
      return { cachedLedgerPassedThrough: true, apiMiningDisabled: true };
    },
  },
{
    name: 'Job Search cancellation keeps retained-profile rerun reachable and stale cleanup cannot unlock a newer run',
    run: () => {
      const guard = createRunOwnershipGuard();
      const first = guard.start();
      assert(first && guard.active, 'the first Job Search attempt owns the processing guard');
      assert(guard.start() === null && guard.active,
        'an active Job Search attempt cannot accidentally acquire a second processing owner');
      guard.cancel();
      assert(!guard.active && !guard.finish(first),
        'cancelling the initial attempt leaves no owner for its late finally block to release');
      const second = guard.start();
      assert(second && second !== first && guard.active, 'a replacement attempt can start immediately after cancellation');
      assert(!guard.finish(first) && guard.active,
        'the cancelled attempt settling late cannot mark its replacement idle');
      assert(guard.finish(second) && !guard.active, 'the replacement attempt can release its own guard');

      const source = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const emptyStateStart = source.indexOf("hubState === 'empty'");
      const processingStateStart = source.indexOf('{/* Processing state */}', emptyStateStart);
      const emptyState = source.slice(emptyStateStart, processingStateStart);
      assert(emptyState.includes('Career files retained')
        && emptyState.includes('Re-run Search')
        && emptyState.includes('hasReusableCareerProfile && !data.locked')
        && emptyState.includes('handleRerun();'),
      'only a locked empty hub with a retained profile exposes the existing rerun path');
      assert(emptyState.includes('inputDropsBlocked && hasCareerIdentity')
        && emptyState.includes('Re-run with these files, or clear them to search with different ones')
        && emptyState.includes('Clear career files')
        && emptyState.includes('handleClearCareerFiles(e);'),
      'a hub holding career files must offer the clear action, and a hub holding none must not claim files are retained');
      // Both empty-state branches hide their actions while data.locked, so both
      // must say so instead of naming buttons that aren't rendered or inviting a
      // drop that handleDrop silently refuses.
      assert(emptyState.includes('Unlock this module to re-run it or change its files'),
        'a locked retained-files hub still tells the user to re-run or clear, but both buttons are hidden behind !data.locked — the instruction points at nothing');
      assert(emptyState.includes('Module locked')
        && emptyState.includes('Unlock it to drop career files'),
      'a locked virgin hub falls through to the drop copy and invites a drop that handleDrop refuses without a word');

      // The hub rests at 'done' after every successful run, so the clear action
      // has to be reachable from there too — otherwise swapping career files
      // costs a full Re-run + Reset just to reach the empty state.
      assert(source.includes('onClearCareerFiles={handleClearCareerFiles}'),
        'the done state never receives the clear action, so after a successful run the only way to swap career files is a wasted Re-run + Reset');
      const doneState = fs.readFileSync(path.resolve('src/nodes/jobsearch/JobSearchDoneState.jsx'), 'utf8');
      assert(doneState.includes('onClearCareerFiles')
        && /!locked && onClearCareerFiles/.test(doneState),
      'the done state must render the clear action only when the hub is unlocked — the handler bails on data.locked, so a visible button there would be a dead click');

      const resetStart = source.indexOf('const resetHandler = useCallback');
      const resetEnd = source.indexOf('const handleRerun = useCallback', resetStart);
      const reset = source.slice(resetStart, resetEnd);
      // The cleared-career literals now live in buildJobHubCareerClearPatch, so
      // pin the call site here and assert the cleared values on the helper itself.
      const cancelClearPatch = buildJobHubCareerClearPatch();
      assert(cancelClearPatch.inputLocked === false,
        'cancelling before a profile exists must unlock the hub, otherwise the drop lock strands it with nothing to rerun');
      assert(cancelClearPatch.resumeProfile === null,
        'cancelling before a profile exists must leave no half-parsed profile behind for the rerun action to trust');
      assert(cancelClearPatch.careerData === null,
        'cancelling before a profile exists must drop the parsed career text, otherwise a stale corpus feeds the next run');
      assert(reset.includes('processingRunsRef.current.cancel()')
        && /pendingJobs:\s*null/.test(reset)
        && /scrapeWarnings:\s*\[\]/.test(reset)
        && reset.includes('const retainedCareerData = hasReusableCareerProfile')
        && reset.includes('buildJobHubCareerClearPatch()')
        && reset.includes('...retainedCareerData')
        && reset.includes('initialDropAcceptedRef.current = hasReusableCareerProfile')
        && reset.includes('const resetRunId = data.pendingBatch?.jobRunId || jobRunIdRef.current || data.jobRunId || null')
        && reset.includes('discardJobRun?.({ canvasFilePath, runId: resetRunId })'),
      'cancel clears partial buffers, retains parsed careers, and unlocks an initial cancellation with no reusable profile');
      // The presence checks above hold for either arm of the ternary; pin the
      // DIRECTION separately.
      assert(/hasReusableCareerProfile\s*\?\s*\{\}\s*:\s*buildJobHubCareerClearPatch\(\)/.test(reset),
        'the cancel ternary is inverted: applying the clear patch when hasReusableCareerProfile is TRUE wipes the parsed profile exactly when it must be retained, leaving a cancelled hub with no career data and no rerun path');

      assert(canHubAcceptInitialDrop({
        type: 'jobhub',
        data: { hubState: 'empty', inputLocked: false, resumeProfile: null, careerData: null, filePath: null },
      }), 'cancelling before profile extraction reopens the hub for a replacement initial upload');
      assert(!canHubAcceptInitialDrop({
        type: 'jobhub',
        data: { hubState: 'empty', inputLocked: true, resumeProfile: { skills: [] } },
      }), 'cancelling after profile extraction keeps the hub bound to its original career files');

      const rerunStart = source.indexOf('const handleRerun = useCallback');
      // Anchored on the NEXT handler, not on the render-phase `isProcessing`:
      // handlers added between the two would otherwise be swept into this slice
      // and could satisfy the rerun contract on handleRerun's behalf.
      const rerunEnd = source.indexOf('const handleClearCareerFiles', rerunStart);
      assert(rerunEnd > rerunStart, 'the rerun slice must end at the next handler, or this contract silently checks unrelated code too');
      const rerun = source.slice(rerunStart, rerunEnd);
      assert(rerun.includes('effectivePaths.length === 0 && !data.resumeProfile')
        && rerun.includes('startProcessingWithProfile(data.resumeProfile'),
      'the retained-profile action re-enters the pipeline without requiring the cancelled run\'s file path');

      assert(!source.includes('const cancelBatchScoring = useCallback')
        && !source.includes('Economy scoring')
        && source.includes("hubState === 'scoring-batch'"),
      'new searches expose no batch-scoring controls while old submitted batches retain a narrow finalizer');
      const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(jobsSource.includes('async function deleteJobBatchSidecar(canvasFilePath, nodeId, { expectedBatchId = null } = {})')
        && jobsSource.includes('current?.batchId !== expectedBatchId')
        && jobsSource.includes('const removed = await deleteJobBatchSidecar(canvasFilePath, nodeId, { expectedBatchId: sidecar.batchId });')
        && jobsSource.includes('if (!removed) {'),
      'a late batch poll must neither delete nor return results from a replacement batch sidecar');
      assert(jobsSource.includes('const throwIfSearchAborted = async () =>')
        && jobsSource.includes("reason.message === 'Node deleted'")
        && jobsSource.includes("phase: 'aborted'")
        && jobsSource.indexOf('await throwIfSearchAborted();\n    await setJobRunStage') >= 0,
      'a Reset during scrape discards only its token-scoped recovery run and cannot mark the cancelled manifest gathered');
      return { rerunReachable: true, initialCancellationUnlocks: true, staleOwnerRejected: true };
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
      assert(isProductImageExtension('.svg') && isProductImageExtension('JpEg') && !isProductImageExtension('.pdf'),
        'File display helpers: shared image extension check should cover every accepted preview format');
      assert(decodeLocalFileRequestPath('local-file:///tmp/a%20b%23c%3F.png', 'darwin') === '/tmp/a b#c?.png',
        'File display helpers: local-file path decoder should preserve encoded filename delimiters');
      assert(decodeLocalFileRequestPath('local-file://private/tmp/photo.png', 'darwin') === '/private/tmp/photo.png',
        'File display helpers: local-file path decoder should restore a POSIX first segment canonicalized as a hostname');
      assert(decodeLocalFileRequestPath('local-file://C:/Pictures/photo.png', 'win32') === 'C:/Pictures/photo.png',
        'File display helpers: local-file path decoder should retain a Windows drive letter parsed as a URL hostname');
      assert(decodeLocalFileRequestPath('local-file:///C:/Pictures/photo.png', 'win32') === 'C:/Pictures/photo.png',
        'File display helpers: local-file path decoder should retain a Windows drive letter in triple-slash URLs');
      return { image: getFileCategoryInfo('photo.HEIC').label };
    },
  },
{
    name: 'Missing preview relink stays in the current hierarchy, finds exact names, and refuses ambiguity',
    run: () => {
      const root = path.join(os.tmpdir(), `ic-preview-relink-${process.pid}-${Date.now()}`);
      const workspace = path.join(root, 'workspace');
      const original = path.join(workspace, 'products', 'photo.jpg');
      const moved = path.join(workspace, 'archived', 'photo.jpg');
      const parentDecoy = path.join(root, 'photo.jpg');
      const externalRoot = path.join(root, 'external');
      const externalOriginal = path.join(externalRoot, 'camera', 'external.jpg');
      const externalMoved = path.join(externalRoot, 'camera', 'sorted', 'external.jpg');
      const ambiguousRoot = path.join(workspace, 'ambiguous');
      const documentOriginal = path.join(workspace, 'documents', 'document-photo.png');
      const documentMoved = path.join(workspace, 'documents', 'sorted', 'document-photo.png');
      const crossDepthRoot = path.join(workspace, 'cross-depth');
      try {
        // A broken path can be replaced by a directory with the same name.
        // It is not a valid preview and must not block the descendant search.
        fs.mkdirSync(original, { recursive: true });
        fs.mkdirSync(path.dirname(moved), { recursive: true });
        fs.writeFileSync(moved, 'image');
        fs.writeFileSync(parentDecoy, 'wrong parent image');
        fs.mkdirSync(path.dirname(externalMoved), { recursive: true });
        fs.writeFileSync(externalMoved, 'external image');
        fs.mkdirSync(path.join(ambiguousRoot, 'a'), { recursive: true });
        fs.mkdirSync(path.join(ambiguousRoot, 'b'), { recursive: true });
        fs.writeFileSync(path.join(ambiguousRoot, 'a', 'duplicate.jpg'), 'a');
        fs.writeFileSync(path.join(ambiguousRoot, 'b', 'duplicate.jpg'), 'b');
        fs.mkdirSync(path.dirname(documentMoved), { recursive: true });
        fs.writeFileSync(documentMoved, 'document image');
        fs.writeFileSync(path.join(root, 'document-photo.png'), 'wrong parent document image');
        fs.mkdirSync(path.join(crossDepthRoot, 'near'), { recursive: true });
        fs.mkdirSync(path.join(crossDepthRoot, 'far', 'deeper'), { recursive: true });
        fs.writeFileSync(path.join(crossDepthRoot, 'near', 'cross-depth.jpg'), 'near');
        fs.writeFileSync(path.join(crossDepthRoot, 'far', 'deeper', 'cross-depth.jpg'), 'far');

        clearMissingPreviewRelinkCache();
        clearMissingPreviewRelinkDiagnostics();
        clearMissingPreviewSearchRoots();
        const portableFound = resolvePortableImagePath(
          path.join(workspace, 'canvas.json'),
          original,
          path.join('.', 'products', 'photo.jpg'),
        );
        assert(portableFound === moved, 'workspace loading should relink a moved image within the canvas hierarchy, not its parent');

        clearMissingPreviewRelinkCache();
        clearMissingPreviewRelinkDiagnostics();
        clearMissingPreviewSearchRoots();
        rememberMissingPreviewSearchRoot(original, workspace);
        const found = resolveMissingPreviewPath(original);
        assert(found.status === 'found' && found.path === moved, `missing preview should relink within its remembered current hierarchy -> ${JSON.stringify(found)}`);
        assert(found.root === workspace && found.rootSource === 'remembered', 'missing preview should report its bounded remembered hierarchy');
        const cached = resolveMissingPreviewPath(original);
        assert(cached.cached === true && cached.path === moved, 'repeated preview requests should reuse the bounded relink cache');

        clearMissingPreviewRelinkCache();
        clearMissingPreviewSearchRoots();
        const lateOriginal = path.join(workspace, 'empty', 'photo.jpg');
        const parentOnly = resolveMissingPreviewPath(lateOriginal);
        assert(parentOnly.status === 'not-found', 'missing preview relink must not climb upward to a same-name file in the parent folder');
        const lateMoved = path.join(workspace, 'empty', 'later', 'photo.jpg');
        fs.mkdirSync(path.dirname(lateMoved), { recursive: true });
        fs.writeFileSync(lateMoved, 'late image');
        const recoveredAfterNotFound = resolveMissingPreviewPath(lateOriginal);
        assert(recoveredAfterNotFound.status === 'found' && recoveredAfterNotFound.path === lateMoved,
          'not-found preview searches should not be cached across a move/copy completion');

        const external = resolvePortableImagePath(path.join(workspace, 'canvas.json'), externalOriginal, '');
        assert(external === externalMoved,
          'external image relink should ignore an empty legacy relative path and search its original folder and descendants only');

        const documentData = {
          nodes: [{
            type: 'document',
            data: {
              filename: 'document-photo.png',
              filePath: documentOriginal,
              relativeFilePath: path.join('.', 'documents', 'document-photo.png'),
            },
          }],
        };
        resolvePortableFilePaths(documentData, path.join(workspace, 'canvas.json'));
        assert(documentData.nodes[0].data.filePath === documentMoved,
          'document image previews should use the same descendant-only relinking as SellHub photos');

        const wrongCase = findExactFilenameBelow(workspace, 'Photo.jpg');
        assert(wrongCase.status === 'not-found', 'missing preview relink should require an exact case-sensitive filename');

        const ambiguous = findExactFilenameBelow(ambiguousRoot, 'duplicate.jpg');
        assert(ambiguous.status === 'ambiguous' && ambiguous.path === null && ambiguous.matches.length === 2, 'same-depth duplicate filenames should be left unresolved');
        const crossDepthAmbiguous = findExactFilenameBelow(crossDepthRoot, 'cross-depth.jpg');
        assert(crossDepthAmbiguous.status === 'ambiguous' && crossDepthAmbiguous.matches.length === 2,
          'duplicate filenames at different depths should be left unresolved instead of silently choosing the nearer one');
        const ambiguousMissing = path.join(ambiguousRoot, 'missing', 'duplicate.jpg');
        const initiallyAmbiguous = resolveMissingPreviewPath(ambiguousMissing, { searchRoot: ambiguousRoot });
        assert(initiallyAmbiguous.status === 'ambiguous', 'resolver should report duplicate matches as ambiguous');
        fs.rmSync(path.join(ambiguousRoot, 'b', 'duplicate.jpg'));
        const resolvedAfterDuplicateRemoved = resolveMissingPreviewPath(ambiguousMissing, { searchRoot: ambiguousRoot });
        assert(resolvedAfterDuplicateRemoved.status === 'found' && resolvedAfterDuplicateRemoved.path === path.join(ambiguousRoot, 'a', 'duplicate.jpg'),
          'negative/ambiguous preview results should not stay cached after the hierarchy changes');
        const diagnostics = getMissingPreviewRelinkDiagnostics();
        assert(diagnostics.attempts.some(attempt => attempt.status === 'not-found' && attempt.searchRoot === path.join(workspace, 'empty')),
          'missing preview diagnostics should retain not-found search scope for FULL reports');
        assert(diagnostics.attempts.every(attempt => attempt.searchRoot !== root),
          'missing preview diagnostics should prove no attempt climbed to the parent hierarchy');
        return { found: path.relative(root, found.path), ambiguous: ambiguous.matches.length, attempts: diagnostics.attempts.length };
      } finally {
        clearMissingPreviewRelinkCache();
        clearMissingPreviewRelinkDiagnostics();
        clearMissingPreviewSearchRoots();
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
    name: 'Job date and collection-limit helpers',
    run: () => {
      const twoDaysAgo = parsePostedDate('2 days ago');
      const twoMonthsAgo = parsePostedDate('2mo ago');
      const minutesAgo = parsePostedDate('5m ago');
      assert(twoDaysAgo && Date.now() - twoDaysAgo.getTime() >= 1.5 * 86400000, 'Job date and collection-limit helpers: days parsing mismatch');
      assert(twoMonthsAgo && Date.now() - twoMonthsAgo.getTime() >= 50 * 86400000, 'Job date and collection-limit helpers: months parsing mismatch');
      assert(minutesAgo && Date.now() - minutesAgo.getTime() < 86400000, 'Job date and collection-limit helpers: minutes should be today');
      const filtered = filterJobsByAge([
        { title: 'keep', posted: 'today' },
        { title: 'drop', posted: '90 days ago' },
        { title: 'unknown', posted: 'some weird source text' },
      ], 30);
      assert(filtered.map(j => j.title).join(',') === 'keep,unknown', 'Job date and collection-limit helpers: age filter should keep recent and unknown dates');
      const fixedNow = new Date('2026-08-13T12:00:00Z');
      assert(parsePostedDate('Aug 12', fixedNow)?.getFullYear() === 2026,
        'Job date parser: yearless past month-day resolves in the current year, not V8\'s 2001 default');
      assert(parsePostedDate('Aug 20', fixedNow)?.toISOString().startsWith('2025-08-20'),
        'Job date parser: future yearless month-day resolves to the most recent occurrence');
      assert(filterJobsByAge([{ title: 'recent-yearless', posted: 'Aug 12' }, { title: 'old-yearless', posted: 'May 29' }], 21, fixedNow)
        .map(job => job.title).join(',') === 'recent-yearless',
      'Job date filter: yearless dates honor the injected look-back clock');
      // The card-owned collection settings now default to "All" on BOTH fields
      // (stored as null): unlimited jobs per platform, and unlimited browser
      // pages (bounded only by the JOB_COLLECTION_PAGE_CEILING backstop a
      // walker resolves at, not by this stored default).
      assert(JSON.stringify(JOB_COLLECTION_LIMITS_DEFAULT) === JSON.stringify({ jobsPerPlatform: null, pagesPerPlatform: null }),
        'Job collection limits: defaults must be unlimited jobs AND unlimited pages ("All"/"All")');
      assert(JSON.stringify(normalizeJobCollectionLimits()) === JSON.stringify(JOB_COLLECTION_LIMITS_DEFAULT),
        'Job collection limits: missing persisted settings must normalize to production defaults');
      assert(JSON.stringify(normalizeJobCollectionLimits({ jobsPerPlatform: '17.9', pagesPerPlatform: '3.8' })) === JSON.stringify({ jobsPerPlatform: 17, pagesPerPlatform: 3 }),
        'Job collection limits: positive numeric user input must normalize to whole collector units');
      assert(JSON.stringify(normalizeJobCollectionLimits({ jobsPerPlatform: null, pagesPerPlatform: 1 })) === JSON.stringify({ jobsPerPlatform: null, pagesPerPlatform: 1 }),
        'Job collection limits: null jobs must explicitly remain unlimited while a one-page test is allowed');
      assert(JSON.stringify(normalizeJobCollectionLimits({ jobsPerPlatform: 0, pagesPerPlatform: -4 })) === JSON.stringify(JOB_COLLECTION_LIMITS_DEFAULT),
        'Job collection limits: zero and negative values must fall back safely instead of silently disabling collection');
      assert(JSON.stringify(normalizeJobCollectionLimits({ jobsPerPlatform: Infinity, pagesPerPlatform: NaN })) === JSON.stringify(JOB_COLLECTION_LIMITS_DEFAULT),
        'Job collection limits: non-finite inputs must fall back to stable defaults');
      // resolvePageCeiling/isUnlimitedPages/describeJobCollectionLimits are the
      // seam every walker uses instead of branching on null itself (the old
      // `limits.pagesPerPlatform || 10` idiom would silently turn "All" back
      // into the retired 10-page default).
      assert(isUnlimitedPages() === true && isUnlimitedPages({ pagesPerPlatform: null }) === true,
        'isUnlimitedPages: "All" (missing/null pagesPerPlatform) reads as unlimited');
      assert(isUnlimitedPages({ pagesPerPlatform: 5 }) === false,
        'isUnlimitedPages: an explicit page count is not unlimited');
      assert(resolvePageCeiling() === JOB_COLLECTION_PAGE_CEILING,
        'resolvePageCeiling: "All" resolves to the finite backstop, never null');
      assert(resolvePageCeiling({ pagesPerPlatform: 3 }) === 3,
        'resolvePageCeiling: an explicit page count passes through unchanged');
      assert(Number.isFinite(resolvePageCeiling()) && Number.isFinite(resolvePageCeiling({ pagesPerPlatform: null }))
        && Number.isFinite(resolvePageCeiling({ pagesPerPlatform: 999 })),
      'resolvePageCeiling: ALWAYS returns a finite number, regardless of input shape');
      const describedDefault = describeJobCollectionLimits();
      assert(describedDefault.jobs === 'all' && describedDefault.pages === `all (backstop ${JOB_COLLECTION_PAGE_CEILING})`,
        `describeJobCollectionLimits: default breadth must read as "all", got ${JSON.stringify(describedDefault)}`);
      const describedExplicit = describeJobCollectionLimits({ jobsPerPlatform: 12, pagesPerPlatform: 3 });
      assert(describedExplicit.jobs === '12' && describedExplicit.pages === '3',
        `describeJobCollectionLimits: explicit numbers render as plain strings, got ${JSON.stringify(describedExplicit)}`);
      // compsForPricing is unbounded — a small set passes through in full...
      const cSmall = compsForPricing(8, 4);
      assert(cSmall.sold === 8 && cSmall.active === 4, 'Job date and cap helpers: small comp set should pass through unbounded');
      // ...and a large set is bounded ONLY by the synthesis token budget (scaled
      // proportionally, well above the old 25/15 caps), and the count actually fed
      // must always receive a NON-clamped budget (i.e. it can't truncate).
      const cBig = compsForPricing(1000, 1000);
      assert(cBig.sold === cBig.active && cBig.sold > 15, 'Job date and cap helpers: large comp set should scale proportionally above the old caps');
      assert(priceSynthesisMaxTokens(cBig.sold + cBig.active) < 24576, 'Job date and cap helpers: fed comp count must fit the synthesis token budget (no clamp/truncate)');
      assert(jobScoringBatchSize() >= 5 && jobScoringBatchSize() <= 15, 'Job date and collection-limit helpers: scoring batch out of bounds');
      return { filtered: filtered.length, scoringBatch: jobScoringBatchSize(), defaultPages: JOB_COLLECTION_LIMITS_DEFAULT.pagesPerPlatform };
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
      assert(claude === 15, `adaptive-thinking Claude stays at the bounded 15-job ceiling (got ${claude})`);
      assert(claude === gemini, 'all live scoring lanes use the same bounded batch size');
      // Bounds hold for every known scoring-capable model id, and the size never
      // exceeds what the output-token cap can honor (so a batch can't truncate).
      const PER_JOB_FLOOR = 300, CAP = 24576, BASE = 2500, SAFETY = 0.8;
      const outBudgetMax = Math.floor((CAP * SAFETY - BASE) / PER_JOB_FLOOR);
      for (const m of ['claude-opus-4-8', 'claude-haiku-4-5-20251001', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite']) {
        const n = jobScoringBatchSize(m);
        assert(n >= 5 && n <= 15, `${m} batch ${n} within [5,15]`);
        assert(n <= outBudgetMax, `${m} batch ${n} fits the output-token budget (≤${outBudgetMax})`);
      }
      // Source contracts cover the cross-module safety seam: atomic LLM callers
      // retain their default retry, while chunkable scoring reaches its own split
      // fallback with a cleared, six-minute attempt deadline and live heartbeat.
      const llmSource = fs.readFileSync(path.resolve('electron/ipc/llm.js'), 'utf8');
      const jobsSource = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      assert(llmSource.includes('retryOnTruncation && !retriedForCap')
        && llmSource.includes('retryOnTruncation: opts.retryOnTruncation !== false'),
      'LLM truncation retry remains backward-compatible and can be disabled by a chunkable caller');
      assert(jobsSource.includes('retryOnTruncation: false')
        && jobsSource.includes('const SCORING_ATTEMPT_TIMEOUT_MS = 6 * 60 * 1000')
        && jobsSource.includes('clearTimeout(timer)')
        && jobsSource.includes('SCORING_HEARTBEAT_MS'),
      'job scoring disables duplicate truncation retries and owns a cleared bounded-attempt heartbeat');
      return { claude, gemini, missing };
    },
  },
{
    name: 'manual job scraper: terminal cap reasons remain distinct from completion',
    run: () => {
      assert(resolveManualSourceStopReason({ hitPerSourceCap: true }) === 'per-source-cap',
        'manual scraper must report its aggregate source cap rather than a clean completion');
      assert(resolveManualSourceStopReason({ hitPageCap: true }) === 'page-cap',
        'manual scraper must distinguish a pagination ceiling from a clean completion');
      // A page turn that never landed must NOT read as an exhausted source:
      // `empty-page` is treated downstream as a clean, terminal, lossless finish.
      assert(resolveManualSourceStopReason({ hitPageTurnStalled: true }) === 'page-turn-stalled',
        'a stalled page turn reports its own reason, never empty-page');
      assert(resolveManualSourceStopReason({ hitPageTurnStalled: true, hitEmptyPage: true }) === 'page-turn-stalled',
        'the specific stall observation outranks the generic empty-page one');
      assert(resolveManualSourceStopReason({ hitPageTurnStalled: true, sourceSkipped: true }) === 'blocked',
        'a real block still outranks a stalled page turn');
      assert(resolveManualSourceStopReason({ hitEmptyPage: true }) === 'empty-page',
        'manual scraper must retain an exhausted-results terminal reason');
      assert(resolveManualSourceStopReason({ hitUnhandledPagination: true }) === 'pagination-unhandled',
        'an enabled next-page control that was not followed must never look completed');
      assert(resolveManualSourceStopReason({ sourceSkipped: true }) === 'blocked',
        'manual scraper must retain a blocked terminal reason');
      assert(resolveManualSourceStopReason({ earlyExit: true }) === 'user-done'
        && resolveManualSourceStopReason({ earlyExit: true, sourceSkipped: true }) === 'blocked',
      'manual scraper must preserve user-done semantics while prioritizing a concrete block');
      assert(resolveManualSourceStopReason({ earlyExit: true, detailEnrichmentFailed: true }) === 'detail-enrichment-failed',
        'a failed card-detail pass must not be reported as user-done');
      assert(resolveManualSourceStopReason({}) === 'completed',
        'manual scraper must reserve completed for a normal non-capped finish');
      const manualScraperSource = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
      assert(manualScraperSource.includes("ziprecruiter: 'a[title=\"Next Page\"]'")
        && manualScraperSource.includes("const SCROLL_SOURCES = new Set(['google']);"),
      'ZipRecruiter must use its verified Next Page anchor instead of stopping after the first scroll-loaded page');
      assert(manualScraperSource.includes("description-card-unavailable")
        && manualScraperSource.includes("googlePanelRateLimit")
        && manualScraperSource.includes("page.off('response', googlePanelResponseListener)"),
      'Google virtual-card misses and callback throttles must stop only description enrichment, not masquerade as user completion or leak a response listener');
      // Data-driven stops outrank the page ceiling: now that pages defaults to
      // "All", a walk that ends because the DATA said stop must never be
      // reported as `page-cap` — bug reports flag that reason as "this source
      // may have more in-window jobs", which would be a lie here.
      for (const reason of ['age-window', 'no-new-jobs', 'end-of-results']) {
        assert(resolveManualSourceStopReason({ dataStopReason: reason, hitPageCap: true }) === reason,
          `a ${reason} stop must outrank the page ceiling, not masquerade as page-cap`);
      }
      assert(resolveManualSourceStopReason({ dataStopReason: 'age-window', sourceSkipped: true }) === 'blocked',
        'a concrete block must still outrank a data-driven stop');
      return { perSource: 'per-source-cap', page: 'page-cap', unhandled: 'pagination-unhandled', data: 'age-window/no-new-jobs/end-of-results' };
    },
  },
{
    name: 'Job title diagnostics and provider-result admission',
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
      assert(
        !jobRelevanceMatch('Technical Sales Enablement Manager, Partners', 'Technical Lead', new Set())
          && jobRelevanceMatch('Senior Technical Architect', 'Technical Lead', new Set()),
        'Job board relevance filtering: broad technical queries retain engineering/architecture roles without leaking into technical sales',
      );
      const softwareArchitectureTitles = [
        'Associate Observability Architect | PST | Remote',
        'Associate Solutions Architect (French or German fluency)',
        'Customer Support Systems & Analytics Architect',
        'Principal Cloud Architect',
      ];
      assert(
        softwareArchitectureTitles.every(title => jobRelevanceMatch(title, 'Software Architect', new Set())),
        'Job board relevance filtering: Software Architect recognizes technical architecture qualifier variants',
      );
      assert(jobRelevanceMatch('Principal Cloud Architect', 'Software Architects', new Set()),
        'Job board relevance filtering: pluralized architecture queries use the same technical qualifier family');
      assert(
        ['Landscape Architect', 'Naval Architect', 'Business Architect', 'Senior Software Engineer']
          .every(title => !jobRelevanceMatch(title, 'Software Architect', new Set())),
        'Job board relevance filtering: architecture variants still require a technical qualifier and the architect head',
      );
      const softwareArchitectureAdmission = filterWholeFeedJobsByTitleRelevance(
        [...softwareArchitectureTitles, 'Director, GTM Finance'].map((title, index) => ({ title, url: `wwr-architecture-${index}` })),
        ['Software Architect'],
      );
      assert(softwareArchitectureAdmission.providerGathered === 5
        && softwareArchitectureAdmission.gathered === 4
        && softwareArchitectureAdmission.relevanceDropped === 1,
      'whole-feed relevance: software-architecture variants survive WWR admission without relaxing unrelated titles');
      const cappedCandidates = [
        'Junior Project Buyer', 'Draftsperson', 'Data Coordinator',
        'Shipping & Logistics Specialist', 'Project Coordinator, New Graduate',
        'Business Systems Architect', 'Enterprise Platform Systems Architect',
      ].map(title => ({ title }));
      const providerRowsBeforeCap = applyFinalJobTitleRelevanceGate(
        cappedCandidates,
        ['Systems Architect'],
      ).slice(0, 5);
      assert(providerRowsBeforeCap.map(job => job.title).join('|') === cappedCandidates.slice(0, 5).map(job => job.title).join('|'),
        'per-platform caps preserve provider order without a second local title gate');
      const wholeFeedRows = [
        { title: 'Business Systems Architect', company: 'Acme', url: 'wwr-1' },
        { title: 'Enterprise Platform Systems Architect', company: 'Acme', url: 'wwr-2' },
        // Raw RSS/JSON titles can retain entities. Admission must decode only
        // its local matcher/telemetry copy, not mutate the source job object.
        { title: 'Customer Support Systems &amp; Analytics Architect', company: 'Acme', url: 'wwr-entity' },
        // Company text is intentionally not role evidence for a whole feed.
        { title: 'Customer Success Engineer', company: 'Systems Architect Group', url: 'wwr-3' },
        // This near miss follows a total miss in feed order; diagnostics should
        // rank it first because it shares one of the requested role concepts.
        { title: 'GRC Analyst', company: 'Acme', url: 'wwr-4' },
        { title: 'Systems Analyst', company: 'Acme', url: 'wwr-near-miss' },
        { title: 'Senior Product Designer', company: 'Acme', url: 'wwr-5' },
      ];
      const wholeFeedAdmission = filterWholeFeedJobsByTitleRelevance(wholeFeedRows, ['Systems Architect']);
      assert(wholeFeedAdmission.providerGathered === 7
        && wholeFeedAdmission.gathered === 3
        && wholeFeedAdmission.relevanceDropped === 4
        && wholeFeedAdmission.preCapRelevanceDropped === 4
        && wholeFeedAdmission.items.map(job => job.url).join('|') === 'wwr-1|wwr-2|wwr-entity'
        && wholeFeedAdmission.relevanceRejected[0] === 'Systems Analyst'
        && wholeFeedAdmission.relevanceRejected.includes('Customer Success Engineer')
        && wholeFeedAdmission.relevanceTrace.length === 3
        && wholeFeedAdmission.relevanceTrace.every(row => row.matched.length > 0)
        && wholeFeedAdmission.relevanceTrace.some(row => row.url === 'wwr-entity' && row.title === 'Customer Support Systems & Analytics Architect')
        && wholeFeedRows[2].title === 'Customer Support Systems &amp; Analytics Architect',
      'whole-feed relevance: decodes entity-encoded titles for admission/telemetry, keeps source rows intact, and ranks near-miss samples first');
      const wholeFeedOrAdmission = filterWholeFeedJobsByTitleRelevance(wholeFeedRows, ['Systems Architect', 'Customer Success Engineer']);
      assert(wholeFeedOrAdmission.items.map(job => job.url).join('|') === 'wwr-1|wwr-2|wwr-entity|wwr-3',
        'whole-feed relevance: multiple generated role queries use OR admission');
      const unconstrainedWholeFeed = filterWholeFeedJobsByTitleRelevance(wholeFeedRows, []);
      assert(unconstrainedWholeFeed.items.length === 7
        && unconstrainedWholeFeed.gathered === 7
        && unconstrainedWholeFeed.relevanceDropped === 0
        && unconstrainedWholeFeed.relevanceRejected.length === 0,
      'whole-feed relevance: no usable query preserves feed rows rather than treating absent search terms as rejections');
      const geoStrippedWholeFeed = filterWholeFeedJobsByTitleRelevance([
        { title: 'Vancouver Systems Analyst', url: 'geo-drop' },
        { title: 'Systems Architect', url: 'geo-keep' },
      ], ['Systems Architect Vancouver'], buildGeoTermSet(['Vancouver, BC']));
      assert(geoStrippedWholeFeed.items.map(job => job.url).join('|') === 'geo-keep',
        'whole-feed relevance: requested-location title text cannot satisfy a missing role concept');
      // Snapshot regressions: RemoteOK/WWR fetch whole feeds and used to admit
      // rows on one ambient/sub-string query term. A multi-noun role query now
      // needs two role concepts, with a deliberately narrow adjacent-role map.
      assert(
        jobRelevanceMatch('Customer Support Systems & Analytics Architect', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: a customer-support title is retained through the service/support concept',
      );
      assert(
        !jobRelevanceMatch('Hanson Professional Services: Electrical Engineer - Substation Design', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: "service" must not substring-match unrelated "Services"',
      );
      assert(
        !jobRelevanceMatch('Coffee Roaster Campos Coffee', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: unrelated RemoteOK titles are not admitted by a broad query term',
      );
      assert(
        jobRelevanceMatch('Customer-Service Representative', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: close customer-service variants retain two-term relevance',
      );
      assert(
        jobRelevanceMatch('Administrative Assistant', 'Administrative Assistant', new Set()),
        'Job board relevance filtering: exact multi-word role remains eligible',
      );
      assert(
        jobRelevanceMatch('Customer Support Systems & Analytics Architect', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: customer support is an adjacent customer-service role',
      );
      assert(
        jobRelevanceMatch('Customer Success Manager, EMEA', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: customer success is an adjacent customer-service role',
      );
      assert(
        jobRelevanceMatch('Customer Advocate Lead', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: customer advocate is an adjacent customer-service role',
      );
      assert(
        jobRelevanceMatch('Back Office support', 'Administrative Assistant', new Set()),
        'Job board relevance filtering: back-office support is an adjacent administrative-assistant role',
      );
      assert(
        jobRelevanceMatch('Delivery Helper - CDL Trainee', 'Route Delivery Assistant', new Set()),
        'Job board relevance filtering: delivery helper is an adjacent delivery-assistant role',
      );
      assert(
        !jobRelevanceMatch('Mover/Helper', 'Route Delivery Assistant', new Set()),
        'Job board relevance filtering: helper alone cannot satisfy a multi-concept delivery-assistant query',
      );
      assert(
        !jobRelevanceMatch('Part-Time Brand & Outreach Assistant - B2B SaaS VC', 'Administrative Assistant', new Set()),
        'Job board relevance filtering: an assistant title without an administrative concept stays rejected',
      );
      assert(
        !jobRelevanceMatch('Area Vice President - Financial Services', 'Customer Service Coordinator', new Set()),
        'Job board relevance filtering: financial-services executive title stays rejected',
      );
      for (const unrelated of ['Maintenance Supervisor', 'Production Supervisor', 'Mechanic Supervisor', 'Shift Supervisor']) {
        assert(!jobRelevanceMatch(unrelated, 'Housekeeping Supervisor', new Set())
          && !jobRelevanceMatch(unrelated, 'Lead Room Attendant', new Set()),
        `Dice relevance regression: ${unrelated} must not enter housekeeping scoring`);
      }
      assert(jobRelevanceMatch('Housekeeping Supervisor', 'Housekeeping Supervisor', new Set())
        && jobRelevanceMatch('Lead Room Attendant', 'Lead Room Attendant', new Set()),
      'Dice relevance regression: exact housekeeping roles remain eligible');
      const technicalServerTitles = [
        'Software Engineering Technical Lead, Server Energy Services',
        'Lead Server Systems Debug Engineer',
        'Lead SQL Server DBA',
        'Server Engineer Lead (IBM iSeries)',
        'Server Engineering Lead',
        'Server & Storage Engineering Lead, Digital & Technology Services',
        'Server Engineer Lead (VMWare)',
      ];
      assert(technicalServerTitles.every(title => !jobRelevanceMatch(title, 'Lead Server', new Set())),
        'Dice relevance regression: a hospitality Lead Server query must reject technical server roles');
      assert(jobRelevanceMatch('Lead Server/Shift Manager', 'Lead Server', new Set())
        && jobRelevanceMatch('Server - Senior Living', 'Lead Server', new Set()),
      'Dice relevance regression: hospitality server roles remain eligible');
      assert(jobRelevanceMatch('Lead SQL Server DBA', 'SQL Server DBA', new Set()),
        'technical server searches remain eligible when their query carries technical context');
      const offTargetProductionTitles = [
        'Associate Production SQL Server DBA with Secret Clearance',
        'Engineer I - Production Engineering (Assembly)',
        'Associate Production Scientist - 12 Hour Night Shift',
      ];
      assert(offTargetProductionTitles.every(title => !jobRelevanceMatch(title, 'Production Associate', new Set())),
        'Dice relevance regression: a production-associate query must reject technical production titles');
      assert(jobRelevanceMatch('Production Machine Operator', 'Production Associate', new Set())
        && jobRelevanceMatch('Production Assembler', 'Production Associate', new Set()),
      'Dice relevance regression: genuine factory-production roles remain eligible');
      assert(jobRelevanceMatch('Production Engineer', 'Production Engineer', new Set()),
        'technical production searches remain eligible when their query carries technical context');
      assert(jobRelevanceMatch('Java Backend Engineer / Software developer / Java Developer', 'Backend Developer', new Set())
        && jobRelevanceMatch('Java Backend Engineer / Software developer / Java Developer', 'Software Engineer', new Set()),
      'Dice relevance regression: engineer/developer title aliases retain an explicitly backend/software role');
      assert(!jobRelevanceMatch('Platform Engineer', 'Backend Developer', new Set()),
        'engineer/developer alias still requires the query\'s second local role concept');
      const remoteOkJunk = [
        'Coffee Roaster Campos Coffee', 'Ganger', 'Artificial Intelligence Specialist',
        'Loss Prevention Specialist', 'Maintenance Technician', 'barber',
        'Talk us here if you can’t find the job that you’re looking for', 'Estimator',
        'Senior Software QA Engineer', 'Group leader',
      ];
      assert(remoteOkJunk.every(title => !jobRelevanceMatch(title, 'Customer Service Coordinator', new Set())
        && !jobRelevanceMatch(title, 'Administrative Assistant', new Set())),
      'Job board relevance filtering: all ten snapshot RemoteOK junk titles remain rejected');
      assert(
        jobRelevanceMatch('Service Coordinator', 'Coordinator', new Set()),
        'Job board relevance filtering: a reasonable single-noun query remains eligible',
      );
      const evidence = jobRelevanceEvidence('Customer-Service Representative', 'Customer Service Coordinator', new Set());
      assert(evidence?.query === 'Customer Service Coordinator'
        && evidence.requiredMatches === 2
        && evidence.matchedTerms.includes('customer')
        && evidence.matchedTerms.includes('service'),
      'Job board relevance filtering: a kept remote-feed row exposes its exact query/title match evidence');
      const synonymEvidence = jobRelevanceEvidence('Customer Support Systems & Analytics Architect', 'Customer Service Coordinator', new Set());
      assert(synonymEvidence?.matchedConcepts?.some(match => match.queryTerm === 'service'
        && match.matched === 'support' && match.kind === 'synonym'),
      'Job board relevance filtering: telemetry labels the exact adjacent role synonym that admitted a row');
      assert(jobRelevanceEvidence('Coffee Roaster Campos Coffee', 'Customer Service Coordinator', new Set()) === null,
        'Job board relevance filtering: rejected rows produce no misleading match evidence');
      assert(jobRelevanceRejection('Security patrol officer GRAVEYARD', 'Corporate Security Officer', new Set()) === null,
        'relevance rejection diagnostics: a now-admitted title has no rejection reason');
      const sparseRejection = jobRelevanceRejection('Public Safety Officer', 'Corporate Security Officer', new Set());
      assert(sparseRejection?.reason === 'too-few-matched-concepts'
        && sparseRejection.required === 2
        && sparseRejection.matched.join('|') === 'officer',
      `relevance rejection diagnostics: sparse concept evidence is explicit, got ${JSON.stringify(sparseRejection)}`);
      const splitPhraseRejection = jobRelevanceRejection(
        'TRANSPORTATION ASSISTANT (PERSONAL PROPERTY)', 'Property Management Assistant', new Set(),
      );
      assert(splitPhraseRejection?.reason === 'not-one-title-phrase'
        && splitPhraseRejection.required === 2
        && splitPhraseRejection.matched.join('|') === 'property|assistant',
      `relevance rejection diagnostics: disconnected title concepts are explicit, got ${JSON.stringify(splitPhraseRejection)}`);
      assert(jobRelevanceMatch('Maintenance Tech', 'Maintenance Technician', new Set())
        && jobRelevanceMatch('Building Maintenance Tech I or II', 'Maintenance Technician', new Set())
        && jobRelevanceMatch('General Trades Maintenance Worker', 'Maintenance Technician', new Set())
        && !jobRelevanceMatch('Field Service Technician - Sign On Bonus!', 'Maintenance Technician', new Set()),
      'maintenance title aliases keep real maintenance roles without admitting unrelated field-service technicians');
      const finalGateSources = {
        indeed: { jobs: [], errors: 0, warnings: [] },
        linkedin: { jobs: [], errors: 0, warnings: [] },
        glassdoor: { jobs: [], errors: 0, warnings: [] },
      };
      const finalGateJobs = [
        { source: 'indeed', title: 'Maintenance Tech', url: 'keep-1' },
        { source: 'indeed', title: 'Field Service Technician - Sign On Bonus!', url: 'drop-1' },
        { source: 'linkedin', title: 'Building Maintenance Tech I or II', url: 'keep-2' },
        { source: 'dice', title: 'Lead Server Systems Debug Engineer', url: 'drop-2' },
        // Resolver pages can include recommended cards unrelated to the active
        // role. These must receive the same final title gate as a normal scrape.
        { source: 'glassdoor', title: 'Loss Prevention Specialist', url: 'drop-3' },
        { source: 'glassdoor', title: 'Armed Driver', url: 'drop-4' },
      ];
      finalGateSources.indeed.jobs = finalGateJobs.filter(j => j.source === 'indeed');
      finalGateSources.linkedin.jobs = finalGateJobs.filter(j => j.source === 'linkedin');
      finalGateSources.dice = { jobs: finalGateJobs.filter(j => j.source === 'dice'), errors: 0, warnings: [] };
      finalGateSources.glassdoor.jobs = finalGateJobs.filter(j => j.source === 'glassdoor');
      const explicitRoleResults = applyFinalJobTitleRelevanceGate(
        finalGateJobs,
        ['Maintenance Technician', 'Facilities Maintenance Technician', 'Lead Server'],
        finalGateSources,
      );
      const generatedRoleResults = applyFinalJobTitleRelevanceGate(finalGateJobs, [], finalGateSources);
      assert(explicitRoleResults.map(j => j.url).join('|') === finalGateJobs.map(j => j.url).join('|')
        && generatedRoleResults.map(j => j.url).join('|') === finalGateJobs.map(j => j.url).join('|')
        && finalGateSources.indeed.jobs.length === 2
        && finalGateSources.dice.jobs.length === 1
        && finalGateSources.glassdoor.jobs.length === 2
        && !finalGateSources.indeed.relevanceDropped,
      'provider-ranked results survive local title wording in explicit-role and generated-query runs');
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
      const scoped = createJobSearchTestMode({
        JOB_SEARCH_TEST_ENABLED: 'true',
        JOB_SEARCH_TEST_SOURCE: 'linkedin',
        JOB_SEARCH_TEST_SKIP_AI: 'yes',
      });
      assert(scoped.enabled && scoped.sourceId === 'linkedin' && scoped.skipAI, 'Job source test-mode env parsing: plain env values not parsed');
      const vite = createJobSearchTestMode({
        VITE_JOB_SEARCH_TEST_ENABLED: 'on',
        VITE_JOB_SEARCH_TEST_SOURCE: 'indeed',
      });
      assert(vite.enabled && vite.sourceId === 'indeed', 'Job source test-mode env parsing: VITE env values not parsed');
      assert(parseJobSearchEnvBoolean('not-a-bool', true) === true, 'Job source test-mode env parsing: invalid bool should use fallback');
      return { defaultEnabled: off.enabled, scopedSource: scoped.sourceId, viteSource: vite.sourceId };
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
    name: 'buildJobTasks: Google keyword query carries canonical location once',
    run: () => {
      const googleTask = (query, location) => {
        const tasks = buildJobTasks([query], 21, { onlySources: new Set(['google']) }, location);
        const task = tasks.find(t => t.sourceId === 'google');
        assert(task, 'Google task should be built when it is the requested source');
        return new URL(task.url).searchParams.get('q');
      };

      // udm=8 AND-requires every free-text token, so anything appended here is a
      // FILTER every posting must satisfy — not a ranking hint. The vestigial
      // " jobs" suffix is gone (udm=8 is already the jobs vertical) and a bare
      // COUNTRY is never appended.
      assert(googleTask('Camera Operator', 'Toronto, ON') === 'Camera Operator Toronto, ON',
        'a city-level canonical location is appended to Google’s keyword-only search');
      assert(googleTask('Camera Operator Toronto, ON', 'Toronto, ON') === 'Camera Operator Toronto, ON',
        'an exact canonical location already in the query is not repeated');
      assert(googleTask('Camera Operator Toronto', 'Toronto, ON') === 'Camera Operator Toronto',
        'a query that already names the location city is not awkwardly duplicated with the canonical suffix');
      assert(googleTask('Camera Operator', '') === 'Camera Operator',
        'location-free searches send the query unchanged');
      // MEASURED, and it inverted the earlier assumption: a place name is not a
      // free-text term on udm=8 — Google lifts it out as a location scope that
      // OVERRIDES browser geolocation. Without it, a Canadian egress returned
      // 0/159 US postings; with it, 173/173. Appending it also RAISED reachable
      // depth. Dropping the country hands the result set to the egress IP.
      assert(googleTask('Camera Operator', 'United States') === 'Camera Operator United States',
        'a bare country IS appended — it is a location scope, not a keyword');
      assert(googleTask('Camera Operator', 'Canada') === 'Camera Operator Canada',
        'the country scope is not US-specific');
      // The " jobs" SUFFIX stays removed — measured separately from the country
      // and with the opposite result: it never moved geography and cost up to
      // 57% of reachable results on one role.
      assert(googleTask('Registered Nurse jobs', '') === 'Registered Nurse jobs',
        'no " jobs" suffix is added, so a query already ending in "jobs" is unchanged');
      assert(!googleTask('Camera Operator', 'Denver, CO').endsWith(' jobs'),
        'the vestigial " jobs" suffix is never appended alongside a location');
      return { ok: true };
  },
},
{
    name: 'job source resolve: Google uses the visible extractor and description recovery path',
    run: () => {
      const google = getJobSourceResolveConfig('google');
      assert(google?.extractorJS === GOOGLE_JOBS_EXTRACTOR,
        'Google Solve must pass the Google Jobs extractor to its visible window instead of taking the no-extractor body-text auto-close path');
      assert(google?.requiresDescriptionEnrichment === true,
        'Google Solve must run the same description-evidence recovery as its ordinary browser scrape');
      assert(getJobSourceResolveConfig('not-a-source') === null,
        'non-browser/API sources must not accidentally gain a visible Solve extractor');
      return { googleExtractor: true, descriptionRecovery: true };
    },
  },
{
    name: 'buildJobTasks: card collection limits reach every browser task',
    run: () => {
      const requested = { jobsPerPlatform: 12, pagesPerPlatform: 3 };
      const tasks = buildJobTasks(['Systems Architect'], 21, {}, '', requested);
      const zip = tasks.find((task) => task.sourceId === 'ziprecruiter');
      const glassdoor = tasks.find((task) => task.sourceId === 'glassdoor');
      const google = tasks.find((task) => task.sourceId === 'google');
      assert(zip?.options?.maxPages === 3 && glassdoor?.options?.maxPages === 3,
        'card browser-pages-per-search setting must override the paginated browser depth');
      assert(google?.options?.maxPages === 3,
        'card browser-pages-per-search setting must also bound Google’s reveal iterations');
      for (const task of [zip, glassdoor, google]) {
        assert(JSON.stringify(task?.options?.collectionLimits) === JSON.stringify(requested),
          'every browser task must carry the exact normalized per-platform job limit');
        assert(task?.options?.unlimitedPages === false,
          'an explicit page count must NOT mark the task unlimited');
        assert(typeof task?.options?.onPageScraped === 'function',
          'every browser task must carry a makeJobPageStop stop callback');
      }
      // Missing/legacy card settings ("All" on both fields, the new default):
      // maxPages resolves to the finite backstop (never null — a walker loop
      // must never see an unbounded number), and unlimitedPages flips true so
      // the no-new-jobs pager-stall rule engages.
      const defaultZip = buildJobTasks(['Systems Architect'], 21, { onlySources: new Set(['ziprecruiter']) })[0];
      assert(defaultZip?.options?.maxPages === JOB_COLLECTION_PAGE_CEILING
        && defaultZip.options.unlimitedPages === true
        && defaultZip.options.collectionLimits.jobsPerPlatform === null
        && defaultZip.options.collectionLimits.pagesPerPlatform === null,
      'legacy/missing card settings must resolve "All" pages to the finite backstop and flag the walk unlimited');
      // Google is a single-page/scroll source (paginates: false) — its own
      // maxPages: 1 marker in buildJobTasks is unrelated to the resolved
      // ceiling; the reveal-loop cap it actually gets must still be the same
      // resolved, finite ceiling as every other source under "All".
      const defaultGoogle = buildJobTasks(['Systems Architect'], 21, { onlySources: new Set(['google']) })[0];
      assert(defaultGoogle?.options?.maxPages === JOB_COLLECTION_PAGE_CEILING,
        'Google must also get the resolved finite backstop for its reveal iterations under "All", not an unbounded value');
      // Fresh onPageScraped per query — two queries against the same source
      // must not share pagination-stop state (see jobPageStop.js).
      const twoQueryTasks = buildJobTasks(['Architect', 'Engineer'], 21, { onlySources: new Set(['ziprecruiter']) });
      assert(twoQueryTasks.length === 2 && twoQueryTasks[0].options.onPageScraped !== twoQueryTasks[1].options.onPageScraped,
        'each query must get its own onPageScraped instance, not a shared closure');
      return { browserTasks: tasks.length, pages: requested.pagesPerPlatform, jobs: requested.jobsPerPlatform };
    },
  },
{
    name: 'buildJobTasks: Glassdoor look-back uses supported non-narrowing buckets',
    run: () => {
      assert(glassdoorPostedBucket(1) === 1 && glassdoorPostedBucket(2) === 3,
        'Glassdoor bucket helper keeps exact values and rounds up in-between values');
      assert(glassdoorPostedBucket(21) === 30,
        'the default 21-day window rounds up to the supported 30-day bucket');
      assert(glassdoorPostedBucket(31) === null,
        'windows above the largest server bucket fall back to client-side filtering');
      const urlFor = (days) => {
        const task = buildJobTasks(['Camera Operator'], days, { onlySources: new Set(['glassdoor']) }, 'Toronto, ON')
          .find((candidate) => candidate.sourceId === 'glassdoor');
        assert(task, 'Glassdoor task should be built when requested');
        return new URL(task.url);
      };
      assert(urlFor(21).searchParams.get('fromAge') === '30',
        'generated URL never sends the unsupported fromAge=21 value');
      assert(!urlFor(61).searchParams.has('fromAge'),
        'generated URL omits fromAge when the requested window exceeds 30 days');
      return { ok: true };
    },
  },
{
    name: 'job Solve URL index: Glassdoor locId/locT mutation replaces the pre-resolution target',
    run: () => {
      const before = 'https://www.glassdoor.com/Job/jobs.htm?sc.keyword=Camera%20Operator&locKeyword=United%20States&fromAge=21';
      const actual = `${before}&locId=1&locT=N`;
      const tasks = [
        { id: 'glassdoor-0', sourceId: 'glassdoor', url: actual },
        { id: 'glassdoor-1', sourceId: 'glassdoor', url: `${before}&sc.keyword=Videographer&locId=1&locT=N` },
      ];
      const sourceFirstUrl = { glassdoor: before };
      const taskUrlById = { 'glassdoor-0': before, 'glassdoor-1': before };
      const solveUrl = refreshManualSourceUrlIndex(tasks, 'glassdoor', sourceFirstUrl, taskUrlById, 'glassdoor-0');
      assert(solveUrl === actual, `Solve must use the in-browser-resolved URL (got ${solveUrl})`);
      assert(sourceFirstUrl.glassdoor === actual, 'source progress and behavioral-gate warnings retain locId/locT');
      assert(taskUrlById['glassdoor-0'] === actual && /locId=1/.test(taskUrlById['glassdoor-1']),
        'every task URL is refreshed for sequential Solve telemetry');
      return { ok: true };
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
      assert(codeIncludesFull('NOTFULL') === false && codeIncludesFull('FULLISH') === false,
        'Bug report FULL detection: substrings are not FULL tokens');
      assert(codeIncludesFull('FULL') === true && codeIncludesFull('FULL+XNODES') === true && codeIncludesFull('ERR, FULL XSESS') === true,
        'Bug report FULL detection: exact and composed FULL tokens are recognized across supported separators');
      const filtered = applyBugReportCode(logs, {}, 'ERR+QUICK');
      assert(filtered.filteredLogs.length <= logs.length && filtered.matchedCodes.includes('ERR'), 'Bug report code filtering: ERR+QUICK should match ERR');
      const text = applyBugReportCode([...logs, '[TextEdit] input field=hub:primary type=historyUndo len=4 selection=2-2'], {}, 'TEXT');
      assert(text.filteredLogs.some(line => line.includes('[TextEdit]')) && text.matchedCodes.includes('TEXT'), 'Bug report code filtering: TEXT should retain text-edit diagnostics');
      const viewport = applyBugReportCode([...logs, 'viewport changed source=programmatic zoom=0.2818 x=-181.31 y=237.18'], {}, 'VIEWPORT');
      assert(viewport.filteredLogs.some(line => line.includes('viewport changed')) && viewport.matchedCodes.includes('VIEWPORT'), 'Bug report code filtering: VIEWPORT should retain zoom/pan diagnostics');
      const imagePreview = applyBugReportCode([...logs, '[local-file] Relinked missing preview image within current hierarchy'], {}, 'PREVIEW');
      assert(imagePreview.filteredLogs.some(line => line.includes('Relinked missing preview')) && imagePreview.matchedCodes.includes('PREVIEW'),
        'Bug report code filtering: PREVIEW should retain broken-preview and relink diagnostics');
      const form = applyBugReportCode([...logs, '[Focus] date "Must sell by" node=8e27f3ce'], {}, 'FORM');
      assert(form.filteredLogs.some(line => line.includes('[Focus]')) && form.matchedCodes.includes('FORM'),
        'Bug report code filtering: FORM should retain form-field focus events');
      const render = applyBugReportCode([...logs, '[RenderStorm] sellhub 8e27f3ce: 24 renders in 1000ms'], {}, 'RENDER');
      assert(render.filteredLogs.some(line => line.includes('[RenderStorm]')) && render.matchedCodes.includes('RENDER'),
        'Bug report code filtering: RENDER should retain render-storm diagnostics');
      const taxonomy = applyBugReportCode([...logs, '[Jobs][hub] Taxonomy repairs: canonicalized salary range', '[JobTree] expanded salary "$80k–$120k/yr"'], {}, 'TAXONOMY');
      assert(taxonomy.filteredLogs.some(line => line.includes('Taxonomy repairs')) && taxonomy.matchedCodes.includes('TAXONOMY'),
        'Bug report code filtering: TAXONOMY should retain taxonomy validation diagnostics');
      assert(taxonomy.sectionExclusions.has('nodes') && taxonomy.sectionExclusions.has('nodeInternals'),
        'Bug report code filtering: TAXONOMY should keep the compact pipeline while omitting heavy canvas payloads');
      const relevance = applyBugReportCode([...logs, '[Dice API] relevance rejected Maintenance Supervisor'], {}, 'RELEVANCE');
      assert(relevance.filteredLogs.some(line => line.includes('relevance rejected')) && relevance.matchedCodes.includes('RELEVANCE'),
        'Bug report code filtering: RELEVANCE should retain all-source title-gate diagnostics');
      const quality = applyBugReportCode([...logs, '[LinkedIn] description short: 98 chars'], {}, 'QUALITY');
      assert(quality.filteredLogs.some(line => line.includes('description short'))
        && quality.matchedCodes.includes('QUALITY')
        && quality.sectionExclusions.has('nodeInternals'),
      'Bug report code filtering: QUALITY keeps listing-field diagnostics and omits heavy canvas dumps');
      const cardWalk = applyBugReportCode([
        ...logs,
        '[JobSearch][hub] Searching with 1 query',
        '[JobBoard] results hidden as stale',
        '[BrowserScraper] Google for Jobs descriptions: 24/25 expanded',
        'unrelated renderer event',
      ], {}, 'CARDWALK');
      assert(cardWalk.filteredLogs.some(line => line.includes('Google for Jobs descriptions: 24/25 expanded'))
        && cardWalk.filteredLogs.some(line => line.includes('[JobSearch][hub]'))
        && cardWalk.matchedCodes.includes('CARDWALK')
        && cardWalk.sectionExclusions.has('nodeInternals'),
      'Bug report code filtering: CARDWALK retains browser-card traversal context while omitting heavy canvas dumps');
      const jobLink = applyBugReportCode([
        ...logs,
        '[JobCard] external-link requested id=job-1 source=google raw=www.google.com/search q=empty htidocid=present target=www.google.com/search repaired=yes',
        '[JobCard] external-link dispatched id=job-1 target=www.google.com/search',
      ], {}, 'JOBLINK');
      assert(jobLink.filteredLogs.some(line => line.includes('external-link requested'))
        && jobLink.filteredLogs.some(line => line.includes('external-link dispatched'))
        && jobLink.matchedCodes.includes('JOBLINK')
        && !jobLink.sectionExclusions.has('nodes')
        && jobLink.sectionExclusions.has('nodeInternals'),
      'Bug report code filtering: JOBLINK retains dispatch outcomes and lightweight card data while omitting heavy diagnostics');
      const sell = applyBugReportCode([...logs, '[SellHub][8e27f3ce] Price-drop plan updated: target=$0'], {}, 'SELL');
      assert(sell.filteredLogs.some(line => line.includes('target=$0')) && sell.matchedCodes.includes('SELL'),
        'Bug report code filtering: SELL should retain SellHub price-drop commits');
      assert(!sell.sectionExclusions.has('nodes') && sell.sectionExclusions.has('nodeInternals'),
        'Bug report code filtering: SELL should keep lightweight nodes for the SellHub rollup but drop node internals');
      const resolve = applyBugReportCode([...logs, '[SellHub][8e27f3ce] queued swappa-sold resolve for active resolve drain'], {}, 'RESOLVE');
      assert(resolve.filteredLogs.some(line => line.includes('active resolve drain')) && resolve.matchedCodes.includes('RESOLVE'),
        'Bug report code filtering: RESOLVE should retain source-resolve queue diagnostics');
      assert(resolve.sectionExclusions.has('nodes') && resolve.sectionExclusions.has('nodeComponentStates'),
        'Bug report code filtering: RESOLVE should rely on compact resolve state and drop heavy node payloads/diagnostics');
      const persist = applyBugReportCode([
        ...logs,
        '[StealthBrowser] linkedin login confirmed — waiting 2500ms for the auth cookie/profile checkpoint before closing',
        '[Accounts] Restored 3 prior connected session statuses from disk',
      ], {}, 'PERSIST');
      assert(persist.matchedCodes.includes('PERSIST')
        && persist.filteredLogs.some(line => line.includes('profile checkpoint'))
        && persist.filteredLogs.some(line => line.includes('Restored 3 prior')),
      'Bug report code filtering: PERSIST retains cross-restart auth durability evidence');
      assert(persist.sectionExclusions.has('nodes') && persist.sectionExclusions.has('mediaState'),
        'Bug report code filtering: PERSIST omits heavy canvas/media payloads');
      const recovery = applyBugReportCode([
        ...logs,
        '[Jobs][hub] Saved AI prompt snapshot to /tmp/job-search-last-scrape.json',
        '[JobSearch][hub] Resuming from saved scrape (12 job(s))',
      ], {}, 'RECOVERY');
      assert(recovery.matchedCodes.includes('RECOVERY')
        && recovery.filteredLogs.some(line => line.includes('Saved AI prompt snapshot'))
        && recovery.filteredLogs.some(line => line.includes('Resuming from saved scrape'))
        && recovery.sectionExclusions.has('nodes') && recovery.sectionExclusions.has('mediaState'),
      'Bug report code filtering: RECOVERY retains interrupted-job handoff/recovery evidence while omitting heavy canvas payloads');
      const preview = previewBugReportCode(logs, 'ERR+NOPE');
      assert(preview.unknownCodes.includes('NOPE') && preview.valid, 'Bug report code filtering: preview should report unknown codes while keeping valid matches');

      // XNODES drops the heavy per-node payload (so the clipboard cap doesn't
      // sacrifice the logs + timeline to a giant Node Diagnostics table), and
      // composes with FULL to mean "everything except the node table".
      const xnodes = applyBugReportCode(logs, {}, 'FULL+XNODES');
      assert(xnodes.sectionExclusions.has('nodeInternals') && xnodes.sectionExclusions.has('nodeComponentStates'),
        'Bug report code filtering: XNODES should exclude nodeInternals + nodeComponentStates');
      assert(xnodes.filteredLogs.length === logs.length,
        'Bug report code filtering: FULL+XNODES should keep all log lines (no log filtering)');
      for (const code of ['FULL+ERR', 'FULL+QUICK', 'FULL+XDRAG']) {
        const fullCombination = applyBugReportCode(logs, {}, code);
        assert(fullCombination.filteredLogs.length === logs.length,
          `Bug report code filtering: ${code} must preserve the full event timeline`);
      }
      const fullErrSummary = buildFilterSummaryMarkdown({
        filterCode: 'FULL+ERR',
        filterStats: { eventsShown: logs.length, eventsTotal: logs.length, omittedSections: [] },
      });
      assert(fullErrSummary.includes('Full report requested') && fullErrSummary.includes(`event log kept all ${logs.length} line(s)`),
        'Bug report filter summary: FULL+ERR remains a truthful full event timeline');
      // XSESS drops the verbose per-platform verify-trace blocks (bodyHead dumps).
      const xsess = applyBugReportCode(logs, {}, 'XSESS');
      assert(xsess.sectionExclusions.has('sessionTraces') && xsess.matchedCodes.includes('XSESS'),
        'Bug report code filtering: XSESS should exclude sessionTraces');
      // XJOBAUDIT drops only the bulky per-job/per-location audit prose inside
      // the Job Search Pipeline section (taxonomy placement, scoring evidence,
      // role relevance, Glassdoor location cache) — the one exclusion no other
      // code covers, needed because FULL alone still hit the clipboard cap on
      // this content and dropped whole unrelated sections to make room.
      const xjobaudit = applyBugReportCode(logs, {}, 'XJOBAUDIT');
      assert(xjobaudit.sectionExclusions.has('jobAuditDetail') && xjobaudit.matchedCodes.includes('XJOBAUDIT'),
        'Bug report code filtering: XJOBAUDIT should exclude jobAuditDetail');
      const fullXjobaudit = applyBugReportCode(logs, {}, 'FULL+XJOBAUDIT');
      assert(fullXjobaudit.sectionExclusions.has('jobAuditDetail')
        && fullXjobaudit.filteredLogs.length === logs.length,
      'Bug report code filtering: FULL+XJOBAUDIT keeps the full event timeline while still excluding jobAuditDetail');
      assert(codeIncludesFull('FULL+XJOBAUDIT') === true,
        'Bug report FULL detection: FULL+XJOBAUDIT is recognized as a FULL composition');
      const fullSummary = buildFilterSummaryMarkdown({
        filterCode: 'FULL',
        filterStats: { eventsShown: 69, eventsTotal: 69, omittedSections: [] },
      });
      assert(fullSummary.includes('event log kept all 69 line(s)'),
        'Bug report filter summary: FULL should say the event log was kept, not trimmed');
      assert(fullSummary.includes('Full report requested') && !fullSummary.includes('This is a filtered view'),
        'Bug report filter summary: plain FULL should not claim the report is filtered');
      const fullXnodesSummary = buildFilterSummaryMarkdown({
        filterCode: 'FULL+XNODES',
        filterStats: { eventsShown: 10, eventsTotal: 10, omittedSections: ['nodeInternals'] },
      });
      assert(fullXnodesSummary.includes('FULL was combined with section exclusions') && fullXnodesSummary.includes('sections omitted: nodeInternals'),
        'Bug report filter summary: FULL+exclusion explains unfiltered events and omitted sections');
      return { filtered: filtered.filteredLogs.length, unknown: preview.unknownCodes };
    },
  }
];
