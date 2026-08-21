import { PLATFORM_LOGIN_URLS, PRICE_SYNTHESIS_SCHEMA, RESUMABLE_MAX_AGE_MS, SELL_PLATFORMS, appendJobsHistory, assert, buildFinalListingTitle, buildItemQuery, buildMarketplacePipelineSnapshot, buildRefreshResearchItems, buildResearchItems, bundleSynergyForPrices, classifyCompScrapeFailure, classifyUnparseableSalary, clearRun, computeBundleTotal, computeMissingLogins, computeResumeStartPage, createAggregatingProgress, createNonOverlappingRunner, dedupAgainstHistory, dedupKeysFor, deriveBundlePricingResult, enqueueStatusCheckAction, filterGrosslyOffTargetSources, filterHistoryForResume, formatPricingNotesForPrompt, fs, getBrowserPoolQueueState, getMarketplaceBrowserQueueDepth, getMarketplaceHubStatusLabel, getMarketplaceTelemetry, getRequiredCompLoginPlatformIds, getSellMonitorConfig, getSoftLoginWallMatch, getStatusCheckActionQueueDepth, getStatusCheckQueueDepth, hasMojibake, isConfirmedDisconnectedVerdict, isSessionExpired, isTrustedNativeLoginResult, loadJobsHistory, looksLikeMoney, markSourceStatus, modelTag, mojibakeExcerpt, normalizeBundlePricingResult, normalizePricingNotes, os, overPricedSoldFlag, parseSalaryToNumeric, path, pauseBrowserPool, queueScrape, readPageContentBounded, readRunState, readStagedJobs, recordSourcePage, recoverRefreshExtraItems, selectBundleHeadline, selectListingPriceTiers, selectRestorableStatuses, setStage, startRun, summarizeJobLanguages, tagJobLanguages, withMarketplaceBrowserLock, withSharedProfileLock, withStatusCheckLock } from '../test-dependencies.js';

export default [
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
        assert(report.includes('cleaned from raw title "Modern Round Wood Coffee Table - Excellent Condition"'),
          'FULL report preserves the raw title and confirms cleanup occurred');
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
        assert(/node-A/.test(report), 'overlap note names the foreign stage node');
        // The scrape (headline node) carries NO foreign tag; synthesis + fit DO.
        const scrapeHdr = report.split('\n').find(l => l.startsWith('### Comp scrape')) || '';
        const synthHdr = report.split('\n').find(l => l.startsWith('### Price synthesis')) || '';
        const fitHdr = report.split('\n').find(l => l.startsWith('### Platform fit')) || '';
        assert(scrapeHdr && !/from node/.test(scrapeHdr), 'headline-node scrape header is NOT tagged foreign');
        assert(/from node `node-A`/.test(synthHdr), 'synthesis header is tagged with its owning foreign node');
        assert(/from node `node-A`/.test(fitHdr), 'fit header is tagged with its owning foreign node');

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
        assert(/from node `node-Z`/.test(analyzeHdr), 'a stale foreign analyze is still tagged with its owning node');
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
      // Different lock instances (e.g. marketplaceBrowserLock vs statusCheckLock)
      // are independent — calling one from inside the other is NOT reentrancy.
      const crossLockResult = await withMarketplaceBrowserLock(async () => {
        return withStatusCheckLock(async () => 'cross-lock-ok');
      });
      assert(crossLockResult === 'cross-lock-ok', 'nesting a DIFFERENT lock inside another is not treated as reentrant');
      return { ok: true };
    },
  },
{
    name: 'browserViewMonitor: isSessionExpired matches each platform\'s own redirect patterns, not a generic guess',
    run: () => {
      assert(isSessionExpired('facebook', 'https://facebook.com/login') === true, 'facebook /login is expired');
      assert(isSessionExpired('facebook', 'https://facebook.com/checkpoint/123') === true, 'facebook /checkpoint is expired');
      assert(isSessionExpired('facebook', 'https://facebook.com/marketplace/you/selling') === false, 'facebook selling hub is not expired');
      assert(isSessionExpired('glassdoor', 'https://glassdoor.com/profile/login.htm') === true, 'glassdoor profile login is expired');
      assert(isSessionExpired('glassdoor', 'https://glassdoor.com/member/login.htm') === true, 'glassdoor member login is expired');
      assert(isSessionExpired('ebay', 'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn') === true, 'ebay signin is expired');
      assert(isSessionExpired('ebay', 'https://www.ebay.com/sh/lst/active') === false, 'ebay seller hub is not expired');
      // Unknown platform falls back to the generic /login|/signin|/auth check.
      assert(isSessionExpired('some-future-platform', 'https://example.com/auth/relogin') === true, 'unknown platform falls back to generic patterns');
      assert(isSessionExpired('some-future-platform', 'https://example.com/dashboard') === false, 'unknown platform, non-matching URL is not expired');
      return { ok: true };
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
        url: 'https://google.com/search?foo=session-b&htidocid=abc123',
      });
      const different = dedupKeysFor({
        url: 'https://google.com/search?htidocid=DEF456',
      });
      assert(a.includes('u:https://google.com/search?htidocid=abc123') && a.some(k => same.includes(k)),
        'same Google listing ignores session params but retains stable htidocid');
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
  }
];
