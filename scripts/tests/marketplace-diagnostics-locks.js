import { PLATFORM_LOGIN_URLS, PRICE_SYNTHESIS_SCHEMA, RESUMABLE_MAX_AGE_MS, SELL_PLATFORMS, appendJobsHistory, assert, buildFinalListingTitle, buildItemQuery, buildMarketplacePipelineSnapshot, buildRefreshResearchItems, buildResearchItems, bundleSynergyForPrices, classifyCompScrapeFailure, classifyUnparseableSalary, clearRun, computeBundleTotal, computeMissingLogins, computeResumeStartPage, computeResumeStartPagesByQuery, createAggregatingProgress, createNonOverlappingRunner, dedupAgainstHistory, dedupKeysFor, deriveBundlePricingResult, filterGrosslyOffTargetSources, filterHistoryForResume, formatPricingNotesForPrompt, fs, getBrowserPoolQueueState, getMarketplaceBrowserQueueDepth, getMarketplaceHubStatusLabel, getMarketplaceTelemetry, getRequiredCompLoginPlatformIds, getSellMonitorConfig, getSharedProfileLockSnapshot, getSoftLoginWallMatch, getStatusCheckQueueDepth, hasMojibake, isConfirmedDisconnectedVerdict, isTrustedNativeLoginResult, loadJobsHistory, looksLikeMoney, markSourceStatus, modelTag, mojibakeExcerpt, normalizeBundlePricingResult, normalizePricingNotes, os, overPricedSoldFlag, parseSalaryToNumeric, path, pauseBrowserPool, queueScrape, readPageContentBounded, readRunState, readStagedJobs, recordSourcePage, recoverRefreshExtraItems, routeLegacyPriceSynthesisHandoff, selectBundleHeadline, selectListingPriceTiers, selectRestorableStatuses, setStage, startRun, summarizeJobLanguages, tagJobLanguages, taskMaxTokensFor, withMarketplaceBrowserLock, withSharedProfileLock, withStatusCheckLock } from '../test-dependencies.js';
import { isMarketplaceSourceLifecycleAbort, packBatchPriceSynthesisItems, validateBatchPriceSynthesisSubmission, validateMarketplaceBatchExecution } from '../../electron/ipc/marketplace.js';
import { collectMarketplaceRecoveryOwners } from '../../src/utils/canvasInteractions.js';
import { createWorkspaceStartupRecoveryCoordinator } from '../../src/utils/workspaceStartupRecovery.js';
import {
  abandonMarketplaceRecovery,
  abandonMarketplaceRecoveryBatch,
  acknowledgeMarketplaceRecovery,
  acquireMarketplaceRecoveryClaim,
  beginMarketplaceRecovery,
  checkpointMarketplaceRecovery,
  peekMarketplaceRecovery,
  prepareCanvasRecoveryRebind,
  __marketplaceRecoveryStoreForTests,
} from '../../electron/ipc/marketplaceRecoveryStore.js';
import { withCanvasRecoveryOwner, withCanvasRecoveryRebind } from '../../electron/ipc/canvasRecoveryPaths.js';
import {
  isAutomaticMarketplaceResolveIntent,
  markMarketplaceTerminalApplied,
  marketplaceTerminalReceiptApplied,
  marketplaceResolveInput,
  marketplaceResolveInputKey,
  marketplaceResearchIdentityMatches,
  marketplaceResearchInput,
  marketplaceResearchInputKey,
  marketplaceResearchInputMatches,
  marketplaceStatusInputMatches,
  mergeMarketplaceSourceCheckpoint,
  mergeMarketplaceStatusPrepared,
  newMarketplaceRecovery,
  newMarketplaceStatusRecovery,
  recordMarketplaceStatusResult,
} from '../../src/utils/marketplaceRunRecovery.js';

export default [
{
    name: 'legacy singleton price handoff: an exact durable old step alone keeps its 24,576-token replay contract',
    run: async () => {
      const legacyPrompt = 'legacy price prompt bytes: sold=[{"title":"old"}]';
      const legacyHints = { itemCount: 108 };
      const calls = [];
      let probe;
      const result = await routeLegacyPriceSynthesisHandoff({
        legacyPrompt,
        legacyHints,
        manualAiRunId: 'run-exact',
        nodeId: 'node-exact',
        batchItem: { itemId: 'price-exact', soldComps: [], activeComps: [] },
        exactStepProbe: async (prompt, options) => {
          probe = { prompt, options };
          return true;
        },
        callText: async (prompt, options) => {
          calls.push({ prompt, options });
          return { recommended_price: 42, match_quality: 'strong' };
        },
      });
      assert(probe.prompt === legacyPrompt
        && probe.options.manualAiRunId === 'run-exact'
        && probe.options.nodeId === 'node-exact'
        && probe.options.task === 'price-synthesis'
        && probe.options.exactLegacyPriceSynthesisHandoff === true,
      'only an exact, run-and-node-scoped durable probe may select the historical singleton handoff');
      assert(calls.length === 1 && calls[0].prompt === legacyPrompt
        && calls[0].options.task === 'price-synthesis'
        && calls[0].options.exactLegacyPriceSynthesisHandoff === true
        && result.usedLegacyHandoff === true && result.pricing.recommended_price === 42,
      'the accepted/pending old step replays its prompt unchanged with the identical narrow cap override');
      assert(taskMaxTokensFor('price-synthesis', legacyHints) === 16384,
        'the public task cap is hard-clamped; only the exact legacy replay override retains its historical 24,576 seed');
      return { replayedExactStep: true };
    },
  },
  {
    name: 'legacy singleton price handoff: a fresh call uses v2 singleton cap, isolation, and provenance instead of the old prompt',
    run: async () => {
      const calls = [];
      const batchItem = {
        itemId: 'price-v2-singleton',
        query: 'Widget',
        condition: 'Used - Good',
        userPricingNotes: 'Includes original box',
        soldComps: [{ title: 'Widget sold', price: 100, url: 'https://example.test/sold', source: 'sold-source' }],
        activeComps: [{ title: 'Widget active', price: 120, url: 'https://example.test/active', source: 'active-source' }],
      };
      const pricing = {
        recommended_price: 105, quick_sell_price: 95, max_profit_price: 125,
        justification: 'The supplied sold listing anchors the price.', match_quality: 'moderate',
        comp_breakdown: { anchor_count: 1, adjusted_count: 0, bound_count: 1 },
        market_summary: { sold_count: 1, active_count: 1 }, recommended_platforms: [],
      };
      const result = await routeLegacyPriceSynthesisHandoff({
        legacyPrompt: 'OLD NAKED SCRAPED COMPS MUST NOT BE SENT',
        legacyHints: { itemCount: 2 },
        manualAiRunId: 'fresh-run',
        nodeId: 'fresh-node',
        batchItem,
        exactStepProbe: async () => false,
        callText: async (prompt, options) => {
          calls.push({ prompt, options });
          return { items: [{ itemId: batchItem.itemId, pricing, compSourceUrls: ['https://example.test/sold'], compSources: ['sold-source'] }] };
        },
      });
      assert(calls.length === 1 && calls[0].options.task === 'price-synthesis-batch'
        && taskMaxTokensFor(calls[0].options.task, calls[0].options.hints) <= 15360
        && !calls[0].prompt.includes('OLD NAKED SCRAPED COMPS MUST NOT BE SENT')
        && calls[0].prompt.includes('=== PRICING ITEM price-v2-singleton ===')
        && calls[0].prompt.includes('DATA scraped from an external source')
        && calls[0].prompt.includes('<untrusted-price-synthesis-price-v2-singleton-'),
      'a fresh legacy IPC call issues exactly one capped v2 prompt with item isolation and wrapped untrusted listings');
      assert(result.usedLegacyHandoff === false && result.pricing === pricing
        && result.modelItem === batchItem,
      'the v2 singleton validates source provenance yet returns the historical { pricing } result shape');
      const marketplaceSource = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/marketplace.js'), 'utf8');
      assert((marketplaceSource.match(/exactLegacyPriceSynthesisHandoff: true/g) || []).length === 2,
        'the 24,576 compatibility override is passed only to the exact probe and exact replay, never fresh production work');
      return { freshTask: calls[0].options.task, provenanceBound: true };
    },
  },
{
    name: 'bundle price synthesis batches: pack by output ceiling and bind comp provenance to opaque item IDs',
    run: () => {
      const makeItem = (itemId, count) => ({
        itemId,
        soldComps: Array.from({ length: count }, (_, index) => ({ url: `https://example.test/${itemId}/${index}`, source: 'example' })),
        activeComps: [],
      });
      const items = [makeItem('price-a', 40), makeItem('price-b', 40)];
      const batches = packBatchPriceSynthesisItems(items);
      assert(batches.length === 2 && batches[0][0].itemId === 'price-a' && batches[1][0].itemId === 'price-b',
        'items exceeding 1024 + 900*n + 200*comps <= 15360 split deterministically without reordering');
      const pricing = {
        recommended_price: 100, quick_sell_price: 90, max_profit_price: 120,
        justification: 'Matched the supplied listing.', match_quality: 'moderate',
        comp_breakdown: { anchor_count: 1, adjusted_count: 0, bound_count: 0 },
        market_summary: { sold_count: 1, active_count: 0 }, recommended_platforms: [],
      };
      validateBatchPriceSynthesisSubmission({ items: [{ itemId: 'price-a', pricing, compSourceUrls: ['https://example.test/price-a/0'], compSources: ['example'] }] }, [items[0]]);
      let crossed = false;
      try {
        validateBatchPriceSynthesisSubmission({ items: [{ itemId: 'price-a', pricing, compSourceUrls: ['https://example.test/price-b/0'], compSources: ['example'] }] }, [items[0]]);
      } catch {
        crossed = true;
      }
      let crossedSource = false;
      try {
        validateBatchPriceSynthesisSubmission({ items: [{ itemId: 'price-a', pricing, compSourceUrls: ['https://example.test/price-a/0'], compSources: ['other-item-source'] }] }, [items[0]]);
      } catch {
        crossedSource = true;
      }
      assert(crossed && crossedSource, 'a response cannot cite a listing URL or source id from another pricing item');
      const marketplaceSource = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/marketplace.js'), 'utf8');
      assert(marketplaceSource.includes('resolved = await mapAutomaticHandoffs(')
        && marketplaceSource.includes('batchMetadata,\n        HANDOFF_CONCURRENCY,')
        && marketplaceSource.includes('await mapManualHandoffWaves(')
        && marketplaceSource.includes('batchesWithProgress,\n        HANDOFF_CONCURRENCY,'),
      'automatic price synthesis refills the shared ten-slot roster, while manual hub scans keep their stable bounded work sets');
      return { batches: batches.length, provenanceBound: true };
    },
  },
  {
    name: 'bundle price synthesis: fresh renderer flow reaches the versioned batch IPC endpoint',
    run: () => {
      const preload = fs.readFileSync(path.join(process.cwd(), 'electron/preload.js'), 'utf8');
      const hook = fs.readFileSync(path.join(process.cwd(), 'src/hooks/useListingActions.js'), 'utf8');
      const hub = fs.readFileSync(path.join(process.cwd(), 'src/nodes/SellHubNode.jsx'), 'utf8');
      const main = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/marketplace.js'), 'utf8');
      assert(preload.includes("synthesizePricesBatch: (args) => ipcRenderer.invoke('synthesize-prices-batch', args)")
        && hook.includes('window.electronAPI.synthesizePricesBatch({')
        && hub.includes('const synthResults = await synthesizePricesBatch(aiItems, manualAiRunId, synthesisRecovery, options.autoResume === true);')
        && !hub.includes('const synthResult = await synthesizePrice(comps, overrides);')
        && main.includes("handleSafe('synthesize-prices-batch'")
        && main.includes("handleSafe('synthesize-price'"),
      'every fresh SellHub pricing request, including a singleton, must traverse the identity-keyed batch endpoint while the legacy handler remains available only for compatibility');
      return { rendererBatchRoute: true };
    },
  },
  {
    name: 'auth polling: async interval ticks never overlap slow CDP/osascript work',
    run: async () => {
      let release;
      let active = 0;
      let maxActive = 0;
      let calls = 0;
      const gate = new Promise(resolve => { release = resolve; });
      const poll = createNonOverlappingRunner(async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await gate;
        active -= 1;
      });
      const first = poll();
      await Promise.resolve();
      const skipped = await poll();
      assert(skipped === false && calls === 1 && maxActive === 1,
        'a cadence tick arriving during a slow poll must be skipped');
      release();
      assert(await first === true, 'the original poll completes normally');
      assert(await poll() === true && calls === 2 && maxActive === 1,
        'the runner admits a later tick after the prior one settles');
      return { calls, maxActive };
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
      assert(/Montréal/.test(sum.samples.fr?.label || ''), `fr sample names the listing → ${JSON.stringify(sum.samples.fr)}`);
      assert(/Nous recherchons/.test(sum.samples.fr?.evidence || ''),
        `fr sample carries bounded language evidence → ${JSON.stringify(sum.samples.fr)}`);
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
    name: 'marketplace auth gate: only conclusive disconnects become needs-login',
    run: () => {
      assert(isConfirmedDisconnectedVerdict({ connected: false, reason: 'redirected to login' }) === true,
        'explicit disconnected verdict gates the marketplace scan');
      assert(isConfirmedDisconnectedVerdict({ connected: false, inconclusive: true, reason: 'network timeout' }) === false,
        'inconclusive transport failure must not masquerade as logout');
      assert(isConfirmedDisconnectedVerdict({ connected: true }) === false, 'connected verdict is not a disconnect');
      assert(isConfirmedDisconnectedVerdict(null) === false, 'missing verifier result is not proof of logout');
      return { ok: true };
    },
  },
{
    name: 'listing-card check-and-login uses the shared post-login verifier',
    run: () => {
      const src = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/accounts.js'), 'utf8');
      const start = src.indexOf("handleSafe('check-and-login'");
      const end = src.indexOf('// ── Sell Monitor Auth', start);
      const handler = src.slice(start, end);
      assert(start !== -1 && end !== -1, 'check-and-login handler must be present');
      assert(/completeLoginWindowVerification\(platformId,\s*loginResult\)/.test(handler),
        'check-and-login must use the same post-window verifier as open-login-window');
      assert(!/verifySellMonitorLogin\(platformId\)/.test(handler),
        'check-and-login must not bypass retry/inconclusive-preserve with a raw verify call');
      return { ok: true };
    },
  },
{
    // Session-cache persistence (fixes "have to log in every restart"): only RECENT
    // connected statuses are restored across launches, so the existing inconclusive-
    // preserve logic survives a restart. Stale/not-connected/garbage entries must NOT
    // be restored — a fresh verify must decide those.
    name: 'session persistence: selectRestorableStatuses keeps only recent connected entries',
    run: () => {
      const now = 1_000_000_000_000;
      const day = 24 * 60 * 60 * 1000;
      const stored = {
        ebay:     { connected: true,  ts: now - 2 * day,  lastReason: 'reached summary' }, // recent connected → restore
        swappa:   { connected: true,  ts: now - 30 * day, lastReason: 'old' },             // too old → drop
        facebook: { connected: false, ts: now - 1 * day,  lastReason: 'logged out' },      // not-connected → drop
        depop:    { connected: true,  ts: 0 },                                             // no ts → drop
        junk:     null,                                                                    // garbage → skip
      };
      const out = selectRestorableStatuses(stored, now, 14 * day);
      assert(Object.keys(out).length === 1 && out.ebay, `only the recent connected entry restored (got ${JSON.stringify(out)})`);
      assert(out.ebay.connected === true && out.ebay.restoredFromDisk === true, 'restored entry is flagged restoredFromDisk so the bug report can tell it apart');
      assert(out.ebay.ts === now - 2 * day, 'restored entry preserves the original confirmation timestamp (so its age shows it is a prior-session status)');
      assert(Object.keys(selectRestorableStatuses(null, now)).length === 0, 'no persisted blob → nothing restored');
      assert(Object.keys(selectRestorableStatuses({}, now)).length === 0, 'empty blob → nothing restored');
      return { ok: true };
    },
  },
{
    // The reported "mercari shows not logged in even after logging in": its native
    // login auto-detected /mypage with a real title, but the post-login CDP verify
    // WEDGED (anti-bot reload loop) → inconclusive → kept prior not-connected. The fix:
    // trust the title-validated native login for CDP-walled platforms (mercari) instead
    // of routing them to a doomed HTTP verify.
    name: 'login trust: CDP-walled inline-login (mercari) trusts the title-validated native auto-detect',
    run: () => {
      const native = (currentUrl, title) => ({ nativeChrome: true, result: 'auto-detected', currentUrl, title });
      if (process.platform === 'darwin') {
        // Real post-login landing: /mypage with a settled hub title → TRUSTED (skip the
        // doomed CDP verify that was telling the just-logged-in user they're logged out).
        assert(isTrustedNativeLoginResult('mercari', native('https://www.mercari.com/mypage/listings/active/', 'My listings | Mercari')) === true,
          'mercari native login on /mypage with a real hub title → trusted (no doomed CDP re-verify)');
        // The title guard still holds: an empty/loading or logged-out title is NOT trusted
        // (isNativeLoginSuccess rejects it), so a render-race can't cache a false connected.
        assert(isTrustedNativeLoginResult('mercari', native('https://www.mercari.com/mypage/listings/active/', '')) === false,
          'mercari native auto-detect with EMPTY title → NOT trusted (title-render race guard intact)');
        assert(isTrustedNativeLoginResult('mercari', native('https://www.mercari.com/mypage/listings/active/', 'Log in | Mercari')) === false,
          'mercari native auto-detect with a logged-out title → NOT trusted');
      }
      // swappa (native-login, NOT inline) was already trusted — must remain so.
      assert(isTrustedNativeLoginResult('swappa', native('https://swappa.com/my/swappa', 'My Swappa - Swappa')) === true,
        'swappa native login on /my/swappa → trusted (regression guard)');
      // Non-native results are never trusted (must go through the normal verify).
      assert(isTrustedNativeLoginResult('mercari', { nativeChrome: false, result: 'auto-detected', currentUrl: 'https://www.mercari.com/mypage/listings/active/', title: 'My listings | Mercari' }) === false,
        'a non-native (puppeteer) result is not a trusted NATIVE login');
      assert(isTrustedNativeLoginResult('mercari', native('https://www.mercari.com/login/', 'Login to Your Account | Mercari')) === false,
        'still ON the /login page (not yet redirected to /mypage) → not trusted');
      return { ok: true };
    },
  },
{
    name: 'marketplace hub status labels: distinguish unchecked from inconclusive',
    run: () => {
      assert(getMarketplaceHubStatusLabel('unknown', null) === 'Not checked', 'hub unknown without timestamp means not checked');
      assert(getMarketplaceHubStatusLabel('unknown', '2026-06-03T19:39:47.686Z') === 'Unknown', 'checked hub unknown is labeled inconclusive, not not-checked');
      assert(getMarketplaceHubStatusLabel('ok', '2026-06-03T19:39:47.686Z') === 'Checked', 'hub ok label is checked');
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
    name: 'marketplace pipeline report: product-title condition cleanup is explicit',
    run: () => {
      const telemetry = getMarketplaceTelemetry();
      const saved = { ...telemetry };
      Object.assign(telemetry, {
        nodeId: 'title-cleanup-hub',
        windowId: 6,
        analyze: {
          ts: Date.now(),
          photos: 5,
          rawTitle: 'Modern Round Wood Coffee Table - Excellent Condition',
          title: 'Modern Round Wood Coffee Table',
          titleCleaned: true,
          condition: 'Used - Excellent',
          model: 'gemini-3.5-flash',
        },
        scrape: null,
        resolves: {},
        synthesis: null,
        syntheses: [],
        bundle: null,
        fit: null,
      });
      try {
        const report = buildMarketplacePipelineSnapshot(new Set(['title-cleanup-hub']), 6);
        assert(report.includes('condition: `Used - Excellent`'), 'FULL report preserves the selected condition');
        assert(report.includes('product title captured (withheld)') && report.includes('title normalization applied')
          && !report.includes('Modern Round Wood Coffee Table'),
          'FULL report retains title-cleanup state without exporting the product title');
      } finally {
        Object.assign(telemetry, saved);
      }
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
        assert(report.includes('Item 1 · item label captured · query recorded') && report.includes('Item 2 · item label captured · query recorded')
          && !report.includes('Watering Timer') && !report.includes('Glass Jug'),
          'bundle report retains per-item structural scrape evidence without item titles or queries');
        assert(!report.includes('query term(s) absent from the title'),
          'no drift flag when each query matches its item title');
        assert((report.match(/Price synthesis — item correlation withheld/g) || []).length === 2,
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
        assert(/priced query does not match the captured product title/.test(item1Line) && !/exotac/i.test(item1Line),
          `drifted item 1 is flagged without exposing the title/query terms — got: ${item1Line}`);
        const item2Line = report.split('\n').find(l => l.includes('Item 2')) || '';
        assert(!/priced query does not match the captured product title/.test(item2Line),
          `the clean item 2 (query ⊆ title) is NOT flagged — got: ${item2Line}`);
        const item3Line = report.split('\n').find(l => l.includes('Item 3')) || '';
        assert(!/priced query does not match the captured product title/.test(item3Line),
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
    name: 'marketplace pipeline report: overlapping price checks are attributed per-stage, not under one headline node',
    run: () => {
      const telemetry = getMarketplaceTelemetry();
      const saved = { ...telemetry };
      const now = Date.now();
      // Two price checks overlap: check B (node-B) started its scrape — and
      // re-stamped the singleton headline nodeId — while check A (node-A) was
      // still in its post-scrape (unlocked) synthesis/fit phase. So at report
      // time the scrape belongs to node-B but the synthesis + fit belong to
      // node-A. Without per-stage nodeId the whole funnel reads as node-B's.
      Object.assign(telemetry, {
        nodeId: 'node-B', windowId: 9, analyze: null,
        scrape: {
          ts: now - 30000, nodeId: 'node-B', sources: 9, items: 2, sold: 0, active: 0,
          warnings: 0, blocked: 0, errored: 0, timedOut: 0, loginRequired: 0,
          bySource: {}, sourceWarnings: {},
          itemDetails: [
            { index: 0, query: 'Rode NT4', label: 'Rode NT4', sold: 0, active: 0, warnings: [] },
            { index: 1, query: 'Rycote Windshield', label: 'Rycote Windshield', sold: 0, active: 0, warnings: [] },
          ],
        },
        resolves: {},
        synthesis: { ts: now - 60000, nodeId: 'node-A', soldFound: 10, activeFound: 5, soldUsed: 10, activeUsed: 5, recommendedPrice: 200, matchQuality: 'good' },
        syntheses: [{ ts: now - 60000, nodeId: 'node-A', soldFound: 10, activeFound: 5, soldUsed: 10, activeUsed: 5, recommendedPrice: 200, matchQuality: 'good' }],
        bundle: null,
        fit: { ts: now - 27000, nodeId: 'node-A', platforms: 8, good: 5, unfit: 3 },
      });
      try {
        const report = buildMarketplacePipelineSnapshot(new Set(['node-A', 'node-B']), 9);
        // Top-of-section warning fires and names the foreign node.
        assert(/Overlapping price checks/.test(report), 'overlap warning is rendered when stages span >1 node');
        assert(/from node `#[a-f0-9]{10}`/.test(report) && !/node-A/.test(report), 'overlap note names the foreign stage through a digest');
        // The scrape (headline node) carries NO foreign tag; synthesis + fit DO.
        const scrapeHdr = report.split('\n').find(l => l.startsWith('### Comp scrape')) || '';
        const synthHdr = report.split('\n').find(l => l.startsWith('### Price synthesis')) || '';
        const fitHdr = report.split('\n').find(l => l.startsWith('### Platform fit')) || '';
        assert(scrapeHdr && !/from node/.test(scrapeHdr), 'headline-node scrape header is NOT tagged foreign');
        assert(/from node `#[a-f0-9]{10}`/.test(synthHdr), 'synthesis header is tagged with its owning foreign node digest');
        assert(/from node `#[a-f0-9]{10}`/.test(fitHdr), 'fit header is tagged with its owning foreign node digest');

        // Control: a clean single-node run (every stage = headline node) renders
        // NO overlap warning and NO per-stage tag (don't cry wolf).
        Object.assign(telemetry, {
          nodeId: 'node-A',
          scrape: { ...telemetry.scrape, nodeId: 'node-A' },
        });
        const clean = buildMarketplacePipelineSnapshot(new Set(['node-A']), 9);
        assert(!/Overlapping price checks/.test(clean), 'no overlap warning when every stage shares the headline node');
        assert(!/from node/.test(clean), 'no per-stage foreign tag on a clean single-node run');

        // A foreign ANALYZE alone (stale photo analysis from a Refresh-Prices on a
        // different node) must NOT trip the concurrency warning — but it is still
        // tagged honestly. Pricing stages here all share the headline node.
        Object.assign(telemetry, {
          nodeId: 'node-A',
          analyze: { ts: now - 90000, nodeId: 'node-Z', photos: 3, title: 'Old item' },
          scrape: { ...telemetry.scrape, nodeId: 'node-A' },
          synthesis: null, syntheses: [], fit: null,
        });
        const staleAnalyze = buildMarketplacePipelineSnapshot(new Set(['node-A']), 9);
        assert(!/Overlapping price checks/.test(staleAnalyze), 'a foreign analyze alone does NOT trigger the concurrency warning');
        const analyzeHdr = staleAnalyze.split('\n').find(l => l.startsWith('### Product analysis')) || '';
        assert(/from node `#[a-f0-9]{10}`/.test(analyzeHdr) && !/node-Z/.test(analyzeHdr), 'a stale foreign analyze is still tagged with its owning digest');
      } finally {
        Object.assign(telemetry, saved);
      }
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
    // Every sellable platform must be wired into ALL the registries the
    // login/verify flow touches — not just the sell-monitor config. AptDeco
    // shipped in SELL_PLATFORMS + SELL_MONITOR_PLATFORMS but was MISSING from
    // PLATFORM_LOGIN_URLS, so clicking "Log in" threw "Unknown platform: aptdeco"
    // in openLoginWindow. This invariant catches that whole class of half-wired
    // platform before it reaches a user.
    name: 'every SELL_PLATFORMS id is fully wired (login URL + sell-monitor config)',
    run: () => {
      const missingLoginUrl = [];
      const missingMonitor = [];
      for (const { id } of SELL_PLATFORMS) {
        if (!PLATFORM_LOGIN_URLS[id]) missingLoginUrl.push(id);
        if (!getSellMonitorConfig(id)) missingMonitor.push(id);
      }
      assert(missingLoginUrl.length === 0,
        `SELL_PLATFORMS missing a PLATFORM_LOGIN_URLS entry (openLoginWindow would throw "Unknown platform"): ${missingLoginUrl.join(', ')}`);
      assert(missingMonitor.length === 0,
        `SELL_PLATFORMS missing a sell-monitor auth config: ${missingMonitor.join(', ')}`);
      // AptDeco specifically — the platform from the bug report.
      assert(/aptdeco\.com/.test(PLATFORM_LOGIN_URLS.aptdeco || ''), `aptdeco login URL → ${PLATFORM_LOGIN_URLS.aptdeco}`);
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

      // (d') When the browser pool folded a [timeout-state …] diag into the error
      //      (finalUrl/bodyLen/title/bodyHead — see enrichTimeoutError), the whole
      //      snippet must survive into evidence, not get chopped by the default
      //      300-char cap. This is the field that tells page-never-loaded
      //      (bodyLen=0) apart from a slow/tarpitting site (real body) — the gap
      //      that let the poshmark/swappa timeout root-cause hide as generic tarpit.
      const longBody = 'x'.repeat(260);
      const enriched = classifyCompScrapeFailure(
        `Scrape timed out after 39107ms for https://poshmark.com/search [timeout-state finalUrl=https://poshmark.com/search bodyLen=0 title="Just a moment..." bodyHead="${longBody}"]`,
        'poshmark', loggedOut,
      );
      assert(enriched.code === 'scrape-timeout', `enriched timeout still → scrape-timeout, got ${enriched.code}`);
      assert(/\[timeout-state /.test(enriched.evidence), `evidence must retain the timeout-state marker → ${enriched.evidence}`);
      assert(/bodyLen=0/.test(enriched.evidence), 'evidence must retain bodyLen (the page-never-loaded tell)');
      assert(/Just a moment/.test(enriched.evidence), 'evidence must retain the captured title');
      assert(enriched.evidence.length > 300, `enriched evidence should exceed the default 300-char cap → len ${enriched.evidence.length}`);

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
      assert(modelTag('gemini-3.5-flash') === ' · model: `gemini-3.5-flash`', 'modelTag: top model bare');
      // Lite model with no recorded reason → legacy bare weak-fallback flag.
      assert(modelTag('gemini-3.1-flash-lite') === ' · model: `gemini-3.1-flash-lite` ⚠️ weak fallback', 'modelTag: lite without reason');
      // Lite model WITH reason → reason is surfaced (the gap this closes): a
      // reader sees quota (external) vs truncation (our cap) without the logs.
      const quota = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit' });
      assert(quota.includes('⚠️ weak fallback (rate-limit: 3 earlier model(s) failed)'), `modelTag: lite with reason → ${quota}`);
      // Non-lite model that still fell back → lighter "↪ fell back" note.
      const partial = modelTag('gemini-3.5-flash', { attempts: 1, reason: 'truncation' });
      assert(partial.includes('↪ fell back (truncation: 1 earlier model(s) failed)'), `modelTag: non-lite partial fallback → ${partial}`);
      assert(!partial.includes('weak fallback'), 'modelTag: non-lite is not flagged weak');
      // MIXED chain (the reported trap): 2 quota + 1 truncation. `reason` alone
      // would say only "rate-limit" and hide the truncation (whose fix — raise our
      // cap — is the opposite of quota's). counts must drive a breakdown.
      const mixed = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit', counts: { 'rate-limit': 2, truncation: 1 } });
      assert(mixed.includes('rate-limit×2 + truncation×1: 3 earlier model(s) failed'), `modelTag: mixed chain must show breakdown → ${mixed}`);
      // Single-cause counts → no ×N noise, falls back to the plain reason.
      const single = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit', counts: { 'rate-limit': 3 } });
      assert(single.includes('(rate-limit: 3 earlier model(s) failed)'), `modelTag: single-cause stays plain → ${single}`);
      assert(modelTag('gemini-3.1-flash-lite', { attempts: 0, preferredModel: 'gemini-3.1-flash-lite' })
        === ' · model: `gemini-3.1-flash-lite`', 'a preferred Lite model is not mislabeled as weak fallback');
      return { ok: true };
    },
  },
{
    name: 'jobQualityChecks: looksLikeMoney/hasMojibake/mojibakeExcerpt — previously only reachable via a full bug-report payload',
    run: () => {
      assert(looksLikeMoney('$50,000'), 'looksLikeMoney: dollar sign');
      assert(looksLikeMoney('USD55 - USD65'), 'looksLikeMoney: compact ISO currency prefix from live Dice data');
      assert(looksLikeMoney('70,000 - 95,000'), 'looksLikeMoney: comma-grouped thousands range, no currency symbol');
      assert(looksLikeMoney('$45/hr'), 'looksLikeMoney: hourly rate');
      assert(looksLikeMoney('120k'), 'looksLikeMoney: k-suffix');
      assert(!looksLikeMoney('40 - 50'), 'looksLikeMoney: ambiguous tiny range (no grouping) is NOT monetary');
      assert(!looksLikeMoney('Full-time, remote'), 'looksLikeMoney: schedule text is NOT monetary');
      // A bare "401k" (no "$") is a retirement-plan term, not salary shorthand —
      // parseSalaryToNumeric already special-cases it as "never pay". Without the
      // matching exclusion here, classifyUnparseableSalary below would call this
      // benefits blurb a fixable cadence-lost extractor bug instead of prose.
      assert(!looksLikeMoney('401k matching'), 'looksLikeMoney: bare "401k" benefits term is NOT monetary');
      assert(looksLikeMoney('$401k matching'), 'looksLikeMoney: an explicit "$" still makes a 401k-shaped figure monetary');

      assert(!hasMojibake('Ingénieur logiciel — Paris, France'), 'hasMojibake: legit accented text is not flagged');
      const corrupted = 'na' + String.fromCharCode(0x80) + String.fromCharCode(0x99) + 've';
      assert(hasMojibake(corrupted), 'hasMojibake: C1 control chars are flagged');
      assert(mojibakeExcerpt('clean text') === null, 'mojibakeExcerpt: no corruption → null');
      const excerpt = mojibakeExcerpt(corrupted);
      assert(typeof excerpt === 'string' && excerpt.includes('�'), `mojibakeExcerpt: replaces bad bytes with U+FFFD — got ${JSON.stringify(excerpt)}`);
      return { ok: true };
    },
  },
{
    // classifyUnparseableSalary is the helper that replaced looksLikeMoney as the
    // bug report's salary-health arbiter (see jobQualityChecks.js). It only makes
    // sense to call on a salary the REAL annualizer (parseSalaryToNumeric)
    // couldn't turn into a usable figure — callers gate on `=== 0` first, exactly
    // like the field-quality loop in jobsSnapshot.js does — so every fixture here
    // is checked against parseSalaryToNumeric directly rather than assumed.
    name: 'jobQualityChecks: classifyUnparseableSalary splits unparseable salary causes',
    run: () => {
      // Prose: nothing resembling pay, present but genuinely nothing to extract —
      // not our bug. "401k matching" is the case looksLikeMoney used to get wrong
      // (see the k-suffix regression test above) — worth asserting through the
      // classifier too, since that's the function jobsSnapshot.js actually calls.
      for (const s of ['Competitive salary', 'DOE', '401k matching']) {
        assert(parseSalaryToNumeric(s) === 0, `precondition: "${s}" must be unparseable for this to be a meaningful prose case`);
        assert(classifyUnparseableSalary(s) === 'prose', `classifyUnparseableSalary: "${s}" → prose (nothing to extract, not our bug)`);
      }

      // Money-with-cadence: a fully healthy salary. Never reaches
      // classifyUnparseableSalary in jobsSnapshot.js's real gate (it only calls the
      // classifier when parseSalaryToNumeric returns 0) — asserted here so the
      // "healthy" half of the split is pinned down alongside the unparseable half.
      assert(parseSalaryToNumeric('$22/hour') > 0, 'money-with-cadence: annualizes to a real figure, never reaches the classifier');

      // Money-with-lost-cadence: still reads as an attempt at money (looksLikeMoney)
      // but the annualizer can't recover a usable figure — OUR bug, fixable.
      // Deliberately NOT the two exact strings ('$22.31 - $22.31 / PH', '$20 - $24')
      // another agent is concurrently making parseable at the extractor level —
      // different digits, same shape, so this test doesn't rot when that lands.
      for (const s of ['$18 - $19', '$24.10 - $24.10 / PH', 'USD55 - USD65']) {
        assert(parseSalaryToNumeric(s) === 0, `precondition: "${s}" must be unparseable for this to be a meaningful lost-cadence case`);
        assert(looksLikeMoney(s), `precondition: "${s}" must still look monetary for this to land in the lost-cadence bucket`);
        assert(classifyUnparseableSalary(s) === 'lost-cadence', `classifyUnparseableSalary: "${s}" → lost-cadence (money-shaped, our extractor's bug, fixable)`);
      }
      assert(parseSalaryToNumeric('$18.75 - $19.70 a year') === 0,
        'precondition: implausibly tiny explicit annual pay is rejected by the annualizer');
      assert(classifyUnparseableSalary('$18.75 - $19.70 a year') === 'implausible-annual',
        'implausibly tiny explicit annual pay is distinguished from a missing cadence');

      // Comma-grouped bare numbers ("70,000 - 95,000") and large bare ranges
      // ("38000 - 40000", the real Dice false-alarm) both annualize successfully —
      // they must never reach the unparseable/classifier path at all, regardless
      // of looksLikeMoney's verdict (looksLikeMoney is false for "38000 - 40000",
      // which is exactly the false alarm this fix closes: the old code used
      // looksLikeMoney itself as the health check, so this used to get flagged
      // "salary garbage" despite parsing correctly).
      assert(parseSalaryToNumeric('70,000 - 95,000') > 0, 'comma-grouped bare range parses fine, never reaches the classifier');
      assert(parseSalaryToNumeric('38000 - 40000') > 0, 'Dice false-alarm regression: bare 5-digit range parses fine despite looksLikeMoney being false for it');
      assert(!looksLikeMoney('38000 - 40000'), 'sanity: this is exactly the shape the OLD looksLikeMoney-as-arbiter check used to misflag');

      // Empty/absent: jobsSnapshot.js only enters the present-salary branch when
      // `(j.salary || '').trim()` is truthy, so empty/whitespace-only/absent
      // salaries never reach either parseSalaryToNumeric or the classifier —
      // pin that down directly since it's the gate the real report loop relies on.
      for (const s of ['', '   ', undefined, null]) {
        assert(!(s || '').trim(), `precondition: "${s}" must be treated as absent by the field-quality presence gate`);
        assert(parseSalaryToNumeric(s) === 0, `parseSalaryToNumeric("${s}") is 0 for empty/absent input (never counted as present, so this value is informational only)`);
      }
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

      // A Reset/delete can abort a source card while it is queued behind a
      // different browser operation. Its callback must never start (opening a
      // login/window after the card disappeared) and its abandoned queue slot
      // must still let the next live operation acquire normally.
      let releaseHead;
      const headGate = new Promise(resolve => { releaseHead = resolve; });
      const sharedDepthBefore = getSharedProfileLockSnapshot().queueDepth;
      const head = withSharedProfileLock(() => headGate);
      await Promise.resolve();
      const controller = new AbortController();
      let ranAborted = false;
      const queued = withSharedProfileLock(() => { ranAborted = true; }, controller.signal);
      controller.abort();
      let timeoutId;
      const earlyAbort = await Promise.race([
        queued.then(() => 'resolved', error => error?.name),
        new Promise(resolve => { timeoutId = setTimeout(() => resolve('timed-out'), 100); }),
      ]);
      clearTimeout(timeoutId);
      assert(getSharedProfileLockSnapshot().queueDepth === sharedDepthBefore + 2,
        'an early-aborted caller remains in physical FIFO depth until its queued no-op reaches the head');
      const follower = withSharedProfileLock(async () => 'live-follower');
      releaseHead();
      assert(earlyAbort === 'AbortError' && ranAborted === false
        && await head === undefined && await follower === 'live-follower',
      `an aborted queued profile operation never starts and does not wedge its follower — got ${earlyAbort}`);
      assert(getSharedProfileLockSnapshot().queueDepth === sharedDepthBefore,
        'shared FIFO depth returns to baseline after the aborted physical slot settles');
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

      // A real AbortSignal must also reject promptly WHILE queued. Merely
      // checking `signal.aborted` once the held lock eventually releases leaves
      // a cancelled IPC pending indefinitely behind a user-held browser flow.
      let releaseHead;
      const headGate = new Promise(resolve => { releaseHead = resolve; });
      const head = withStatusCheckLock(() => headGate);
      await Promise.resolve();
      const controller = new AbortController();
      let ranQueued = false;
      const queued = withStatusCheckLock(() => { ranQueued = true; }, controller.signal);
      controller.abort();
      let timeoutId;
      const earlyAbort = await Promise.race([
        queued.then(() => 'resolved', error => error?.name),
        new Promise(resolve => { timeoutId = setTimeout(() => resolve('timed-out'), 100); }),
      ]);
      clearTimeout(timeoutId);
      assert(earlyAbort === 'AbortError' && ranQueued === false,
        `a queued caller must abort before the holder releases — got ${earlyAbort}`);
      const follower = withStatusCheckLock(async () => 'follower');
      releaseHead();
      assert(await head === undefined && await follower === 'follower',
        'an early-aborted queue slot preserves mutual exclusion and does not wedge its follower');
      assert(ranQueued === false, 'the aborted queue slot must remain skipped after reaching its turn');
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
    name: 'lock factory: reentrant withLock call throws instead of deadlocking, and does not wedge the queue',
    run: async () => {
      // A caller invoking the SAME lock again from inside its own critical
      // section used to deadlock forever (jobs.js hit this once and worked
      // around it only via a "don't nest this call" comment). It must now
      // throw immediately instead of hanging.
      let innerErrName = null;
      const outerResult = await withSharedProfileLock(async () => {
        try {
          await withSharedProfileLock(async () => 'should-not-run');
        } catch (err) {
          innerErrName = err.message;
        }
        return 'outer-done';
      });
      assert(outerResult === 'outer-done', 'the outer critical section still completes normally');
      assert(typeof innerErrName === 'string' && innerErrName.includes('reentrant'),
        `nested call rejects with a reentrancy error — got ${innerErrName}`);
      // The guard must not leak across unrelated, non-nested calls afterward.
      const afterNested = await withSharedProfileLock(async () => 'after-nested');
      assert(afterNested === 'after-nested', 'the lock keeps working normally for later, non-nested callers');
      // Marketplace and job work now use the SAME profile FIFO. Nested aliases
      // must fail fast rather than deadlocking; status checks remain independent.
      let aliasErr = null;
      await withMarketplaceBrowserLock(async () => {
        try { await withSharedProfileLock(async () => 'should-not-run'); }
        catch (err) { aliasErr = err.message; }
      });
      assert(typeof aliasErr === 'string' && aliasErr.includes('reentrant'),
        `nested marketplace/shared aliases reject instead of deadlocking — got ${aliasErr}`);
      const crossLockResult = await withMarketplaceBrowserLock(async () => withStatusCheckLock(async () => 'cross-lock-ok'));
      assert(crossLockResult === 'cross-lock-ok', 'status checks stay independent of the shared Chrome-profile FIFO');

      // AsyncLocalStorage deliberately follows resources created in a lock.
      // Once the originating owner has released, that inherited context must
      // not poison a later timer callback as permanently reentrant.
      let settleDeferred;
      const deferredResult = new Promise(resolve => { settleDeferred = resolve; });
      await withSharedProfileLock(async () => {
        setTimeout(() => {
          withSharedProfileLock(async () => 'deferred-after-release')
            .then(settleDeferred, error => settleDeferred(error));
        }, 0);
      });
      const deferred = await deferredResult;
      assert(deferred === 'deferred-after-release',
        `a deferred descendant may acquire after its original owner releases — got ${deferred?.message || deferred}`);
      return { ok: true };
    },
  },
{
    name: 'marketplace and job browser work share one FIFO with snapshot metadata and marketplace queue depth',
    run: async () => {
      const before = getMarketplaceBrowserQueueDepth();
      let release;
      const hold = new Promise(resolve => { release = resolve; });
      const order = [];
      const marketplace = withMarketplaceBrowserLock(async () => {
        order.push('marketplace-start');
        const snapshot = getSharedProfileLockSnapshot();
        assert(snapshot.active?.label === 'marketplace browser workflow', `marketplace holder is named in the shared snapshot — got ${JSON.stringify(snapshot)}`);
        await hold;
        order.push('marketplace-end');
      });
      await Promise.resolve();
      const job = withSharedProfileLock(async () => { order.push('job'); }, null, 'job test workflow');
      assert(getMarketplaceBrowserQueueDepth() === before + 2,
        `marketplace queue-depth includes the marketplace holder plus a queued job profile workflow — got ${getMarketplaceBrowserQueueDepth()}`);
      release();
      await Promise.all([marketplace, job]);
      assert(order.join(',') === 'marketplace-start,marketplace-end,job', `one shared FIFO preserves order — got ${order}`);
      assert(getMarketplaceBrowserQueueDepth() === before, 'shared queue depth returns to baseline');
      return { order };
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
      const recoveredExtrasForDraft = recoverRefreshExtraItems(product, [], [
        { key: 'primary', label: 'iPhone XS', query: 'Apple iPhone XS 256GB', condition: 'Used - Good' },
        { key: 'legacy-case', label: 'Otterbox Defender case', query: 'Otterbox Defender case', condition: 'New', pricingNotes: 'sealed' },
      ]);
      assert(recoveredExtrasForDraft.length === 1 && recoveredExtrasForDraft[0].generated_title === 'Otterbox Defender case' && recoveredExtrasForDraft[0].pricingNotes === 'sealed',
        `Refresh Prices draft recovery exposes legacy bundle extras for editing — got ${JSON.stringify(recoveredExtrasForDraft)}`);
      const explicitExtrasForDraft = recoverRefreshExtraItems(product, extras, [
        { key: 'primary', query: 'stale primary' },
        { key: 'stale-extra', query: 'stale extra' },
      ]);
      assert(explicitExtrasForDraft === extras,
        'Refresh Prices draft recovery preserves current editable extraItems, including blank rows, when they already exist');
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
    name: 'browser pool: queueScrape dedup keys on signal identity, not just url+extractor',
    run: async () => {
      const release = pauseBrowserPool('test-dedup-signal');
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const url = 'https://example.com/browser-pool-dedup-test';
      const extractor = '() => []';
      let taskA, taskB, taskC;
      try {
        // Two independent callers targeting the identical url+extractor, but
        // with DIFFERENT AbortSignals — must NOT be coupled: each gets its
        // own queue entry, and aborting one must not affect the other.
        taskA = queueScrape(url, extractor, { signal: controllerA.signal, sourceLabel: 'dedup-test', timeoutMs: 1000 })
          .then(() => 'resolved', (err) => err?.message || String(err));
        taskB = queueScrape(url, extractor, { signal: controllerB.signal, sourceLabel: 'dedup-test', timeoutMs: 1000 })
          .then(() => 'resolved', (err) => err?.message || String(err));
        // A third call sharing controllerA's signal (and every other field)
        // SHOULD dedupe with taskA — same-signal callers are the case this
        // cache exists to optimize (e.g. every task in one scrapeMultiple()
        // batch shares one signal).
        const taskARepeat = queueScrape(url, extractor, { signal: controllerA.signal, sourceLabel: 'dedup-test', timeoutMs: 1000 });
        taskC = taskARepeat.then(() => 'resolved', (err) => err?.message || String(err));

        await new Promise(r => setTimeout(r, 0));
        const state = getBrowserPoolQueueState();
        // 2 distinct queue entries (A/B), not 1 — proves signal identity is part of the key.
        assert(state.queued === 2, `two independent signals → two distinct queue entries (got ${state.queued})`);

        controllerA.abort();
        const resultA = await taskA;
        assert(resultA === 'Aborted', `taskA aborts on its own signal (got ${resultA})`);
        const resultC = await taskC;
        assert(resultC === 'Aborted', `the same-signal repeat call also aborts (proves it deduped onto taskA, got ${resultC})`);

        // taskB must be UNAFFECTED by controllerA's abort — this is the actual bug:
        // before the fix, aborting the "leader" caller's signal would reject
        // every deduped caller, even ones (like B) that never asked to cancel.
        const stillPending = await Promise.race([
          taskB.then(() => 'settled'),
          new Promise(r => setTimeout(() => r('still-pending'), 20)),
        ]);
        assert(stillPending === 'still-pending', 'taskB (different signal) must still be pending after controllerA aborted — not coupled to it');

        controllerB.abort();
        const resultB = await taskB;
        assert(resultB === 'Aborted', `taskB aborts independently on its own signal (got ${resultB})`);

        return { ok: true };
      } finally {
        controllerA.abort();
        controllerB.abort();
        await Promise.allSettled([taskA, taskB, taskC].filter(Boolean));
        release();
      }
    },
  },
{
    // Regression test for the "Scrape timed out after Nms" bug: an anti-bot
    // reload loop can leave page.content() hanging forever (it never resolves
    // NOR rejects), and the bare `.catch(() => '')` browserPool used to call it
    // with only guards a rejection — so a stuck page silently burned the WHOLE
    // remaining scrape budget before the outer hard timeout fired, mislabeling
    // a page.content() hang as an opaque scrape-timeout instead of letting the
    // caller reach its normal empty/blocked classification. readPageContentBounded
    // fixes this with a Promise.race against a clamped deadline.
    name: 'readPageContentBounded: bounds a hung page.content() instead of waiting forever, passes through real results/errors',
    run: async () => {
      const fastPage = { content: async () => '<html>ok</html>' };
      const fast = await readPageContentBounded(fastPage, 5000);
      assert(fast === '<html>ok</html>', `a fast, resolving page.content() passes through unchanged (got ${JSON.stringify(fast)})`);

      const rejectingPage = { content: async () => { throw new Error('Protocol error'); } };
      const rejected = await readPageContentBounded(rejectingPage, 5000);
      assert(rejected === '', `a rejecting page.content() falls back to '' (got ${JSON.stringify(rejected)})`);

      // Simulates the reload-loop hang: content() never settles either way.
      const hungPage = { content: () => new Promise(() => {}) };
      const start = Date.now();
      const hungResult = await readPageContentBounded(hungPage, 50);
      const elapsed = Date.now() - start;
      assert(hungResult === '', `a hung page.content() falls back to '' instead of propagating undefined/hanging (got ${JSON.stringify(hungResult)})`);
      // The 1000ms floor (Math.max(1000, maxMs)) is a deliberate safety floor
      // against a 0/negative deadline — assert it bounds the wait, not that it
      // honors the requested 50ms exactly.
      assert(elapsed < 2000, `a hung page.content() must resolve within the bounded floor, not hang indefinitely (elapsed=${elapsed}ms)`);
      return { ok: true, elapsed };
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
        await startRun(canvas, { runId: 'r1', startedAt: T0, queries: ['swe'], canonicalLocation: 'Toronto, Ontario, Canada', sourceIds: ['indeed', 'google'] });
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
        assert(st.manifest.inputs.canonicalLocation === 'Toronto, Ontario, Canada', 'resume manifest binds staged jobs to the exact canonical location');
        assert(st.stagedJobs.length === 3, 'run state carries staged jobs');

        // older than the 24h window → still incomplete but NOT auto-resumable
        const stale = await readRunState(canvas, T0 + RESUMABLE_MAX_AGE_MS + 5);
        assert(stale.incomplete && !stale.resumable, 'stale run is not auto-resumable');

        // 'gathered' (search done, scoring still owed) stays resumable — a
        // manifest on disk IS an unfinished run; completion = sidecar DELETION.
        await setStage(canvas, 'gathered', T0 + 200);
        const gathered = await readRunState(canvas, T0 + 300);
        assert(gathered && gathered.incomplete && gathered.resumable && gathered.manifest.stage === 'gathered',
          'gathered-stage run is still resumable (scoring not finished)');
        await clearRun(canvas);
        assert((await readRunState(canvas, T0 + 400)) === null, 'cleared run → null state (the completion signal)');

        return { ok: true, staged: staged.length };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
{
    name: 'job run staging: stale completion cannot clear a newer run',
    run: async () => {
      const dir = path.join(os.tmpdir(), `ic-jobstaging-cas-${process.pid}`);
      fs.mkdirSync(dir, { recursive: true });
      const canvas = path.join(dir, 'test-canvas.json');
      const T0 = 1_500_000;
      try {
        await startRun(canvas, { runId: 'old', startedAt: T0, queries: ['old'], sourceIds: ['indeed'] });
        await startRun(canvas, { runId: 'new', startedAt: T0 + 1, queries: ['new'], sourceIds: ['indeed'] });
        const staleCleared = await clearRun(canvas, { expectedRunId: 'old' });
        const afterStale = await readRunState(canvas, T0 + 2);
        assert(staleCleared === false && afterStale?.manifest?.runId === 'new',
          'a late completion from an older run preserves the newer manifest and staging');
        const currentCleared = await clearRun(canvas, { expectedRunId: 'new' });
        assert(currentCleared === true && await readRunState(canvas, T0 + 3) === null,
          'the matching run token clears its own sidecars');
        return { ok: true };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
{
    // A cancelled browser/API task can settle after the renderer has already
    // begun a replacement scan on the same canvas. The staging file is
    // append-only, so checking only when the manifest is written is too late:
    // predecessor rows would already pollute the successor's resumable run.
    name: 'job run staging: late predecessor writes cannot contaminate a replacement run',
    run: async () => {
      const dir = path.join(os.tmpdir(), `ic-jobstaging-fence-${process.pid}`);
      fs.mkdirSync(dir, { recursive: true });
      const canvas = path.join(dir, 'test-canvas.json');
      const T0 = 1_750_000;
      try {
        await startRun(canvas, { runId: 'old', startedAt: T0, queries: ['old'], sourceIds: ['indeed'] });
        await recordSourcePage(canvas, {
          sourceId: 'indeed', query: 'old', page: 0, jobs: [{ title: 'old-before-cancel' }],
          now: T0 + 1, expectedRunId: 'old',
        });
        await startRun(canvas, { runId: 'new', startedAt: T0 + 2, queries: ['new'], sourceIds: ['indeed'] });

        const [latePage, lateStatus, lateStage] = await Promise.all([
          recordSourcePage(canvas, {
            sourceId: 'indeed', query: 'old', page: 1, jobs: [{ title: 'old-late' }],
            now: T0 + 3, expectedRunId: 'old',
          }),
          markSourceStatus(canvas, 'indeed', 'done', T0 + 4, { expectedRunId: 'old' }),
          setStage(canvas, 'gathered', T0 + 5, { expectedRunId: 'old' }),
        ]);
        assert(latePage === false && lateStatus === false && lateStage === false,
          'every late predecessor write is rejected by the replacement run token');

        const state = await readRunState(canvas, T0 + 6);
        assert(state?.manifest?.runId === 'new' && state.manifest.stage === 'searching',
          'predecessor cannot advance the replacement manifest');
        assert(state.manifest.sources.indeed.status === 'pending',
          'predecessor cannot mark a replacement source done');
        assert(state.stagedJobs.length === 0,
          'predecessor cannot append a row to replacement staging');

        const currentPage = await recordSourcePage(canvas, {
          sourceId: 'indeed', query: 'new', page: 0, jobs: [{ title: 'new-current' }],
          now: T0 + 7, expectedRunId: 'new',
        });
        assert(currentPage === true && (await readStagedJobs(canvas))[0]?.job?.title === 'new-current',
          'the replacement run can still stage its own page');
        return { ok: true };
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
    // Regression: resume start page was min(lastPage)+1 over the RECORDED
    // queries only — a query that crashed before flushing its first page had no
    // ledger entry, and since buildJobTasks applies ONE start page to EVERY
    // query of the source, that query's early pages were silently skipped.
    name: 'computeResumeStartPage: fast-forwards only when EVERY query recorded a page',
    run: () => {
      // Both queries recorded → min(lastPage)+1.
      assert(computeResumeStartPage({ queries: { qa: { lastPage: 3 }, qb: { lastPage: 1 } } }, 2) === 2,
        'all queries recorded → min(1)+1 = 2');
      // Query B never flushed → restart at 1 so its pages 1..N are not skipped.
      assert(computeResumeStartPage({ queries: { qa: { lastPage: 3 } } }, 2) === 1,
        'unrecorded query → start page 1');
      // Nothing recorded at all → 1.
      assert(computeResumeStartPage({ queries: {} }, 3) === 1, 'no ledger → 1');
      assert(computeResumeStartPage(undefined, 3) === 1, 'no source entry → 1');
      // Single-query run fully recorded → resumes past its last page.
      assert(computeResumeStartPage({ queries: { only: { lastPage: 0 } } }, 1) === 1 + 0,
        'single query at page 0 → resume at 1 (0-based ledger, 1-based start)');
      assert(computeResumeStartPage({ queries: { only: { lastPage: 4 } } }, 1) === 5,
        'single query at page 4 → resume at 5');
      const perQuery = computeResumeStartPagesByQuery({
        queries: { qa: { lastPage: 3 }, qb: { lastPage: 1 } },
      }, ['qa', 'qb', 'qc']);
      assert(JSON.stringify(perQuery) === JSON.stringify([
        { startPage: 4, durable: true, terminal: false }, { startPage: 2, durable: true, terminal: false }, { startPage: 1, durable: false, terminal: false },
      ]), 'each query gets its own index-aligned next-page cursor and only an unrecorded query restarts at page 1');
      const duplicateLegacy = computeResumeStartPagesByQuery({ queries: { duplicate: { lastPage: 4 } } }, ['duplicate', 'duplicate']);
      assert(JSON.stringify(duplicateLegacy) === JSON.stringify([
        { startPage: 1, durable: false, terminal: false }, { startPage: 1, durable: false, terminal: false },
      ]), 'a legacy text-keyed cursor must not skip either ambiguous duplicate query slot');
      const duplicateIndexed = computeResumeStartPagesByQuery({ queries: { '#0': { lastPage: 4 }, '#1': { lastPage: 1 } } }, ['duplicate', 'duplicate']);
      assert(JSON.stringify(duplicateIndexed) === JSON.stringify([
        { startPage: 5, durable: true, terminal: false }, { startPage: 2, durable: true, terminal: false },
      ]), 'indexed cursors preserve distinct resume positions for duplicate query text');
      const terminalSibling = computeResumeStartPagesByQuery({ queries: { '#0': { lastPage: 3, terminal: true }, '#1': { lastPage: 1 } } }, ['first', 'second']);
      assert(terminalSibling[0]?.terminal === true && terminalSibling[1]?.terminal === false,
        'a completed query has a durable terminal marker independent of an interrupted sibling cursor');
      return { ok: true };
    },
  },
{
    // Regression: search-jobs appends kept jobs to history BEFORE scoring, so a
    // crash in the scoring window left every staged job already "seen" — the
    // resume recovered them from staging and dedupAgainstHistory then deleted
    // the entire recovery (~0 jobs from an hour of scraping).
    name: 'filterHistoryForResume: exempts the crashed run\'s own rows, keeps older history',
    run: () => {
      const T_RUN = Date.parse('2026-06-10T08:00:00Z');
      const recovered = [
        { title: 'Eng', company: 'Acme', location: 'Denver', url: 'https://jobs/eng' },
        { title: 'PM', company: 'Beta', location: '', url: 'https://jobs/pm' },
      ];
      const history = [
        // Written by the crashed run itself (same day, matching keys) → exempt.
        { seen_date: '2026-06-10', source: 'indeed', company: 'Acme', title: 'Eng', location: 'Denver', url: 'https://jobs/eng' },
        { seen_date: '2026-06-10', source: 'dice', company: 'Beta', title: 'PM', location: '', url: 'https://jobs/pm' },
        // Same day but NOT among the recovered jobs (another hub's completed run) → kept.
        { seen_date: '2026-06-10', source: 'lever', company: 'Other', title: 'Designer', location: '', url: 'https://jobs/dsn' },
        // Older run's row for one of the SAME jobs → kept (the original run
        // would have dropped this job too; resume must behave identically).
        { seen_date: '2026-06-01', source: 'indeed', company: 'Acme', title: 'Eng', location: 'Denver', url: 'https://jobs/eng' },
      ];
      const filtered = filterHistoryForResume(history, recovered, T_RUN);
      assert(filtered.length === 2, `exempts exactly the run's own rows (kept ${filtered.length})`);
      assert(filtered.some(r => r.title === 'Designer'), 'same-day row for a non-recovered job is kept');
      assert(filtered.some(r => r.seen_date === '2026-06-01'), 'older-run row for the same job is kept');
      // End-to-end: the recovered Eng job is STILL dropped (older history hit),
      // but PM survives — its only history row was the crashed run's own write.
      const { kept, removed } = dedupAgainstHistory(recovered, filtered);
      assert(kept.length === 1 && kept[0].title === 'PM' && removed === 1,
        'resume keeps the recovery except genuinely-seen-before jobs');
      // Guards: no recovery / no timestamp → untouched.
      assert(filterHistoryForResume(history, [], T_RUN).length === history.length, 'no recovered jobs → no exemption');
      assert(filterHistoryForResume(history, recovered, NaN).length === history.length, 'no run timestamp → no exemption');
      return { ok: true };
    },
  },
{
    name: 'jobs history: Google-for-Jobs keeps htidocid so distinct shared-path listings remain distinct',
    run: () => {
      const a = dedupKeysFor({
        url: 'https://www.google.com/search?htidocid=ABC123&foo=session-a',
      });
      const same = dedupKeysFor({
        url: 'https://google.com/search?foo=session-b&htidocid=ABC123',
      });
      const different = dedupKeysFor({
        url: 'https://google.com/search?htidocid=DEF456',
      });
      assert(a.includes('u:https://google.com/search?htidocid=ABC123') && a.some(k => same.includes(k)),
        'same Google listing ignores session params but retains stable htidocid');
      assert(!a.some(k => dedupKeysFor({ url: 'https://google.com/search?htidocid=abc123' }).includes(k)),
        'Google htidocid stays case-sensitive because it is opaque/base64-like');
      assert(!a.some(k => different.includes(k)),
        'different Google htidocid values never collapse through the shared /search path');
      const replayGoogleA = dedupKeysFor({
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Retail+Sales+Associate+Canada+jobs&htidocid=nWUdn9oqgrfIvDvYAAAAAA%3D%3D&hl=en-CA',
      });
      const replayGoogleB = dedupKeysFor({
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Customer+Service+Associate+Canada+jobs&htidocid=ZMarQLnfvtRm5rkhAAAAAA%3D%3D&hl=en-CA',
      });
      assert(!replayGoogleA.some(key => replayGoogleB.includes(key)),
        'replayed Google cards with distinct htidocid values remain distinct');
      const indeedA = dedupKeysFor({ url: 'https://ca.indeed.com/rc/clk?jk=abc123&bb=xyz' });
      const indeedB = dedupKeysFor({ url: 'https://ca.indeed.com/rc/clk?jk=abc123&bb=OTHER' });
      assert(indeedA.length === 1 && indeedA[0] === indeedB[0], 'Indeed redirect stubs key only on jk, never session parameters');
      assert(!dedupKeysFor({ url: 'https://ca.indeed.com/rc/clk?bb=xyz' }).some(key => key.startsWith('u:')),
        'Indeed redirect stubs without jk do not produce a misleading URL key');
      const glassdoorA = dedupKeysFor({ url: 'https://www.glassdoor.ca/job-listing/first-role-JV_IC123.htm?jl=111' });
      const glassdoorB = dedupKeysFor({ url: 'https://www.glassdoor.ca/job-listing/second-role-JV_IC123.htm?jl=222' });
      assert(glassdoorA.length === 1 && glassdoorB.length === 1 && glassdoorA[0] !== glassdoorB[0]
        && !glassdoorA[0].includes('jl=') && !glassdoorB[0].includes('jl='),
      'different Glassdoor listing paths stay distinct; jl is never elevated over the path identity');
      return { ok: true };
    },
  },
{
    name: 'jobs history: newline-safe writes round-trip and do not re-append on the next run',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-jobs-history-'));
      const canvasPath = path.join(base, 'job-search.json');
      const jobs = [
        { source: 'glassdoor', company: 'Marshalls\n3.4', title: 'Retail Associate', location: 'Toronto, ON', url: 'https://www.glassdoor.ca/job-listing/retail-associate-JV_IC1.htm' },
        { source: 'indeed', company: 'Acme', title: 'Support Specialist', location: 'Toronto, ON', url: 'https://ca.indeed.com/rc/clk?jk=history-abc' },
        { source: 'indeed', company: 'Acme Hotels', title: 'Front Desk Agent', location: 'Toronto, ON', url: 'https://ca.indeed.com/rc/clk?jk=front-desk-a' },
        { source: 'indeed', company: 'Acme Hotels', title: 'Front Desk Agent', location: 'Toronto, ON', url: 'https://ca.indeed.com/rc/clk?jk=front-desk-b' },
      ];
      try {
        const first = await appendJobsHistory(canvasPath, jobs);
        const readBack = await loadJobsHistory(canvasPath);
        const second = await appendJobsHistory(canvasPath, jobs);
        assert(first.written === jobs.length, `first history write persists all jobs, got ${first.written}`);
        assert(readBack.length === jobs.length && readBack[0].company === 'Marshalls 3.4',
          `newlines collapse inside one recoverable CSV row, got ${JSON.stringify(readBack)}`);
        assert(second.written === 0, `already-written rows must not append forever, got ${second.written}`);
        const freshSameTuple = dedupAgainstHistory([
          { source: 'indeed', company: 'Acme Hotels', title: 'Front Desk Agent', location: 'Toronto, ON', url: 'https://ca.indeed.com/rc/clk?jk=front-desk-c' },
        ], readBack);
        assert(freshSameTuple.kept.length === 1,
          'history identity: a new stable URL survives despite an existing same-title/company/location requisition');
        return { ok: true, written: first.written };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace recovery sidecar: exact owner claims, phase replay, and tombstones are crash durable',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-recovery-'));
      const canvasFilePath = path.join(base, 'workspace.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      const nodeId = 'sell-node-a';
      const items = [{ key: 'primary', label: 'Camera', query: 'Camera X', condition: 'Used - Good', pricingNotes: '' }];
      const marker = newMarketplaceRecovery({
        runId: 'run-a',
        phase: 'scrape',
        input: marketplaceResearchInput(items, 'Electronics'),
        inputKey: marketplaceResearchInputKey(items, 'Electronics'),
      });
      try {
        const firstClaim = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId, kind: 'sellhub', runId: marker.runId, inputKey: marker.inputKey,
        });
        const duplicateClaim = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId, kind: 'sellhub', runId: marker.runId, inputKey: marker.inputKey,
        });
        assert(firstClaim.claimed && !duplicateClaim.claimed && duplicateClaim.reason === 'already-running',
          'two windows cannot own the same canonical canvas/node/run concurrently');
        firstClaim.release();
        const afterRelease = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId, kind: 'sellhub', runId: marker.runId, inputKey: marker.inputKey,
        });
        assert(afterRelease.claimed, 'the exact owner claim releases after the handler settles');
        afterRelease.release();

        const begun = await beginMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub', recovery: marker });
        assert(begun.saved, `initial write-ahead barrier must succeed: ${JSON.stringify(begun)}`);
        const ownerScope = await __marketplaceRecoveryStoreForTests.owner({ canvasFilePath, nodeId, kind: 'sellhub' });
        const beforeAbortedWrite = await fs.promises.readFile(ownerScope.filePath, 'utf8');
        const abortController = new AbortController();
        abortController.abort(Object.assign(new Error('Window closed'), { name: 'AbortError' }));
        let abortedBeforeCommit = false;
        try {
          await __marketplaceRecoveryStoreForTests.atomicWrite(ownerScope.filePath, { invalid: true }, { signal: abortController.signal });
        } catch (error) {
          abortedBeforeCommit = error?.name === 'AbortError';
        }
        assert(abortedBeforeCommit
          && await fs.promises.readFile(ownerScope.filePath, 'utf8') === beforeAbortedWrite,
        'an abort observed after temp-file fsync but before rename cannot publish a late recovery checkpoint');
        const sourceMarker = mergeMarketplaceSourceCheckpoint(marker, {
          runId: marker.runId,
          inputKey: marker.inputKey,
          itemIndex: 0,
          sourceId: 'ebay-sold',
          record: { kind: 'browser', sourceId: 'ebay-sold', category: 'sold', success: true, items: [{ title: 'Camera X', price: 100 }] },
        });
        const sourceSaved = await checkpointMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', expectedInputKey: marker.inputKey, recovery: sourceMarker,
        });
        assert(sourceSaved.saved, 'a completed source is atomically checkpointed before terminal progress');

        // A second window entering between batch and bundle receives the
        // authoritative on-disk payload instead of overwriting it with stale
        // renderer state and repeating the finished AI batch.
        const withBatch = { ...sourceMarker, phase: 'synthesis', inputKey: 'synthesis-key', batchResult: { items: [{ itemKey: 'primary', pricing: { recommended_price: 100 } }] } };
        const transitioned = await checkpointMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', expectedInputKey: marker.inputKey, recovery: withBatch,
        });
        assert(transitioned.saved, 'scrape→synthesis transition is exact-key fenced');
        const staleBegin = await beginMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', recovery: { ...withBatch, batchResult: undefined },
        });
        assert(staleBegin.saved && staleBegin.existing && staleBegin.recovery.batchResult?.items?.length === 1,
          'a stale second renderer reuses the durable batch result between synthesis IPC phases');
        const wrongInput = await beginMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', recovery: { ...withBatch, inputKey: 'different-key' },
        });
        assert(!wrongInput.saved && wrongInput.reason === 'input-mismatch', 'same run id cannot silently change input');

        const priced = { ...withBatch, phase: 'priced-result', result: { hubState: 'priced', pricing: { recommended_price: 100 } } };
        assert((await checkpointMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', expectedInputKey: withBatch.inputKey, recovery: priced,
        })).saved, 'terminal UI result persists as a replay receipt');
        const replay = await peekMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub' });
        assert(replay.found && replay.status === 'replay' && replay.recovery.phase === 'priced-result',
          'restart reads the terminal receipt without repeating network/AI work');
        const replayBegin = await beginMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub', recovery: withBatch });
        assert(!replayBegin.saved && replayBegin.reason === 'replay-pending', 'unapplied terminal result cannot be restarted as active work');
        const sameProcessAck = await acknowledgeMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', runId: marker.runId, inputKey: priced.inputKey,
          appliedProcessEpoch: __marketplaceRecoveryStoreForTests.PROCESS_EPOCH,
        });
        assert(!sameProcessAck.completed && sameProcessAck.reason === 'same-process-autosave-unproven',
          'a remount in the same process cannot close a receipt before debounced canvas autosave is proven');
        assert((await acknowledgeMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', runId: marker.runId, inputKey: priced.inputKey,
          appliedProcessEpoch: 'prior-process-epoch',
        })).completed,
          'a later canvas observation closes the replay receipt');
        assert(!(await peekMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub' })).found,
          'completed receipt is no longer auto-resumable');

        const markerB = { ...marker, runId: 'run-b' };
        assert((await beginMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub', recovery: markerB })).saved,
          'a deliberate new run can supersede a completed receipt');
        const wrongStop = await abandonMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', runId: 'run-b', inputKey: 'stale-input', reason: 'user-reset',
        });
        assert(!wrongStop.abandoned && wrongStop.reason === 'input-mismatch',
          'a stale renderer cannot tombstone the same run under a different phase/input generation');
        assert((await abandonMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', runId: 'run-b', inputKey: markerB.inputKey, reason: 'user-reset',
        })).abandoned,
          'explicit Reset writes an exact-run tombstone');
        const late = await checkpointMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', expectedInputKey: markerB.inputKey, recovery: markerB,
        });
        assert(!late.saved && late.reason === 'abandoned', 'late source settlement cannot resurrect a reset run');
        return { claimFenced: true, batchReplayed: true, tombstoneFenced: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace recovery sidecars never follow a substituted symlink',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-recovery-nofollow-'));
      const canvasFilePath = path.join(base, 'workspace.json');
      const nodeId = 'sell-node-nofollow';
      const items = [{ key: 'primary', label: 'Camera', query: 'Camera X', condition: 'Used - Good', pricingNotes: '' }];
      const marker = newMarketplaceRecovery({
        runId: 'run-nofollow',
        phase: 'scrape',
        input: marketplaceResearchInput(items, 'Electronics'),
        inputKey: marketplaceResearchInputKey(items, 'Electronics'),
      });
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        assert((await beginMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub', recovery: marker })).saved,
          'fixture sidecar must be written before testing a path substitution');
        const scope = await __marketplaceRecoveryStoreForTests.owner({ canvasFilePath, nodeId, kind: 'sellhub' });
        const foreignPath = path.join(base, 'foreign-recovery.json');
        await fs.promises.writeFile(foreignPath, await fs.promises.readFile(scope.filePath, 'utf8'), 'utf8');
        await fs.promises.unlink(scope.filePath);
        await fs.promises.symlink(foreignPath, scope.filePath);
        const peeked = await peekMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub' });
        assert(!peeked.found && peeked.status === null,
          'a sidecar name swapped to a symlink is rejected rather than reading its target');
        return { symlinkRejected: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace recovery reader rejects same-inode growth after descriptor validation',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-recovery-growth-'));
      const filePath = path.join(base, 'recovery.json');
      const originalOpen = fs.promises.open;
      try {
        await fs.promises.writeFile(filePath, '{"safe":true}', 'utf8');
        // Inject the append at the only interesting boundary: after the
        // reader has opened and fstat'd the descriptor, immediately before it
        // starts consuming bytes. The pathname and inode remain unchanged.
        fs.promises.open = async (...args) => {
          const handle = await originalOpen(...args);
          let grew = false;
          return {
            stat: (...statArgs) => handle.stat(...statArgs),
            read: async (...readArgs) => {
              if (!grew) {
                grew = true;
                await fs.promises.appendFile(filePath, 'x', 'utf8');
              }
              return await handle.read(...readArgs);
            },
            close: () => handle.close(),
          };
        };
        let rejected = false;
        try {
          await __marketplaceRecoveryStoreForTests.readRegularNoFollowUtf8(filePath);
        } catch (error) {
          rejected = /Refusing changed Marketplace recovery record/.test(error?.message || '');
        }
        assert(rejected,
          'a same-inode append after fstat must be rejected rather than read through EOF');
        return { sameInodeGrowthRejected: true };
      } finally {
        fs.promises.open = originalOpen;
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace recovery sidecar: nested owner reads retain the canvas lease across claim release',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-lease-race-'));
      const canvasFilePath = path.join(base, 'workspace.json');
      const reboundPath = path.join(base, 'workspace-moved.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      const ownerA = { sender: 'marketplace-owner-a' };
      const ownerB = { sender: 'marketplace-owner-b' };
      const args = {
        canvasFilePath,
        nodeId: 'lease-race-node',
        kind: 'sellhub',
        runId: 'lease-race-run',
        inputKey: 'lease-race-input',
      };
      try {
        const claim = await withCanvasRecoveryOwner(ownerA, () => acquireMarketplaceRecoveryClaim(args));
        assert(claim.claimed, 'test precondition: Marketplace handler owns the long canvas reader lease');

        let writerEntered = false;
        const writer = withCanvasRecoveryRebind(canvasFilePath, reboundPath, async () => {
          writerEntered = true;
          return { success: true };
        });
        await Promise.resolve();

        let releaseNested;
        let signalNested;
        const nestedEntered = new Promise(resolve => { signalNested = resolve; });
        const nestedHold = new Promise(resolve => { releaseNested = resolve; });
        const nested = withCanvasRecoveryOwner(ownerA, () => (
          __marketplaceRecoveryStoreForTests.withMarketplaceRecoveryReadLease(args, async () => {
            signalNested();
            await nestedHold;
          })
        ));
        await nestedEntered;
        claim.release();
        assert(writerEntered === false,
          'releasing the Marketplace claim does not release a nested same-owner store operation');

        let outsiderEntered = false;
        const outsider = withCanvasRecoveryOwner(ownerB, () => (
          __marketplaceRecoveryStoreForTests.withMarketplaceRecoveryReadLease(args, async () => {
            outsiderEntered = true;
          })
        ));
        await Promise.resolve();
        assert(outsiderEntered === false,
          'after claim removal, a different standalone operation takes a regular lease behind the queued writer');
        releaseNested();
        await nested;
        await writer;
        await outsider;
        assert(writerEntered && outsiderEntered,
          'the writer drains the final nested ref before the later standalone operation enters');
        return { nestedRefHeld: true, outsiderRegularLease: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace recovery sidecar: exact cross-window cancel joins a queued rebind and migrates no live work',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-cancel-rebind-'));
      const canvasFilePath = path.join(base, 'workspace.json');
      const reboundPath = path.join(base, 'workspace-moved.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      const marker = newMarketplaceRecovery({
        runId: 'cancel-rebind-run',
        phase: 'scrape',
        input: marketplaceResearchInput([{ key: 'primary', query: 'Camera' }], '', ['ebay-sold']),
        inputKey: marketplaceResearchInputKey([{ key: 'primary', query: 'Camera' }], '', ['ebay-sold']),
      });
      const ownerA = { sender: 'claim-window' };
      const ownerB = { sender: 'cancel-window' };
      try {
        await beginMarketplaceRecovery({
          canvasFilePath, nodeId: 'cancel-rebind-node', kind: 'sellhub', recovery: marker,
        });
        let claim;
        let claimAborted = false;
        claim = await withCanvasRecoveryOwner(ownerA, () => acquireMarketplaceRecoveryClaim({
          canvasFilePath,
          nodeId: 'cancel-rebind-node',
          kind: 'sellhub',
          runId: marker.runId,
          inputKey: marker.inputKey,
          sender: ownerA,
          abort: () => {
            claimAborted = true;
            claim.release();
          },
        }));
        assert(claim.claimed, 'test precondition: first window owns the exact recovery claim');
        let writerEntered = false;
        const writer = withCanvasRecoveryRebind(canvasFilePath, reboundPath, async () => {
          writerEntered = true;
          return { success: true };
        });
        await Promise.resolve();
        assert(writerEntered === false, 'queued path migration waits for the live Marketplace claim');

        const stopped = await withCanvasRecoveryOwner(ownerB, () => abandonMarketplaceRecovery({
          canvasFilePath,
          nodeId: 'cancel-rebind-node',
          kind: 'sellhub',
          runId: marker.runId,
          inputKey: marker.inputKey,
          reason: 'user-reset',
        }));
        await writer;
        assert(stopped.abandoned && stopped.claimSettled && claimAborted && writerEntered,
          `exact cancel must tombstone/abort before the queued writer proceeds: ${JSON.stringify(stopped)}`);
        const retired = await peekMarketplaceRecovery({
          canvasFilePath, nodeId: 'cancel-rebind-node', kind: 'sellhub',
        });
        assert(!retired.found && retired.status === 'abandoned',
          'the writer can observe only the durable tombstone, never migrate live work after explicit Reset');
        return { cancellationJoinedExactClaim: true, writerDrainedAfterTombstone: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace recovery sidecar: destroyed sender aborts and releases a non-cooperative canonical claim',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-sender-destroyed-'));
      const canvasFilePath = path.join(base, 'workspace.json');
      const reboundPath = path.join(base, 'workspace-moved.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      let onDestroyed = null;
      let destroyed = false;
      const sender = {
        once(event, callback) { if (event === 'destroyed') onDestroyed = callback; },
        isDestroyed() { return destroyed; },
      };
      let abortReason = null;
      try {
        const recovery = newMarketplaceRecovery({
          runId: 'destroyed-sender-run',
          phase: 'scrape',
          input: marketplaceResearchInput([{ key: 'primary', query: 'Lens' }], '', ['ebay-sold']),
          inputKey: marketplaceResearchInputKey([{ key: 'primary', query: 'Lens' }], '', ['ebay-sold']),
        });
        await beginMarketplaceRecovery({
          canvasFilePath,
          nodeId: 'destroyed-sender-node',
          kind: 'sellhub',
          recovery,
        });
        const claim = await acquireMarketplaceRecoveryClaim({
          canvasFilePath,
          nodeId: 'destroyed-sender-node',
          kind: 'sellhub',
          runId: 'destroyed-sender-run',
          inputKey: recovery.inputKey,
          sender,
          abort: reason => { abortReason = reason; },
        });
        assert(claim.claimed && typeof onDestroyed === 'function',
          'a canonical Marketplace claim retains its sender destruction hook');
        let writerEntered = false;
        const writer = withCanvasRecoveryRebind(canvasFilePath, reboundPath, async () => {
          writerEntered = true;
          return { success: true };
        });
        await Promise.resolve();
        assert(writerEntered === false, 'live sender claim owns the long recovery reader');
        destroyed = true;
        onDestroyed();
        await writer;
        claim.release();
        assert(writerEntered
          && abortReason?.name === 'AbortError'
          && abortReason?.cancelCause === 'sender-destroyed',
        'sender destruction aborts the handler and releases its process claim/read even if the dependency never settles');
        assert((await peekMarketplaceRecovery({
          canvasFilePath, nodeId: 'destroyed-sender-node', kind: 'sellhub',
        })).found,
        'window destruction retains the active durable checkpoint for a later safe restart');
        const replacement = await acquireMarketplaceRecoveryClaim({
          canvasFilePath,
          nodeId: 'destroyed-sender-node',
          kind: 'sellhub',
          runId: 'destroyed-sender-run',
          inputKey: recovery.inputKey,
        });
        assert(replacement.claimed, 'normal handler-finally double release cannot leave the canonical claim occupied');
        replacement.release();
        return { senderAbort: true, leaseReleased: true, doubleReleaseSafe: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace recovery reducers: full-input fences and retryable status phases preserve exact work',
    run: () => {
      const urls = { ebay: ['https://ebay.test/messages'], mercari: ['https://mercari.test/selling'] };
      let recovery = newMarketplaceStatusRecovery({ runId: 'status-a', platformIds: ['ebay', 'mercari'], watchUrlsByPlatform: urls });
      assert(marketplaceStatusInputMatches(recovery, ['ebay', 'mercari'], urls), 'exact watch URL snapshot matches');
      assert(!marketplaceStatusInputMatches(recovery, ['ebay', 'mercari'], { ...urls, ebay: ['https://ebay.test/changed'] }),
        'watch URL change invalidates recovery ownership');
      const prepared = { platformId: 'ebay', llmInputs: [{ spec: { url: urls.ebay[0], urlLabel: 'hub' }, snippet: 'saved page' }], sources: [], readState: { read: 0, unread: 1 } };
      recovery = mergeMarketplaceStatusPrepared(recovery, { runId: recovery.runId, platformId: 'ebay', prepared });
      assert(recovery.preparedByPlatform.ebay === prepared, 'post-network/pre-AI prepared pages are checkpointed exactly');
      recovery = recordMarketplaceStatusResult(recovery, 'ebay', { status: 'error', message: 'AI unavailable' }, { retryable: true });
      assert(recovery.remainingPlatformIds.includes('ebay') && recovery.preparedByPlatform.ebay,
        'transient AI error keeps the platform and its prepared page eligible for restart');
      recovery = recordMarketplaceStatusResult(recovery, 'ebay', { status: 'ok', summary: 'done' });
      assert(!recovery.remainingPlatformIds.includes('ebay') && !recovery.preparedByPlatform.ebay,
        'successful platform result retires only that exact platform checkpoint');
      return { remaining: recovery.remainingPlatformIds };
    },
  },
  {
    name: 'marketplace recovery fences: absent Reset, cross-window owner cancellation, and atomic multi-node deletion cannot revive',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-fences-'));
      const canvasFilePath = path.join(base, 'workspace.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      const markerFor = (runId) => newMarketplaceRecovery({
        runId,
        phase: 'scrape',
        input: marketplaceResearchInput([{ key: 'primary', query: 'Camera' }], 'Electronics', ['ebay-sold']),
        inputKey: marketplaceResearchInputKey([{ key: 'primary', query: 'Camera' }], 'Electronics', ['ebay-sold']),
      });
      try {
        const missingMarker = markerFor('run-missing');
        const absentStop = await abandonMarketplaceRecovery({
          canvasFilePath, nodeId: 'missing-node', kind: 'sellhub', runId: missingMarker.runId,
          inputKey: missingMarker.inputKey, reason: 'user-reset',
        });
        assert(absentStop.abandoned, 'Reset writes an exact tombstone even before acquire→begin creates a sidecar');
        const absentLateBegin = await beginMarketplaceRecovery({
          canvasFilePath, nodeId: 'missing-node', kind: 'sellhub', recovery: missingMarker,
        });
        assert(!absentLateBegin.saved && absentLateBegin.reason === 'abandoned',
          'a late begin cannot cross the absent-record Reset tombstone');

        const claimedMarker = markerFor('run-claimed');
        const claim = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId: 'claimed-node', kind: 'sellhub', runId: claimedMarker.runId,
          inputKey: claimedMarker.inputKey, abort: () => {},
        });
        assert(claim.claimed, 'first window owns the canonical run');
        const ownStop = await abandonMarketplaceRecovery({
          canvasFilePath, nodeId: 'claimed-node', kind: 'sellhub', runId: claimedMarker.runId,
          inputKey: claimedMarker.inputKey, reason: 'manual-ai-cancelled',
        }, { ownerToken: claim.ownerToken });
        assert(ownStop.abandoned && ownStop.ownerWillRelease,
          'the owning handler can durably tombstone itself without waiting on its own release');
        claim.release();

        const first = markerFor('run-first');
        const second = markerFor('run-second');
        await beginMarketplaceRecovery({ canvasFilePath, nodeId: 'node-first', kind: 'sellhub', recovery: first });
        await beginMarketplaceRecovery({ canvasFilePath, nodeId: 'node-second', kind: 'sellhub', recovery: second });
        const mismatchedBatch = await abandonMarketplaceRecoveryBatch({
          canvasFilePath,
          reason: 'canvas-cleared',
          owners: [
            { nodeId: 'node-first', kind: 'sellhub', runId: first.runId, inputKey: 'stale-input' },
            { nodeId: 'node-second', kind: 'sellhub', runId: second.runId, inputKey: second.inputKey },
          ],
        });
        assert(!mismatchedBatch.fenced && mismatchedBatch.reason === 'input-mismatch'
          && (await peekMarketplaceRecovery({ canvasFilePath, nodeId: 'node-first', kind: 'sellhub' })).found
          && (await peekMarketplaceRecovery({ canvasFilePath, nodeId: 'node-second', kind: 'sellhub' })).found,
        'batch deletion validates every requested run/input before committing any cancellation fence');
        let cleanupCall = 0;
        const fenced = await abandonMarketplaceRecoveryBatch({
          canvasFilePath,
          reason: 'canvas-cleared',
          owners: [
            { nodeId: 'node-first', kind: 'sellhub', runId: first.runId, inputKey: first.inputKey },
            { nodeId: 'node-second', kind: 'sellhub', runId: second.runId, inputKey: second.inputKey },
          ],
        }, {
          tombstoneWriter: async (args) => {
            cleanupCall += 1;
            if (cleanupCall === 2) throw new Error('injected second cleanup failure');
            return abandonMarketplaceRecovery(args);
          },
        });
        assert(fenced.fenced && fenced.cleanupErrors.length === 1,
          'the canvas-scoped fence commits every owner before fallible individual cleanup');
        const lateFirst = await beginMarketplaceRecovery({ canvasFilePath, nodeId: 'node-first', kind: 'sellhub', recovery: first });
        const lateSecond = await beginMarketplaceRecovery({ canvasFilePath, nodeId: 'node-second', kind: 'sellhub', recovery: second });
        assert(!lateFirst.saved && !lateSecond.saved && lateFirst.reason === 'abandoned' && lateSecond.reason === 'abandoned',
          'even the owner whose cleanup failed remains durably inert');
        return { absentFenced: true, selfStopNoDeadlock: true, atomicTargets: fenced.targetCount };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace exact inputs: source plan order and product specification are bound to recovery',
    run: () => {
      const researchItems = [{
        key: 'primary', label: 'Camera', query: 'Camera X', condition: 'Used - Good', pricingNotes: '',
        productSpec: { model: 'X', color: 'black', title: 'Camera X' },
      }];
      const sourcePlan = ['ebay-sold', 'poshmark'];
      const recovery = newMarketplaceRecovery({
        runId: 'exact-input-run', phase: 'scrape',
        input: marketplaceResearchInput(researchItems, 'Electronics', sourcePlan),
        inputKey: marketplaceResearchInputKey(researchItems, 'Electronics', sourcePlan),
      });
      assert(marketplaceResearchInputMatches(recovery, researchItems, 'Electronics', sourcePlan),
        'the exact ordered source contract matches');
      assert(!marketplaceResearchInputMatches(recovery, researchItems, 'Electronics', [...sourcePlan].reverse()),
        'reordering or changing sources cannot silently alter a resumed scrape');
      assert(!marketplaceResearchInputMatches(recovery, [{ ...researchItems[0], productSpec: { ...researchItems[0].productSpec, color: 'silver' } }], 'Electronics', sourcePlan),
        'same query with changed price-driving product bytes is a different recovery input');

      const pending = [{ ...researchItems[0], comps: { sold: [{ title: 'Camera', price: 100 }], active: [] } }];
      const synthesis = { ...recovery, phase: 'synthesis', pendingItems: pending };
      const supplied = [{
        itemKey: 'primary', itemLabel: 'Camera', query: 'Camera X', condition: 'Used - Good', pricingNotes: '',
        productSpec: pending[0].productSpec, comps: pending[0].comps,
      }];
      assert(validateMarketplaceBatchExecution(synthesis, supplied) === supplied,
        'the durable product specification admits the exact synthesis prompt');
      let rejected = false;
      try {
        validateMarketplaceBatchExecution(synthesis, [{ ...supplied[0], productSpec: { ...supplied[0].productSpec, color: 'silver' } }]);
      } catch { rejected = true; }
      assert(rejected, 'a live product edit cannot change the AI prompt under the old synthesis key');
      return { sourcePlanBound: true, productSpecBound: true };
    },
  },
  {
    name: 'nested marketplace source rescrape: exact interrupted intent resumes once while stop and input drift stay paused',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-hidden-rescrape-'));
      const canvasFilePath = path.join(base, 'workspace.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      const nodeId = 'nested-source-rescrape';
      const product = {
        generated_title: 'Camera X',
        condition: 'Used - Good',
        category: 'Electronics',
        model: 'X',
        color: 'black',
      };
      const researchItems = buildRefreshResearchItems(product, [], {}, 'Includes box');
      const sourcePlan = ['ebay-sold'];
      const active = newMarketplaceRecovery({
        runId: 'hidden-rescrape-run',
        phase: 'scrape',
        input: marketplaceResearchInput(researchItems, product.category, sourcePlan),
        inputKey: marketplaceResearchInputKey(researchItems, product.category, sourcePlan),
      });
      const resolveInput = marketplaceResolveInput({
        sourceId: 'ebay-sold',
        query: researchItems[0].query,
        items: null,
        noChallengeConfirmed: false,
      });
      const paused = {
        ...active,
        phase: 'comps-ready',
        pendingItems: researchItems.map(item => ({ ...item, comps: { sold: [], active: [] } })),
        scrapeWarnings: [{ sourceId: 'ebay-sold', code: 'task-failed', severity: 'block' }],
        resolveIntent: {
          input: resolveInput,
          inputKey: marketplaceResolveInputKey(resolveInput),
          status: 'running',
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      const rootNodes = [{ id: 'nested-group', type: 'group', data: { canvasData: { nodes: [{
        id: nodeId,
        type: 'sellhub',
        data: {
          product,
          extraItems: [],
          itemPricings: {},
          pricingNotes: 'Includes box',
          marketplaceRunResume: paused,
        },
      }], edges: [] } } }];
      try {
        assert(isAutomaticMarketplaceResolveIntent(paused),
          'a bounded exact running headless source intent is automatically recoverable');
        assert(marketplaceResearchIdentityMatches(paused, researchItems, product.category, sourcePlan),
          'comps-ready source recovery remains bound to the original ordered source/product snapshot');
        assert(!marketplaceResearchIdentityMatches(
          paused,
          buildRefreshResearchItems({ ...product, color: 'silver' }, [], {}, 'Includes box'),
          product.category,
          sourcePlan,
        ), 'a changed product specification pauses hidden source recovery before IPC');

        await beginMarketplaceRecovery({ canvasFilePath, nodeId, kind: 'sellhub', recovery: active });
        assert((await checkpointMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', expectedInputKey: active.inputKey, recovery: paused,
        })).saved, 'interrupted source intent is durable before any rescrape side effect');
        const coordinator = createWorkspaceStartupRecoveryCoordinator({
          peekMarketplaceRecovery: args => peekMarketplaceRecovery(args),
        });
        const firstPlan = await coordinator.discover({ canvasFilePath, rootNodes });
        const duplicatePlan = await coordinator.discover({ canvasFilePath, rootNodes });
        assert(firstPlan.length === 1 && firstPlan[0].state === 'source-rescrape-ready'
          && duplicatePlan.length === 0,
        'restart discovers the exact hidden rescrape once and coordinator dedup prevents a second dispatch');

        const firstAttempt = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId, kind: 'sellhub', runId: paused.runId, inputKey: paused.inputKey,
          autoResume: true, operation: 'rescrape:ebay-sold',
        });
        assert(firstAttempt.claimed, 'main admits the first automatic source attempt');
        firstAttempt.release();
        const duplicateAttempt = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId, kind: 'sellhub', runId: paused.runId, inputKey: paused.inputKey,
          autoResume: true, operation: 'rescrape:ebay-sold',
        });
        assert(!duplicateAttempt.claimed && duplicateAttempt.reason === 'automatic-attempted',
          'main enforces one provider attempt per process even across hidden/mounted renderers');
        const fullAttempt = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId, kind: 'sellhub', runId: paused.runId, inputKey: paused.inputKey,
          autoResume: true, operation: 'scrape',
        });
        assert(fullAttempt.claimed, 'full hidden scrape gets its own exact automatic-operation admission');
        fullAttempt.release();
        const duplicateFullAttempt = await acquireMarketplaceRecoveryClaim({
          canvasFilePath, nodeId, kind: 'sellhub', runId: paused.runId, inputKey: paused.inputKey,
          autoResume: true, operation: 'scrape',
        });
        assert(!duplicateFullAttempt.claimed && duplicateFullAttempt.reason === 'automatic-attempted',
          'a remounted hidden coordinator cannot repeat the full provider scrape in the same process');

        assert((await abandonMarketplaceRecovery({
          canvasFilePath, nodeId, kind: 'sellhub', runId: paused.runId, inputKey: paused.inputKey,
          reason: 'user-reset',
        })).abandoned, 'explicit Reset durably tombstones the interrupted source intent');
        const afterStop = await createWorkspaceStartupRecoveryCoordinator({
          peekMarketplaceRecovery: args => peekMarketplaceRecovery(args),
        }).discover({ canvasFilePath, rootNodes });
        assert(afterStop.length === 0,
          'a tombstoned source intent is never rediscovered after restart even if stale canvas data remains');

        const startupHook = fs.readFileSync(path.join(process.cwd(), 'src/hooks/useWorkspaceStartupRecovery.js'), 'utf8');
        const mountedHub = fs.readFileSync(path.join(process.cwd(), 'src/nodes/SellHubNode.jsx'), 'utf8');
        const fullResumeStart = startupHook.indexOf("entry.kind === 'sellhub' && entry.state === 'ready'");
        const fullResumeEnd = startupHook.indexOf("entry.kind === 'marketplacestatus'", fullResumeStart);
        assert(startupHook.includes("entry.state === 'source-rescrape-ready'")
          && startupHook.includes('window.electronAPI?.rescrapeSource?.({')
          && startupHook.includes('autoResume: true')
          && !startupHook.slice(
            startupHook.indexOf("entry.state === 'source-rescrape-ready'"),
            startupHook.indexOf("entry.kind === 'sellhub' && entry.state === 'ready'"),
          ).includes('resolveCaptcha'),
        'hidden execution invokes only the exact headless rescrape and cannot auto-open CAPTCHA/native UI');
        assert(fullResumeStart >= 0
          && startupHook.slice(fullResumeStart, fullResumeEnd).includes('window.electronAPI?.scrapePriceComps?.({')
          && startupHook.slice(fullResumeStart, fullResumeEnd).includes('autoResume: true'),
        'hidden full-scrape recovery is admitted through the main one-attempt-per-process fence on every remount');
        const mountedResolveStart = mountedHub.indexOf('// A headless source retry is safe to continue once per process');
        const mountedResolveEnd = mountedHub.indexOf('const acceptImagePaths', mountedResolveStart);
        assert(mountedResolveStart >= 0
          && mountedHub.slice(mountedResolveStart, mountedResolveEnd).includes('isAutomaticMarketplaceResolveIntent(recovery)')
          && mountedHub.slice(mountedResolveStart, mountedResolveEnd).includes('marketplaceResearchIdentityMatches('),
        'mounted recovery applies the same exact-intent and current-product fence before dispatching a headless retry');
        return { restartReady: true, processDedup: true, explicitStopInert: true, inputDriftPaused: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace status manual pause: login/native/CAPTCHA gates do not issue a second startup IPC',
    run: async () => {
      const input = {
        platformIds: ['ebay'],
        watchUrlsByPlatform: { ebay: ['https://example.test/watch'] },
      };
      const paused = {
        version: 1,
        runId: 'status-manual-pause',
        phase: 'status',
        input,
        inputKey: JSON.stringify(input),
        remainingPlatformIds: ['ebay'],
        preparedByPlatform: {},
        completedResults: { ebay: { status: 'needs-login' } },
        manualPause: {
          kind: 'login-required',
          status: 'manual-required',
          platformIds: ['ebay'],
          updatedAt: 10,
        },
      };
      let peekCalls = 0;
      const plan = await createWorkspaceStartupRecoveryCoordinator({
        peekMarketplaceRecovery: async () => {
          peekCalls += 1;
          return { found: true, recovery: paused, processEpoch: 'status-process' };
        },
      }).discover({
        canvasFilePath: '/work/status-paused.json',
        // Simulate the sidecar winning the crash race before the debounced
        // canvas marker recorded manualPause.
        rootNodes: [{ id: 'status-group', type: 'group', data: { canvasData: { nodes: [
          { id: 'status-paused', type: 'marketplacestatus', data: {
            marketplaceStatusRunResume: { ...paused, manualPause: null },
          } },
        ], edges: [] } } }],
      });
      assert(peekCalls === 1 && plan[0]?.state === 'human-paused',
        'restart discovers the exact sidecar but classifies the human gate as non-runnable');
      const startupHook = fs.readFileSync(path.join(process.cwd(), 'src/hooks/useWorkspaceStartupRecovery.js'), 'utf8');
      const mountedStatus = fs.readFileSync(path.join(process.cwd(), 'src/nodes/MarketplaceStatusNode.jsx'), 'utf8');
      assert(startupHook.includes("entry.kind === 'marketplacestatus' && entry.state === 'ready'")
        && mountedStatus.includes("if (recovery.manualPause?.status === 'manual-required') return;"),
      'neither hidden nor mounted startup paths invoke a status IPC for a durable manual pause');
      return { peekCalls, statusIpcCalls: 0 };
    },
  },
  {
    name: 'marketplace terminal proof: same-process remount stays replayable and later edits survive next-process acknowledgement',
    run: () => {
      const receipt = {
        version: 1, runId: 'terminal-run', phase: 'priced-result', inputKey: 'terminal-input', updatedAt: 123,
        result: { hubState: 'priced', pricing: { recommended_price: 100 } },
      };
      const applied = markMarketplaceTerminalApplied(receipt, 'process-before-restart');
      assert(marketplaceTerminalReceiptApplied(receipt, applied), 'exact result application writes a verifiable process-bound proof');
      const userEditedNode = { product: { generated_title: 'My edited title' }, marketplaceRunResume: applied };
      assert(marketplaceTerminalReceiptApplied(receipt, userEditedNode.marketplaceRunResume)
        && userEditedNode.product.generated_title === 'My edited title',
      'acknowledgement relies on the applied receipt proof, so later legitimate product edits are preserved');
      const stale = markMarketplaceTerminalApplied({ ...receipt, updatedAt: 122 }, 'older-process');
      assert(!marketplaceTerminalReceiptApplied(receipt, stale), 'stale proof cannot acknowledge a newer terminal receipt');
      return { exactProof: true, laterEditPreserved: true };
    },
  },
  {
    name: 'nested marketplace terminal replay: same-process autosave gap defers ACK and a later process consumes it',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-nested-epoch-'));
      const canvasFilePath = path.join(base, 'nested.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      const receipt = {
        version: 1, runId: 'nested-terminal', phase: 'analysis-result', input: { imagePaths: ['staged'] },
        inputKey: 'nested-input', result: { product: { generated_title: 'Lamp' } }, updatedAt: 777,
      };
      try {
        await beginMarketplaceRecovery({ canvasFilePath, nodeId: 'nested-sell', kind: 'sellhub', recovery: { ...receipt, phase: 'analysis' } });
        await checkpointMarketplaceRecovery({
          canvasFilePath, nodeId: 'nested-sell', kind: 'sellhub', expectedInputKey: receipt.inputKey, recovery: receipt,
        });
        const sameProcessMarker = markMarketplaceTerminalApplied(receipt, __marketplaceRecoveryStoreForTests.PROCESS_EPOCH);
        const rootNodes = [{ id: 'group', type: 'group', data: { canvasData: { nodes: [
          { id: 'nested-sell', type: 'sellhub', data: {
            hubState: 'draft', product: { generated_title: 'Lamp' }, marketplaceRunResume: sameProcessMarker,
          } },
        ], edges: [] } } }];
        const plan = await createWorkspaceStartupRecoveryCoordinator({ peekMarketplaceRecovery })
          .discover({ canvasFilePath, rootNodes });
        const entry = plan[0];
        assert(entry?.alreadyApplied && entry.processEpoch === __marketplaceRecoveryStoreForTests.PROCESS_EPOCH,
          'nested coordinator carries the main-process epoch alongside the exact applied proof');
        const sameProcess = await acknowledgeMarketplaceRecovery({
          canvasFilePath, nodeId: entry.nodeId, kind: 'sellhub', runId: entry.runId,
          inputKey: entry.recovery.inputKey,
          appliedProcessEpoch: entry.nodeData.marketplaceRunResume.terminalApplied.appliedProcessEpoch,
        });
        assert(!sameProcess.completed && sameProcess.reason === 'same-process-autosave-unproven',
          'nested remount before autosave cannot consume the only durable result copy');
        const nextProcess = await acknowledgeMarketplaceRecovery({
          canvasFilePath, nodeId: entry.nodeId, kind: 'sellhub', runId: entry.runId,
          inputKey: entry.recovery.inputKey, appliedProcessEpoch: 'process-before-restart',
        });
        assert(nextProcess.completed, 'a subsequent process observing the persisted proof consumes the receipt');
        return { sameProcessDeferred: true, nextProcessAcknowledged: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace nested deletion and recovery source code preserve every restart boundary',
    run: () => {
      const marker = (runId) => ({ version: 1, runId, inputKey: `key-${runId}`, phase: 'scrape' });
      const owners = collectMarketplaceRecoveryOwners([{ id: 'group', type: 'group', data: { canvasData: { nodes: [
        { id: 'nested-sell', type: 'sellhub', data: { marketplaceRunResume: marker('sell') } },
        { id: 'nested-status', type: 'marketplacestatus', data: { marketplaceStatusRunResume: { ...marker('status'), phase: 'status' } } },
      ] } } }]);
      assert(owners.length === 2 && owners.some(owner => owner.nodeId === 'nested-sell') && owners.some(owner => owner.nodeId === 'nested-status'),
        'group deletion recursively discovers SellHub and Marketplace Status recovery owners');
      const main = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/marketplace.js'), 'utf8');
      const pool = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/browserPool.js'), 'utf8');
      const store = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/marketplaceRecoveryStore.js'), 'utf8');
      assert(pool.includes('if (onSettled) await onSettled(result, task)')
        && main.includes('scrapeMultiple(pendingBrowserTasks, null, signal, async (res, task) =>')
        && main.indexOf('await onSourceSettled(res.id, checkpointBrowserResult') < main.indexOf("status: res.success ? 'done' : 'error'"),
      'each browser source crosses an awaited durable checkpoint before terminal progress, independent of sibling completion');
      assert(main.includes("reason: 'manual-ai-cancelled'")
        && main.includes('{ ownerToken: claim?.ownerToken }')
        && main.includes("manualPause: {\n          kind: 'login-required'"),
      'manual AI cancel and login gates are main-process durable and cannot auto-retry after renderer loss');
      assert(main.includes("await writeExclusiveFile(path.join(stageDir, 'owner.json')")
        && main.includes("await fs.promises.open(filePath, 'wx', 0o600)")
        && main.includes('pruneOrphanedMarketplacePhotoStages')
        && main.includes('replaceOwnedPartial: true')
        && main.includes('activePaths.length > 0 && activePaths.every')
        && main.includes("persisted.recovery?.phase !== 'analysis'"),
      'photo bytes are staged only into an exclusive, owned, prunable run directory');
      assert(store.includes('crypto.randomBytes(12)')
        && store.includes('fs.constants.O_EXCL')
        && store.includes('fs.constants.O_NOFOLLOW'),
      'recovery sidecar temp files use unpredictable exclusive no-follow creation');
      return { nestedOwners: owners.length, perSourceBarrier: true, privateStageBounded: true };
    },
  },
  {
    name: 'marketplace path rebind: prepared commit and rollback migrate exact sidecars without duplication',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-rebind-'));
      const oldCanvas = path.join(base, 'old.json');
      const newCanvas = path.join(base, 'new.json');
      await fs.promises.writeFile(oldCanvas, '{}', 'utf8');
      await fs.promises.writeFile(newCanvas, '{}', 'utf8');
      const marker = newMarketplaceRecovery({
        runId: 'rebind-run', phase: 'scrape',
        input: marketplaceResearchInput([{ key: 'primary', query: 'Camera' }], '', ['ebay-sold']),
        inputKey: marketplaceResearchInputKey([{ key: 'primary', query: 'Camera' }], '', ['ebay-sold']),
      });
      try {
        await beginMarketplaceRecovery({ canvasFilePath: oldCanvas, nodeId: 'rebind-node', kind: 'sellhub', recovery: marker });
        const prepared = await prepareCanvasRecoveryRebind(oldCanvas, newCanvas);
        assert(prepared.success && prepared.migratedCount === 1, 'rebind validates and stages the exact old owner');
        const committed = await prepared.commit();
        assert(committed.success && (await peekMarketplaceRecovery({ canvasFilePath: newCanvas, nodeId: 'rebind-node', kind: 'sellhub' })).found,
          'commit publishes the new path owner before old cleanup');
        await prepared.rollback();
        assert((await peekMarketplaceRecovery({ canvasFilePath: oldCanvas, nodeId: 'rebind-node', kind: 'sellhub' })).found
          && !(await peekMarketplaceRecovery({ canvasFilePath: newCanvas, nodeId: 'rebind-node', kind: 'sellhub' })).found,
        'rollback restores the exact old sidecar and removes the prepared new owner');
        return { migrated: prepared.migratedCount, rollbackSafe: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace path rebind: post-publication unlink and source-fsync failures preserve the durable destination',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-rebind-cleanup-'));
      const oldCanvas = path.join(base, 'old.json');
      const newCanvas = path.join(base, 'new.json');
      const fsyncOldCanvas = path.join(base, 'fsync-old.json');
      const fsyncNewCanvas = path.join(base, 'fsync-new.json');
      await Promise.all([oldCanvas, newCanvas, fsyncOldCanvas, fsyncNewCanvas]
        .map(filePath => fs.promises.writeFile(filePath, '{}', 'utf8')));
      const markerFor = (runId) => newMarketplaceRecovery({
        runId,
        phase: 'scrape',
        input: marketplaceResearchInput([{ key: 'primary', query: 'Camera' }], '', ['ebay-sold']),
        inputKey: marketplaceResearchInputKey([{ key: 'primary', query: 'Camera' }], '', ['ebay-sold']),
      });
      try {
        const unlinkMarker = markerFor('rebind-unlink-run');
        await beginMarketplaceRecovery({
          canvasFilePath: oldCanvas,
          nodeId: 'unlink-node',
          kind: 'sellhub',
          recovery: unlinkMarker,
        });
        const unlinkPrepared = await prepareCanvasRecoveryRebind(oldCanvas, newCanvas, {
          removeOldSource: async filePath => {
            // Model a filesystem/runtime that reports failure after the unlink
            // may already have reached the kernel.
            await fs.promises.unlink(filePath);
            throw new Error('injected post-unlink failure');
          },
        });
        const unlinkCommit = await unlinkPrepared.commit();
        assert(unlinkCommit.success && unlinkCommit.destinationDurable && unlinkCommit.cleanupPending,
          `post-publication unlink failure must be deferred, got ${JSON.stringify(unlinkCommit)}`);
        assert((await peekMarketplaceRecovery({
          canvasFilePath: newCanvas, nodeId: 'unlink-node', kind: 'sellhub',
        })).found,
        'a source unlink that throws after taking effect never rolls back the fsynced destination');

        const fsyncMarker = markerFor('rebind-fsync-run');
        await beginMarketplaceRecovery({
          canvasFilePath: fsyncOldCanvas,
          nodeId: 'fsync-node',
          kind: 'sellhub',
          recovery: fsyncMarker,
        });
        const fsyncPrepared = await prepareCanvasRecoveryRebind(fsyncOldCanvas, fsyncNewCanvas, {
          syncSourceDirectory: async () => { throw new Error('injected old directory fsync failure'); },
        });
        const fsyncCommit = await fsyncPrepared.commit();
        assert(fsyncCommit.success && fsyncCommit.destinationDurable && fsyncCommit.cleanupPending,
          `old-directory fsync failure must not reverse durable publication, got ${JSON.stringify(fsyncCommit)}`);
        assert((await peekMarketplaceRecovery({
          canvasFilePath: fsyncNewCanvas, nodeId: 'fsync-node', kind: 'sellhub',
        })).found,
        'the new sidecar remains authoritative after old-directory fsync failure');
        return { unlinkConverged: true, sourceFsyncConverged: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace path rebind: a failed rollback restore never deletes the durable destination',
    run: async () => {
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-marketplace-rebind-rollback-fail-'));
      const oldCanvas = path.join(base, 'old.json');
      const newCanvas = path.join(base, 'new.json');
      await fs.promises.writeFile(oldCanvas, '{}', 'utf8');
      await fs.promises.writeFile(newCanvas, '{}', 'utf8');
      const marker = newMarketplaceRecovery({
        runId: 'rollback-restore-fail',
        phase: 'scrape',
        input: marketplaceResearchInput([{ key: 'primary', query: 'Lens' }], '', ['ebay-sold']),
        inputKey: marketplaceResearchInputKey([{ key: 'primary', query: 'Lens' }], '', ['ebay-sold']),
      });
      try {
        await beginMarketplaceRecovery({
          canvasFilePath: oldCanvas, nodeId: 'rollback-node', kind: 'sellhub', recovery: marker,
        });
        const prepared = await prepareCanvasRecoveryRebind(oldCanvas, newCanvas, {
          restoreOldSource: async (filePath, value) => {
            await __marketplaceRecoveryStoreForTests.atomicWrite(filePath, value);
            throw new Error('injected post-restore failure');
          },
        });
        const committed = await prepared.commit();
        assert(committed.success && committed.destinationDurable, 'test precondition: destination commit is durable');
        const rolledBack = await prepared.rollback();
        assert(!rolledBack.success && rolledBack.destinationPreserved,
          `rollback must fail closed around the durable destination, got ${JSON.stringify(rolledBack)}`);
        assert((await peekMarketplaceRecovery({
          canvasFilePath: newCanvas, nodeId: 'rollback-node', kind: 'sellhub',
        })).found,
        'failed source restoration cannot delete the only durable destination sidecar');
        const oldRetired = await peekMarketplaceRecovery({
          canvasFilePath: oldCanvas, nodeId: 'rollback-node', kind: 'sellhub',
        });
        assert(!oldRetired.found && oldRetired.status === 'completed',
          'an ambiguous post-restore failure re-retires the old owner so two active spellings cannot resume');
        return { destinationPreserved: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'marketplace restart safety: manual vision and pricing recovery stay paused until an exact mounted Continue',
    run: () => {
      const hub = fs.readFileSync(path.join(process.cwd(), 'src/nodes/SellHubNode.jsx'), 'utf8');
      const autoStart = hub.indexOf('// Auto-start analysis if images were dropped');
      const scrapeRecovery = hub.indexOf('// A persisted active marker means the process stopped');
      const continueRecovery = hub.indexOf('const resumePausedManualAiRecovery = useCallback');
      assert(autoStart >= 0 && hub.slice(autoStart, scrapeRecovery).includes('!data.marketplaceRunResume')
        && !hub.slice(autoStart, scrapeRecovery).includes("data.marketplaceRunResume?.phase === 'analysis'"),
      'a persisted photo-analysis marker must not be treated like a fresh image drop on mount');
      assert(scrapeRecovery >= 0
        && hub.slice(scrapeRecovery, continueRecovery).includes("['analysis', 'synthesis'].includes(recovery.phase)")
        && !hub.slice(scrapeRecovery, continueRecovery).includes('Auto-resuming price synthesis'),
      'automatic recovery advances only the browser scrape phase, never a manual-AI phase');
      assert(continueRecovery >= 0
        && hub.slice(continueRecovery).includes('User continued saved photo analysis')
        && hub.slice(continueRecovery).includes('User continued saved price synthesis')
        && hub.slice(continueRecovery).includes('Continue only when you are ready to resume this exact task.'),
      'an explicit mounted Continue owns the exact saved analysis or synthesis handoff');
      assert(hub.includes("['analysis-result', 'priced-result'].includes(recovery.phase)"),
        'terminal recovery remains an automatic result replay rather than a new manual task');
      return { manualAiPaused: true, explicitContinue: true, terminalReplayPreserved: true };
    },
  },
  {
    name: 'marketplace restart safety: aborts stay pending, tombstones precede cancel, and native readers never auto-open',
    run: () => {
      assert(isMarketplaceSourceLifecycleAbort({ aborted: true }, new Error('network')),
        'AbortSignal cancellation is lifecycle interruption, not a durable source failure');
      assert(isMarketplaceSourceLifecycleAbort(null, Object.assign(new Error('cancelled'), { name: 'AbortError' })),
        'AbortError stays pending for restart');
      assert(isMarketplaceSourceLifecycleAbort(null, 'Browser pool is shutting down'),
        'browser shutdown stays pending for restart');
      assert(!isMarketplaceSourceLifecycleAbort(null, new Error('HTTP 503')),
        'a genuine fetch failure remains a checkpointable diagnostic');

      const main = fs.readFileSync(path.join(process.cwd(), 'electron/ipc/marketplace.js'), 'utf8');
      const hub = fs.readFileSync(path.join(process.cwd(), 'src/nodes/SellHubNode.jsx'), 'utf8');
      const status = fs.readFileSync(path.join(process.cwd(), 'src/nodes/MarketplaceStatusNode.jsx'), 'utf8');
      const deletion = fs.readFileSync(path.join(process.cwd(), 'src/hooks/useCanvasOSDeletion.js'), 'utf8');
      const clear = fs.readFileSync(path.join(process.cwd(), 'src/hooks/useCanvasActions.js'), 'utf8');
      const resetStart = hub.indexOf('const resetHandler = useCallback');
      const resetEnd = hub.indexOf('const nodeWidth', resetStart);
      const resetBody = hub.slice(resetStart, resetEnd);
      assert(resetBody.indexOf("await abandonRecovery(recoveryRunId, 'user-reset')") < resetBody.indexOf("await window.electronAPI.cancelNodeTaskAndWait(id, 'user-reset')"),
        'Reset commits the tombstone before aborting the main handler');
      assert(main.includes('if (isMarketplaceSourceLifecycleAbort(signal, error))')
        && main.includes('if (isMarketplaceSourceLifecycleAbort(signal, res.success ? null : res.error))'),
      'API and browser source paths both exclude lifecycle aborts from durable terminal checkpoints');
      assert(main.includes('? ids.filter(id => !shouldUseNativeRead(id) || durableRecovery.preparedByPlatform?.[id])'),
        'startup recovery filters every native-reader platform before pass 1');
      assert(status.includes('autoResume: true') && status.includes('One automatic attempt per app process'),
        'renderer issues one explicitly-marked restart attempt');
      assert(deletion.includes("reason: 'node-deleted'") && deletion.includes('abandonMarketplaceRecoveryBatch')
        && clear.includes("reason: 'canvas-cleared'") && clear.includes('abandonMarketplaceRecoveryBatch'),
      'node deletion and Clear Canvas discover autosave-gap sidecars and durably abandon them');
      return { abortPending: true, resetOrdered: true, nativePaused: true, deletionTombstoned: true };
    },
  }
];
