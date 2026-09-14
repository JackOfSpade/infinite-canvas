import { ALL_COMP_SOURCE_IDS, EBAY_ACTIVE_EXTRACTOR, EBAY_SOLD_EXTRACTOR, JSDOM, MERCARI_SOLD_EXTRACTOR, NATIVE_LOGIN_PLATFORMS, NATIVE_READ_PLATFORMS, PLATFORM_AUTH_COOKIES, PLATFORM_COOKIE_DOMAINS, PLATFORM_LOGIN_URLS, POSHMARK_SOLD_EXTRACTOR, PRICE_SYNTHESIS_SCHEMA, PUPPETEER_OSCRYPT_PARITY_ARGS, SELL_PLATFORMS, SELL_PLATFORM_BY_ID, SWAPPA_SOLD_EXTRACTOR, areCaptchaResolveHostsEquivalent, assert, buildAuthAttemptRecord, buildTrustedNativeLoginVerdict, canAuthCookieBypassLoginUrl, captchaResolveHostMismatchDiagnostic, classifyIndeedSessionPreflight, classifyNativeIndeedChallengeTab, classifyVisibleWindowNavigation, computeMissingLogins, cookieListHasAuth, ensureAppleEventsJsEnabled, extractAlgoliaHits, filterPriceChartingByRelevance, fs, getIndeedSessionResetOrigins, getJobLoginConfig, getLoginAutoCloseWaitReason, getSellMonitorConfig, getSoftLoginWallMatch, isAppleEventsJsDisabledError, isAptDecoApplicable, isAuthChallengeUrl, isBrowserProcessExited, isIndeedCookieDomain, isInlineLoginPlatform, isLoggedOutTitleForPlatform, isLoginUrlPath, isNativeIndeedChallengeCleared, isNativeIndeedChallengeHardBlock, isNativeIndeedChallengePending, nativeIndeedChallengeIsStalled, isNativeLoginSuccess, isPostLoginInterstitialUrl, isPriceChartingApplicable, isStrictIndeedHttpsUrl, nativeIndeedChallengeExitDisposition, nativeIndeedChallengeTabIdentity, nativeReadLoginState, nativeReadLooksChallenged, nativeReadLooksLoggedOut, nativeReadToFetchResult, os, parseAiJson, parseAptDecoComps, parseNativeReadOutput, parsePriceChartingHtml, path, priceChartingQuery, renderSessionTraceBlocks, reverbListingsToComps, selectNativeIndeedChallengeTab, selectRestorableStatuses, shouldHandoffIndeedChallengeToNative, shouldUseNativeRead, unwrapInlineExtractorItems, validateVisibleWindowUrl, visibleWindowLaunchOptions, waitForBrowserProcessExit, withAppleEventsJsEnabled } from '../test-dependencies.js';
import { CAPTCHA_RESOLVE_CHALLENGE_SELECTORS } from '../test-dependencies.js';
import { shouldAutoCloseCaptchaResolveWithoutExtractor } from '../test-dependencies.js';
// Imported at the source: the shared test-dependencies barrel is edited by
// other areas, and this helper is only exercised here.
import { normalizeNativeTabQueryError } from '../../electron/ipc/browser/authWindows.js';

export default [
{
    name: 'parseAiJson: repairs markdown fences, trailing commas, top-level arrays, stray-bracket prose',
    run: () => {
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      // Plain object, markdown-fenced, and trailing-comma cleanup.
      assert(eq(parseAiJson('{"a":1}'), { a: 1 }), 'parseAiJson: plain object');
      assert(eq(parseAiJson('```json\n{"a":1}\n```'), { a: 1 }), 'parseAiJson: fenced object');
      assert(eq(parseAiJson('{"a":1,}'), { a: 1 }), 'parseAiJson: trailing comma');
      // Top-level arrays must NOT be mangled (guards the fallback against
      // starting the span at the first inner brace).
      assert(eq(parseAiJson('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]), 'parseAiJson: top-level array');
      // Regression: prose containing a stray bracket before the JSON object used
      // to make the first-open/last-close span start at the stray '[' and throw.
      assert(eq(parseAiJson('Use [ ] for arrays: {"status":"ok"}'), { status: 'ok' }), 'parseAiJson: stray bracket in prose');
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

      // (d) eBay served a FOREIGN listing layout (A/B bucket / rollback / redesign):
      //     the page is fully loaded with real listing links, but NONE of the
      //     .s-card / .srp-results selectors — nor any known alt-container — match,
      //     so cards[0] is null and the OLD diag emitted no card0 skeleton, leaving
      //     the bug report unable to tell a layout change from a wall (the actual
      //     "eBay retries still fail" report). The upgraded diag must still be
      //     self-diagnosing: a bodyHead visible-text snippet + alt-layout counts
      //     (sItem/brw/itmLinks) + a card0 skeleton auto-discovered from the LI/DIV
      //     ancestor of the first /itm/ link.
      const foreignEbay =
        '<html><head><title>shark slider nano</title></head><body>' +
        '<h1>Results for shark slider nano</h1>' +
        '<ul class="brand-new-results">' +
        '<li class="nu-card"><a class="nu-card__link" href="/itm/123456">Shark Slider Nano II</a>' +
        '<span class="nu-card__cost">$500.00</span></li>' +
        '</ul></body></html>';
      for (const [label, ex] of [['ebay-sold', EBAY_SOLD_EXTRACTOR], ['ebay-active', EBAY_ACTIVE_EXTRACTOR]]) {
        const m = evalThrow(ex, foreignEbay, 'https://www.ebay.com/sch/i.html?_nkw=shark+slider');
        assert(m && /SITE_CHANGED/.test(m), `${label} foreign layout should throw SITE_CHANGED → ${m}`);
        assert(/cards=0/.test(m) && /anySCard=0/.test(m), `${label} expected 0 known cards → ${m}`);
        // The three fields that make a 0-known-selector page diagnosable:
        assert(/itmLinks=1/.test(m), `${label} should count the real /itm/ listing link → ${m}`);
        assert(/sItem=0/.test(m) && /brw=0/.test(m), `${label} alt-layout counts should be present → ${m}`);
        assert(/bodyHead="[^"]*results for shark slider/i.test(m), `${label} bodyHead must carry visible page text → ${m}`);
        assert(/card0=\[[^\]]*nu-card/.test(m), `${label} skeleton must auto-discover the foreign card class → ${m}`);
        assert(!/LOGIN-WALL/.test(m), `${label} a real results page must NOT flag login → ${m}`);
      }

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
      const ehtml = '<html><head><title>eBay</title></head><body><div class="srp-river-main">' +
        '<div class="su-item-card"><a class="su-item-card__title" href="https://www.ebay.com/itm/123">Apple iPhone XS</a>' +
        '<span class="su-item-card__price">$10.00 to $20.00</span></div>' +
        '</div></body></html>';
      const edom = new JSDOM(ehtml, { url: 'https://www.ebay.com/sch/i.html?_nkw=x&_sop=15', runScripts: 'outside-only' });
      const eout = edom.window.eval(EBAY_ACTIVE_EXTRACTOR);
      assert(eout.items[0].price === 10, `eBay range should parse the low end 10 (not 10.002), got ${eout.items[0]?.price}`);
      return { ok: true, mercari: mprices, ebayRange: eout.items[0].price };
    },
  },
{
    name: 'eBay extractors: dedup-by-url never collapses distinct no-url cards onto each other',
    run: () => {
      // Title and link are now the SAME element (a.su-item-card__title) — a
      // card with no href attribute gets url: '' (see EBAY_ACTIVE_EXTRACTOR).
      // Two real duplicates of the SAME url must still collapse to one, but two
      // otherwise-distinct no-link cards must NOT collapse onto each other just
      // because they share the empty-string url.
      const card = (title, price, href) =>
        `<div class="su-item-card">` +
        `<a class="su-item-card__title"${href ? ` href="${href}"` : ''}>${title}</a>` +
        `<span class="su-item-card__price">$${price}</span>` +
        '</div>';
      const html = '<html><head><title>eBay</title></head><body><div class="srp-river-main">' +
        card('Widget A', 10, 'https://www.ebay.com/itm/1') +
        card('Widget A duplicate', 10, 'https://www.ebay.com/itm/1') + // same url → real dup, collapse
        card('Widget B (no link)', 20, null) +
        card('Widget C (no link)', 30, null) +   // different listing, also no link → must survive
        '</div></body></html>';
      const dom = new JSDOM(html, { url: 'https://www.ebay.com/sch/i.html?_nkw=x&_sop=15', runScripts: 'outside-only' });
      const out = dom.window.eval(EBAY_ACTIVE_EXTRACTOR);
      const titles = out.items.map(i => i.title);
      assert(out.items.length === 3, `expected 3 items (1 real dup collapsed, 2 no-url cards both kept), got ${out.items.length}: ${titles.join(', ')}`);
      assert(titles.includes('Widget B (no link)') && titles.includes('Widget C (no link)'),
        `both no-url cards must survive independently, got ${titles.join(', ')}`);
      return { ok: true, titles };
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
    name: 'parseAptDecoComps extracts embedded Algolia records (active asking prices)',
    run: () => {
      // AptDeco's /catalog?q= SSR HTML embeds the first Algolia results page as a
      // literal `"hits":[ … ]` JSON array. We parse those records directly (no
      // browser). Each record's `price` is the CURRENT ask (the comp value);
      // `original_price` is retail context and must NOT be used as the price.
      const rec = (o) => JSON.stringify({
        is_available: true, is_saleable: true, condition_title: 'Good',
        ...o,
      });
      const html =
        '<html><body><script>self.__next_f.push([1,' +
        '{"results":[{"nbHits":1702,"hits":[' +
        rec({ title: 'IKEA Light Brown Fabric Sleeper Sofa', price: 250, original_price: 400, page_url: 'ikea-light-brown-fabric-sleeper-sofa-1' }) + ',' +
        // Bracket inside a string value → must NOT unbalance the array scanner.
        rec({ title: 'Mid-Century [Floor Model] Sofa', price: 480, original_price: 1200, page_url: 'mid-century-floor-model-sofa', condition_title: 'Excellent' }) + ',' +
        rec({ title: 'Sold Already Sofa', price: 99, page_url: 'sold-already-sofa', is_available: false }) + ',' +       // unavailable → skip
        rec({ title: 'Not Saleable Sofa', price: 75, page_url: 'not-saleable-sofa', is_saleable: false }) + ',' +        // not saleable → skip
        rec({ title: 'Zero Price Sofa', price: 0, page_url: 'zero-price-sofa' }) + ',' +                                  // price 0 → skip
        rec({ title: 'Dup Sofa', price: 250, page_url: 'ikea-light-brown-fabric-sleeper-sofa-1' }) +                      // dup url → dedup
        ']}]}' +
        '])</script></body></html>';
      const comps = parseAptDecoComps(html);
      assert(comps.length === 2, `expected 2 comps (unavailable/not-saleable/zero/dup excluded), got ${comps.length}: ${comps.map(c => c.title).join(' | ')}`);
      // Current ask, NOT original_price.
      assert(comps[0].price === 250 && comps[0].priceText === '$250.00', `current ask not retail → ${JSON.stringify(comps[0])}`);
      assert(comps[0].url === 'https://www.aptdeco.com/product/ikea-light-brown-fabric-sleeper-sofa-1', `absolute product url → ${comps[0].url}`);
      assert(comps[0].source === 'aptdeco-active', `source tag → ${comps[0].source}`);
      assert(comps[0].condition === 'Good', `condition mapped → ${comps[0].condition}`);
      // String-aware scanner: a record AFTER the bracketed-title one is still parsed.
      assert(comps[1].title === 'Mid-Century [Floor Model] Sofa' && comps[1].price === 480, `bracket-in-string title parsed → ${JSON.stringify(comps[1])}`);
      // No hits / malformed / empty → [] (no throw — a restructured page yields no comps).
      assert(parseAptDecoComps('<html><body>no algolia here</body></html>').length === 0, 'no hits marker → 0 comps');
      assert(parseAptDecoComps('').length === 0, 'empty string → 0 comps');
      assert(extractAlgoliaHits('"hits":[ {"broken": ').length === 0, 'unterminated array → []');
      assert(extractAlgoliaHits('"hits":[]').length === 0, 'empty hits array → []');
      return { ok: true, prices: comps.map(c => c.price) };
    },
  },
{
    name: 'isAptDecoApplicable gates AptDeco to furniture / home furnishings',
    run: () => {
      // Furniture / home furnishings → run AptDeco.
      assert(isAptDecoApplicable('Furniture > Sofas > Sectional') === true, 'sofa → applicable');
      assert(isAptDecoApplicable('Furniture > Tables > Dining Table') === true, 'dining table → applicable');
      assert(isAptDecoApplicable('Home & Office > Desks') === true, 'desk → applicable');
      assert(isAptDecoApplicable('Home Decor > Rugs') === true, 'rug → applicable');
      assert(isAptDecoApplicable('Lighting > Floor Lamp') === true, 'lamp → applicable');
      assert(isAptDecoApplicable('Bedroom > Dresser') === true, 'dresser → applicable');
      // Off-category → skip (the spurious-fuzzy-match cases observed live).
      assert(isAptDecoApplicable('Electronics > Phones > Smartphone') === false, 'iphone → not applicable');
      assert(isAptDecoApplicable('Clothing & Shoes > Sneakers') === false, 'sneakers → not applicable');
      assert(isAptDecoApplicable('Video Games > Consoles') === false, 'console → not applicable');
      assert(isAptDecoApplicable('Home & Garden > Vacuums') === false, 'vacuum → not applicable');
      assert(isAptDecoApplicable('Musical Instruments > Guitars') === false, 'guitar → not applicable');
      // Unknown/blank → don't suppress (back-compat; Algolia returns [] + ranker guards).
      assert(isAptDecoApplicable('') === true, 'blank category → applicable');
      assert(isAptDecoApplicable(undefined) === true, 'undefined category → applicable');
      return { ok: true };
    },
  },
{
    name: 'AptDeco registered as comp source + sell platform (no login requirement)',
    run: () => {
      // Comp source present (family-scoped as `aptdeco`).
      assert(ALL_COMP_SOURCE_IDS.includes('aptdeco-active'), `aptdeco-active in comp sources → ${ALL_COMP_SOURCE_IDS.join(', ')}`);
      // Available as a selling platform with a post URL.
      const plat = SELL_PLATFORM_BY_ID.aptdeco;
      assert(plat && plat.id === 'aptdeco' && plat.domain === 'aptdeco.com', `aptdeco sell platform → ${JSON.stringify(plat)}`);
      assert(typeof plat.postUrl === 'string' && plat.postUrl.includes('aptdeco.com'), `aptdeco postUrl → ${plat.postUrl}`);
      // Public catalog (Algolia SSR) → NO login required for the price check.
      assert(computeMissingLogins([{ id: 'aptdeco-active' }], {}).length === 0, 'aptdeco-active → no login requirement');
      // The synthesis schema enum is derived from SELL_PLATFORMS → includes aptdeco
      // and stays in lockstep (same length + every sell id present).
      const schemaIds = PRICE_SYNTHESIS_SCHEMA.properties.recommended_platforms.items.properties.id.enum;
      const sellIds = SELL_PLATFORMS.map(p => p.id);
      assert(schemaIds.includes('aptdeco'), `recommended_platforms enum includes aptdeco → ${schemaIds.join(', ')}`);
      assert(schemaIds.length === sellIds.length && sellIds.every(x => schemaIds.includes(x)),
        'synthesis enum stays in sync with SELL_PLATFORMS');
      // As a selling platform it must satisfy the sell-monitor auth invariant
      // (every SELL_PLATFORMS id needs a config) — verified create-page auth gate.
      const monitor = getSellMonitorConfig('aptdeco');
      assert(monitor && monitor.verifyUrl && Array.isArray(monitor.bodySignals) && monitor.bodySignals.length > 0,
        `aptdeco sell-monitor config present → ${JSON.stringify(monitor)}`);
      return { ok: true };
    },
  },
{
    name: 'AptDeco login detection: auth prompt present only when logged out (verified live)',
    run: () => {
      // Both snippets are the REAL rendered /sell/new visible text (verified by
      // logging in): AptDeco has no /login route — the create page IS the auth gate.
      const cfg = getSellMonitorConfig('aptdeco');
      // Logged OUT → the page offers "Already have an account? Sign in".
      const loggedOut = "Let's start listing your furniture. This should only take a few minutes. Happy selling! First time selling? Check out our seller's guide Already have an account? Sign in Take $10 off your first purchase Sign up for the latest updates, products and offers Enter email address";
      // Logged IN → the listing form renders instead (category picker, Save Draft /
      // Submit); the auth prompt is gone. The "Sign up for the latest updates"
      // NEWSLETTER persists in BOTH states, so it must NOT be a login-wall signal.
      const loggedIn = "Let's start listing your furniture. This should only take a few minutes. Happy selling! First time selling? Check out our seller's guide 1. Basic Info What are you selling? Most furniture items can be sold on AptDeco, however there are a few exceptions. We cannot sell: mattresses, IKEA wardrobes, murphy beds or electronics. Beds Chairs Décor Lighting Outdoor & Garden Rugs Sofas Storage Tables 2. Product Overview 3. Product Details 4. Pickup Info Save Draft Submit Take $10 off your first purchase Sign up for the latest updates, products and offers Enter email address";
      assert(getSoftLoginWallMatch(loggedOut, cfg) !== null, 'logged-out /sell/new → detected as login wall');
      assert(getSoftLoginWallMatch(loggedIn, cfg) === null,
        'logged-in /sell/new (form) → NOT a login wall (newsletter "sign up" / "enter email address" must not trip it)');
      return { ok: true };
    },
  },
{
    // AptDeco's logged-in DOM is client-rendered, so body-text verify races the
    // auth swap and false-reads a logged-in user as logged out. The render-safe
    // signal is the `token` JWT cookie (present only when logged in). This guards
    // the cookie wiring + the pure match rule shared by the poller and the verify.
    name: 'AptDeco cookie-based login signal (token cookie, render-safe)',
    run: () => {
      assert(Array.isArray(PLATFORM_AUTH_COOKIES.aptdeco) && PLATFORM_AUTH_COOKIES.aptdeco.includes('token'),
        `aptdeco auth cookie must be the token JWT → ${JSON.stringify(PLATFORM_AUTH_COOKIES.aptdeco)}`);
      // aptdecofrontend is a server session that also exists anonymously → must NOT be a signal.
      assert(!PLATFORM_AUTH_COOKIES.aptdeco.includes('aptdecofrontend'), 'aptdecofrontend must not be an auth signal (exists anonymously)');
      // The sell-monitor config opts into cookie-first verification.
      assert(getSellMonitorConfig('aptdeco')?.verifyViaCookie === true, 'aptdeco must opt into verifyViaCookie');
      // Pure match rule: token present (non-empty) → logged in.
      const names = PLATFORM_AUTH_COOKIES.aptdeco;
      assert(cookieListHasAuth([{ name: 'token', value: 'eyJhbGci...' }, { name: 'aptdecofrontend', value: 'abc' }], names) === true, 'token present → logged in');
      // Only the anonymous server-session present (no token) → logged out.
      assert(cookieListHasAuth([{ name: 'aptdecofrontend', value: 'abc' }, { name: 'aws-waf-token', value: 'x' }], names) === false, 'no token → logged out');
      // Empty / "0" token value → not a valid signal.
      assert(cookieListHasAuth([{ name: 'token', value: '' }], names) === false, 'empty token → logged out');
      assert(cookieListHasAuth([], names) === false, 'no cookies → logged out');
      return { ok: true };
    },
  },
{
    // The login-attempt history is what answers "I just logged into X but it says
    // logged out" — it must record whether each login window CONFIRMED login, since
    // the verbose login logs scroll out of the main ring buffer in seconds.
    name: 'buildAuthAttemptRecord: derives login-detected discriminator for the bug report',
    run: () => {
      // A confirmed login: result auto-detected + a signal → detected=true.
      const ok = buildAuthAttemptRecord({ platformId: 'facebook', result: 'auto-detected', loginSignal: 'auth-cookie', mode: 'puppeteer-visible', currentUrl: 'https://www.facebook.com/' });
      assert(ok.loginDetected === true && ok.loginSignal === 'auth-cookie' && ok.platformId === 'facebook', 'auto-detected with a signal → detected=true');
      // A window that closed WITHOUT confirming login → detected=false (the "I logged
      // in but it never registered" case we need to distinguish).
      const closed = buildAuthAttemptRecord({ platformId: 'poshmark', result: 'closed', mode: 'puppeteer-visible' });
      assert(closed.loginDetected === false, 'closed without detection → detected=false');
      const challengeCleared = buildAuthAttemptRecord({
        platformId: 'indeed-native-challenge', result: 'cleared', mode: 'native-chrome',
      });
      assert(challengeCleared.loginDetected === null,
        'native challenge clearance is not a login claim or a failed login detection');
      const nativeClosure = buildAuthAttemptRecord({
        platformId: 'indeed-native-challenge', result: 'closed', mode: 'native-chrome',
        nativeChallenge: {
          initialChallengeObserved: true, pollCount: 4, pollErrorCount: 0,
          lastClassification: 'cleared', lastTabUrl: 'https://secure.indeed.com/settings/account?token=secret',
          terminalSource: 'child-exit-after-clean', exitCode: 0,
          postCloseVerify: { outcome: 'clean-tab-observed', reason: 'first-party-url-and-title-before-exit' },
        },
      });
      assert(nativeClosure.nativeChallenge?.pollCount === 4
        && nativeClosure.nativeChallenge?.terminalSource === 'child-exit-after-clean'
        && nativeClosure.nativeChallenge?.postCloseVerify?.outcome === 'clean-tab-observed',
      'completed native challenges retain bounded poll/exit/verification evidence after the live diagnostic is cleared');
      // Explicit loginDetected wins over the result-derived default.
      assert(buildAuthAttemptRecord({ result: 'closed', loginDetected: true }).loginDetected === true, 'explicit loginDetected overrides the result default');
      // autoDetectedLoginSignal (native path field) is accepted as the signal source.
      assert(buildAuthAttemptRecord({ result: 'auto-detected', autoDetectedLoginSignal: 'dom' }).loginSignal === 'dom', 'autoDetectedLoginSignal falls through to loginSignal');
      // URL is sanitized (backticks stripped) and bounded so it can't break the md table.
      const longUrl = buildAuthAttemptRecord({ loginUrl: 'https://x.com/`' + 'a'.repeat(400) });
      assert(!longUrl.url.includes('`') && longUrl.url.length <= 180, 'url is backtick-stripped and length-capped');
      const titled = buildAuthAttemptRecord({ title: 'My Listings | Mercari `x`' });
      assert(titled.title === "My Listings \\| Mercari 'x'", `title is preserved and markdown-safe → ${titled.title}`);
      const durable = buildAuthAttemptRecord({
        platformId: 'linkedin', result: 'auto-detected', loginDetected: true,
        closeDisposition: 'graceful-exit', cookieFlushMs: 2500, processExitObserved: true,
        authCookiesBeforeClose: [{ name: 'li_at', persistent: true, expiresAt: 1_900_000_000, value: 'must-not-leak' }],
      });
      assert(durable.closeDisposition === 'graceful-exit' && durable.cookieFlushMs === 2500 && durable.processExitObserved === true,
        'completed auth history preserves the close/checkpoint lifecycle');
      assert(durable.authCookiesBeforeClose[0]?.name === 'li_at'
        && durable.authCookiesBeforeClose[0]?.persistent === true
        && !('value' in durable.authCookiesBeforeClose[0]),
      'auth diagnostics preserve name/persistence metadata but never cookie values');
      return { ok: true };
    },
  },
{
    // The bug report shows cookieFlushMs under one "Pre-close wait ms" heading,
    // but the child-exit path measures the profile checkpoint AFTER Chrome is
    // already gone. Without a phase stamped by the producer, a post-close
    // observation reads as a wait the app chose to take before closing — the
    // renderer has no field left to tell them apart. Pin the vocabulary: it is
    // the contract the report renderer reads.
    name: 'buildAuthAttemptRecord: cookieFlushPhase records WHEN the flush was measured',
    run: () => {
      for (const phase of ['pre-close-fixed', 'pre-close-checkpoint', 'post-close-observe']) {
        const record = buildAuthAttemptRecord({ platformId: 'indeed', cookieFlushMs: 1800, cookieFlushPhase: phase });
        assert(record.cookieFlushPhase === phase && record.cookieFlushMs === 1800,
          `cookieFlushPhase '${phase}' survives into the durable record → ${record.cookieFlushPhase}`);
      }
      // Allowlisted like every other field in the record: an unrecognised phase
      // is dropped rather than forwarded, so the renderer can only ever receive
      // a value this file actually produces.
      for (const bogus of ['post-close', 'PRE-CLOSE-FIXED', 'whenever', 42, { phase: 'pre-close-fixed' }, '']) {
        const record = buildAuthAttemptRecord({ platformId: 'indeed', cookieFlushMs: 1800, cookieFlushPhase: bogus });
        assert(record.cookieFlushPhase === null,
          `an unrecognised cookieFlushPhase (${JSON.stringify(bogus)}) is nulled, not forwarded → ${JSON.stringify(record.cookieFlushPhase)}`);
      }
      assert(buildAuthAttemptRecord({ platformId: 'indeed', cookieFlushMs: 1800 }).cookieFlushPhase === null,
        'a producer that stamped no phase reports null rather than a guessed one');

      // The producers are private to authWindows.js, so pin them at the source.
      const authSrc = fs.readFileSync(path.join('electron', 'ipc', 'browser', 'authWindows.js'), 'utf8');
      // The login window's fixed pre-close sleep is SKIPPED when no login was
      // confirmed. Reporting 0 there claims a wait was measured at zero; the
      // only honest value for a wait that never happened is null.
      assert(authSrc.includes('const cookieFlushMs = loginConfirmed ? NATIVE_LOGIN_COOKIE_FLUSH_MS : null;'),
        'the login close path must report a null cookieFlushMs when it took no flush wait, not 0');
      assert(authSrc.includes("cookieFlushPhase: 'pre-close-fixed'"),
        "the login window's fixed pre-close sleep must stamp cookieFlushPhase: 'pre-close-fixed'");
      // Every producer that reports a duration must say which phase it measured.
      // Catches a future cookieFlushMs write added without a phase — which would
      // land in the report's pre-close column with no way to tell it apart.
      const unstamped = authSrc.split(/\r?\n/).filter(line =>
        /cookieFlushMs:\s/.test(line) && !line.includes('diag.cookieFlushMs') && !line.includes('cookieFlushPhase'));
      assert(unstamped.length === 0,
        `every cookieFlushMs producer must stamp cookieFlushPhase on the same write → unstamped: ${JSON.stringify(unstamped.map(l => l.trim()))}`);
      return { ok: true };
    },
  },
{
    name: 'auth browser process-exit wait observes healthy closes and already-exited children',
    run: async () => {
      const listeners = new Set();
      const proc = {
        exitCode: null,
        signalCode: null,
        once(event, fn) { if (event === 'exit') listeners.add(fn); },
        removeListener(event, fn) { if (event === 'exit') listeners.delete(fn); },
      };
      const waiting = waitForBrowserProcessExit(proc, 250);
      setTimeout(() => {
        proc.exitCode = 0;
        for (const fn of [...listeners]) fn(0, null);
      }, 5);
      assert(await waiting === true, 'a normal exit emitted after subscription is observed');
      assert(isBrowserProcessExited(proc) === true, 'exitCode marks the process exited even though proc.killed is false');
      assert(await waitForBrowserProcessExit(proc, 250) === true,
        'an already-exited process resolves immediately instead of producing a false 3s hang/SIGKILL');
      return { ok: true };
    },
  },
{
    name: 'Indeed status-cache migration drops only the retired public-jobs false positive',
    run: () => {
      const now = 1_000_000_000_000;
      const day = 24 * 60 * 60 * 1000;
      const legacyReason = 'Native Chrome reached logged-in indeed job-search page at https://www.indeed.com/jobs?q=architect.';
      const stored = {
        indeed: { connected: true, ts: now - day, lastReason: legacyReason },
        ebay: { connected: true, ts: now - day, lastReason: 'Native Chrome reached logged-in ebay marketplace account page at https://www.ebay.com/mye/myebay/summary.' },
        otherPlatformSameWords: { connected: true, ts: now - day, lastReason: legacyReason },
      };
      const restored = selectRestorableStatuses(stored, now, 14 * day);
      assert(!restored.indeed,
        'the retired Indeed public /jobs native-success verdict must not survive a restart');
      assert(restored.ebay && restored.otherPlatformSameWords,
        `all other recent connected entries must remain restorable (got ${JSON.stringify(restored)})`);
      const validIndeed = selectRestorableStatuses({
        indeed: { connected: true, ts: now - day, lastReason: 'Native Chrome reached logged-in indeed job-platform account page at https://secure.indeed.com/settings/account.' },
      }, now, 14 * day);
      assert(validIndeed.indeed?.connected === true,
        'a recent Indeed account-page confirmation must remain restorable');
      const currentVerdict = buildTrustedNativeLoginVerdict('indeed', {
        currentUrl: 'https://secure.indeed.com/settings/account',
        title: 'Account settings | Indeed',
      });
      assert(/indeed job-platform account page/.test(currentVerdict.reason)
        && !/job-search page/.test(currentVerdict.reason),
      `new native Indeed diagnostics must name the authenticated account page truthfully (got ${currentVerdict.reason})`);
      return { restored: Object.keys(restored).sort() };
    },
  },
{
    name: 'Native Indeed challenge handoff waits for a stable clean first-party page',
    run: () => {
      const challengeUrl = 'https://secure.indeed.com/auth?__cf_chl_rt_tk=token';
      assert(isNativeIndeedChallengePending(challengeUrl, 'Just a moment...') === true,
        'a native Cloudflare interstitial stays pending');
      assert(isNativeIndeedChallengePending('https://ca.indeed.com/jobs?q=architect', 'Additional verification required') === true,
        'Cloudflare verification text remains pending even on the public jobs path');
      assert(isNativeIndeedChallengeCleared('https://ca.indeed.com/jobs?q=architect', 'Software Architect Jobs, Employment | Indeed') === true,
        'a settled first-party results page is a valid post-challenge handoff destination');
      assert(isNativeIndeedChallengeCleared(challengeUrl, 'Just a moment...') === false,
        'a challenge URL/title must never report cleared');
      assert(isNativeIndeedChallengeCleared('https://accounts.google.com/signin', 'Sign in - Google Accounts') === false,
        'an OAuth page is not a cleared Indeed page');
      assert(isNativeIndeedChallengeCleared('https://ca.indeed.com/jobs?q=architect', '') === false,
        'an empty/loading title is not sufficient proof that the native page settled');
      assert(isStrictIndeedHttpsUrl('https://ca.indeed.com/jobs') === true
        && isStrictIndeedHttpsUrl('https://indeed.com.evil.test/jobs') === false,
      'native handoff accepts only strict Indeed HTTPS hosts');
      assert(isNativeIndeedChallengeHardBlock('https://ca.indeed.com/jobs', 'Attention Required!') === true
        && isNativeIndeedChallengeCleared('https://ca.indeed.com/jobs', 'Access Denied') === false,
      'hard blocks cannot be mistaken for a clean handoff page');
      const selected = selectNativeIndeedChallengeTab([
        { url: 'https://www.indeed.com/jobs?q=old', title: 'Old search | Indeed' },
        { url: 'https://ca.indeed.com/jobs?__cf_chl_rt_tk=token', title: 'Just a moment...' },
        { url: 'https://indeed.com.evil.test/jobs', title: 'Just a moment...' },
      ], 'https://ca.indeed.com/jobs?__cf_chl_rt_tk=token');
      assert(selected?.url === 'https://ca.indeed.com/jobs?__cf_chl_rt_tk=token',
        'native handoff polls the pending tab for the requested strict hostname, not an unrelated/restored tab');
      const initialChallengeTab = {
        windowIndex: 4,
        tabIndex: 1,
        url: 'https://secure.indeed.com/settings/account?__cf_chl_rt_tk=token',
        title: 'Just a moment...',
      };
      const tabIdentity = nativeIndeedChallengeTabIdentity(initialChallengeTab);
      assert(tabIdentity === '4:1', 'native tab identity is a bounded window/tab pair');
      // AppleScript orders `windows` front-to-back, so the index pair renumbers
      // whenever the user focuses another Chrome window. Chrome's own stable tab
      // id wins whenever the inventory carries it; indexes stay as the fallback.
      assert(nativeIndeedChallengeTabIdentity({ ...initialChallengeTab, tabId: '2125944271' }) === 'id:2125944271',
        'a stable Chrome tab id is preferred over the front-to-back window/tab indexes');
      const followedById = selectNativeIndeedChallengeTab([
        { windowIndex: 1, tabIndex: 1, tabId: '77', url: 'https://www.indeed.com/jobs?q=old', title: 'Old search | Indeed' },
        { windowIndex: 2, tabIndex: 3, tabId: '2125944271', url: 'https://ca.indeed.com/jobs?q=architect', title: 'Software Architect Jobs | Indeed' },
      ], initialChallengeTab.url, { trackedTabIdentity: 'id:2125944271' });
      assert(followedById?.tabId === '2125944271',
        'the tracked tab is followed by its stable id even after its window/tab indexes move');
      // A challenge that auto-progresses (or is solved between two polls) never
      // yields the 'pending' snapshot the tracked identity is armed from, and
      // Indeed moves the solved page to a regional host. The hostname pin may
      // be relaxed for that — but ONLY once some poll has actually seen a tab at
      // the requested host, which is the only positive evidence that the window
      // this handoff opened is in the inventory answering our Apple events.
      const soloIndeedInventory = [
        { windowIndex: 1, tabIndex: 1, tabId: '9', url: 'https://ca.indeed.com/jobs?q=architect', title: 'Software Architect Jobs | Indeed' },
        { windowIndex: 1, tabIndex: 2, tabId: '10', url: 'https://mail.google.com/mail/u/0/', title: 'Inbox' },
      ];
      const regionallyRedirected = selectNativeIndeedChallengeTab(
        soloIndeedInventory, 'https://www.indeed.com/jobs?q=architect', { sawTargetHostTab: true });
      assert(regionallyRedirected?.tabId === '9' && classifyNativeIndeedChallengeTab(regionallyRedirected) === 'cleared',
        'a handoff window that WAS seen at the requested host is still followed through a regional redirect the poll never saw start');
      // The regression this gate exists for: only one Chrome instance answers an
      // Apple event addressed to "Google Chrome". When the handoff child is not
      // that instance, this inventory is the user's ordinary Chrome and tab 9 is
      // their own unrelated Indeed tab. Selecting it would classify 'cleared',
      // SIGTERM the child while the user is still solving the real wall, and
      // report a clearance nobody observed. Selecting nothing settles 'closed',
      // which falls through to the resume scrape — so strictness costs nothing.
      assert(selectNativeIndeedChallengeTab(soloIndeedInventory, 'https://www.indeed.com/jobs?q=architect') === null,
        'a handoff whose window was never seen at the requested host selects nothing, however lonely the foreign Indeed tab is');
      assert(selectNativeIndeedChallengeTab([
        { windowIndex: 1, tabIndex: 1, tabId: '9', url: 'https://ca.indeed.com/jobs?q=architect', title: 'Software Architect Jobs | Indeed' },
        { windowIndex: 1, tabIndex: 2, tabId: '10', url: 'https://secure.indeed.com/settings/account', title: 'Account settings' },
      ], 'https://www.indeed.com/jobs?q=architect', { sawTargetHostTab: true }) === null,
      'with two Indeed tabs and none at the requested host the selection stays strict — a restored tab can never clear a handoff');
      const redirected = selectNativeIndeedChallengeTab([
        { windowIndex: 1, tabIndex: 1, url: 'https://www.indeed.com/jobs?q=old', title: 'Old search | Indeed' },
        { windowIndex: 4, tabIndex: 1, url: 'https://ca.indeed.com/jobs?q=architect', title: 'Software Architect Jobs | Indeed' },
      ], initialChallengeTab.url, { trackedTabIdentity: tabIdentity });
      assert(redirected?.windowIndex === 4
        && classifyNativeIndeedChallengeTab(redirected) === 'cleared',
      'once this app tab was observed pending, its post-challenge regional redirect remains attributable even with an older clean Indeed tab open');
      assert(classifyNativeIndeedChallengeTab({ url: 'https://ca.indeed.com/jobs?q=x', title: 'Attention Required!' }) === 'hard-block'
        && classifyNativeIndeedChallengeTab({ url: 'https://ca.indeed.com/jobs?q=x', title: '' }) === 'unknown',
      'exit fallback only accepts an affirmative clean title, never an empty/loading or hard-block page');

      // A TERMINAL Indeed wall ("Additional Verification Required") matches the
      // pending pattern but has no form, no iframe and no widget. Left as
      // 'pending' it held the visible window for the full 5-minute ceiling WHILE
      // HOLDING the shared browser profile lock, then told the user to complete a
      // check that has no controls. A page frozen at the same url+title is
      // reclassified; an auto-progressing wall re-titles within seconds and is
      // unaffected.
      const WALL = 'Additional Verification Required';
      assert(nativeIndeedChallengeIsStalled({ classification: 'pending', unchangedForMs: 130_000, title: WALL }),
        'the known non-interactive wall, frozen past two minutes, is terminal');
      assert(!nativeIndeedChallengeIsStalled({ classification: 'pending', unchangedForMs: 60_000, title: WALL }),
        'one minute is not yet enough — closing a window a user is working in is worse than waiting');
      // The title requirement is the safety property: it is what stops this rule
      // from ever closing a challenge the user could actually have solved.
      assert(!nativeIndeedChallengeIsStalled({ classification: 'pending', unchangedForMs: 600_000, title: 'Just a moment…' }),
        'an auto-progressing wall is never reclassified, however long it sits');
      assert(!nativeIndeedChallengeIsStalled({ classification: 'pending', unchangedForMs: 600_000, title: 'Verify you are human' }),
        'an interactive challenge is never reclassified — a user may be mid-solve with a static title');
      assert(!nativeIndeedChallengeIsStalled({ classification: 'pending', unchangedForMs: 600_000 }),
        'no title means no evidence, so the rule cannot fire');
      assert(!nativeIndeedChallengeIsStalled({ classification: 'cleared', unchangedForMs: 600_000, title: WALL }),
        'a CLEARED page is never reclassified as a block no matter how long it sits');
      assert(!nativeIndeedChallengeIsStalled({ classification: 'pending', title: WALL }),
        'a missing duration never trips the rule');
      assert(!nativeIndeedChallengeIsStalled({}), 'an empty state never trips the rule');
      const cleanAtExit = { at: 3_100, url: 'https://secure.indeed.com/settings/account', title: 'Account settings' };
      const acceptedExit = nativeIndeedChallengeExitDisposition({
        cleanObservationAtExit: cleanAtExit,
        startedAt: 0,
        cookieStoreCommitted: false,
      });
      const bareClose = nativeIndeedChallengeExitDisposition({
        cleanObservationAtExit: null,
        startedAt: 0,
        cookieStoreCommitted: true,
      });
      assert(acceptedExit.result === 'cleared' && acceptedExit.terminalSource === 'child-exit-after-clean',
        'a clean first-party tab captured before the child exits resumes the handoff even if the stability timer had not elapsed');
      assert(bareClose.result === 'closed' && bareClose.postCloseOutcome === 'profile-checkpoint-only',
        'a profile checkpoint after a manual close is diagnostic evidence, not clearance success without a clean tab snapshot');
      return { ok: true };
    },
  },
{
    // The poll loop is a closure over a live Chrome child, so the two rules that
    // decide WHICH tab a handoff is allowed to believe in are pinned at the
    // source. Both exist for the same failure: only ONE Chrome instance answers
    // an Apple event addressed to "Google Chrome", so the inventory a handoff
    // reads is not necessarily the inventory its own window is in.
    name: 'Native Indeed challenge poll only widens its tab search on evidence of its own window',
    run: () => {
      const authSrc = fs.readFileSync(path.join('electron', 'ipc', 'browser', 'authWindows.js'), 'utf8');
      assert(authSrc.includes('selectNativeIndeedChallengeTab(tabs, url, { trackedTabIdentity, sawTargetHostTab })'),
        'the poll must pass its own observation of the requested host into the selection, not let it default');
      // Ordering is load-bearing: the poll that is the FIRST to see the
      // requested host must already be allowed to use the widened pool.
      const selectAt = authSrc.indexOf('selectNativeIndeedChallengeTab(tabs, url, {');
      const armAt = authSrc.indexOf('if (!sawTargetHostTab) {');
      assert(armAt > 0 && selectAt > armAt,
        'sawTargetHostTab must be armed from the fresh inventory BEFORE that inventory is selected from');
      // The latch is what the relaxed selection rides on afterwards, so it needs
      // a positive tie to this handoff too. Latching on any tab that happened to
      // be selected after the settle delay would promote a foreign indeed.com
      // tab into "this handoff's window" for the rest of the run.
      assert(/if \(!trackedTabIdentity && tabIdentity && \(classification === 'pending' \|\| atRequestedLocation\)/.test(authSrc),
        "the tracked-tab latch must require a challenge classification or the requested host+path, not merely the settle delay");
      assert(!/if \(!trackedTabIdentity && tabIdentity && Date\.now\(\) - startedAt >= NATIVE_CHALLENGE_SETTLE_MS\)/.test(authSrc),
        'the settle-delay-only latch admitted an arbitrary Indeed tab and must not come back');
      // Dedupe by the value actually STORED. Comparing a raw execFile message
      // against a stored/bounded copy never matched, so a permanently denied
      // Apple event re-logged ~500 chars of AppleScript on every poll.
      assert(authSrc.includes('if (pollError && !loggedPollErrors.has(pollError)'),
        'the tab-inventory failure log must dedupe against the normalized message it stores');
      assert(!authSrc.includes('pollError !== firstPollErrorMessage'),
        'the raw-vs-sliced comparison that re-logged on every poll must not come back');
      return { ok: true };
    },
  },
{
    // execFile's rejection reads `Command failed: /usr/bin/osascript -e <the
    // whole ~500-char AppleScript>` with the real stderr appended. Stored raw
    // and cut to 200 chars, what survived was the script the reader already has
    // — and the reason, the only part that identifies the failure, was dropped.
    name: 'osascript tab-inventory failures keep the reason, mark the cut, and dedupe',
    run: () => {
      const script = '\ntell application "Google Chrome"\n  set output to ""\n  return output\nend tell';
      const denial = 'execution error: Not authorized to send Apple events to Google Chrome. (-1743)';
      const raw = `Command failed: /usr/bin/osascript -e ${script}\n${denial}\n`;
      const normalized = normalizeNativeTabQueryError(raw, { echoedScript: script });
      assert(normalized === denial,
        `the echoed script is dropped and the osascript reason survives → ${JSON.stringify(normalized)}`);
      assert(!normalized.includes('tell application') && !normalized.includes('Command failed'),
        'neither the command echo nor the AppleScript source may reach the stored message');
      // Idempotence is what makes the poll-loop dedupe work at all: the message
      // compared on poll N+1 must equal the one stored on poll N byte for byte.
      assert(normalizeNativeTabQueryError(normalized, { echoedScript: script }) === normalized,
        'normalizing an already-normalized message returns it unchanged');
      // Any remaining cut is marked. An unmarked slice reads as a whole reason,
      // and a reader cannot tell a short message from the head of a long one.
      const long = normalizeNativeTabQueryError(`Command failed: /usr/bin/osascript -e ${script}\n${'x'.repeat(900)}`, { echoedScript: script });
      assert(long.length <= 200 && long.endsWith('… (truncated)'),
        `an over-long reason is bounded and explicitly marked as truncated → ${JSON.stringify(long.slice(-30))}`);
      assert(normalizeNativeTabQueryError(long, { echoedScript: script }) === long,
        'a truncated message is stable under a second normalization, so the dedupe still matches');
      // Without the script to strip by identity, the fixed preamble still goes.
      assert(normalizeNativeTabQueryError('Command failed: /usr/bin/osascript -e foo\nreal reason') === 'foo real reason',
        'the osascript preamble is stripped even when the caller passed no script to match');
      // Errors that never carried the preamble are left intact.
      assert(normalizeNativeTabQueryError('stdout maxBuffer length exceeded') === 'stdout maxBuffer length exceeded',
        'a non-execFile-shaped message is passed through unchanged');
      // Nothing left is reported as nothing, not as an empty string that would
      // render as a blank reason — the caller substitutes the lifecycle facts.
      assert(normalizeNativeTabQueryError(`Command failed: /usr/bin/osascript -e ${script}\n`, { echoedScript: script }) === null,
        'an error whose entire text was the echoed script yields null rather than an empty reason');
      assert(normalizeNativeTabQueryError('') === null && normalizeNativeTabQueryError(null) === null,
        'an absent message yields null');
      // The producer must hand the poll a message that is already normalized —
      // otherwise the stored value and the dedupe key diverge again.
      const authSrc = fs.readFileSync(path.join('electron', 'ipc', 'browser', 'authWindows.js'), 'utf8');
      assert(authSrc.includes("normalizeNativeTabQueryError(error?.message ?? String(error), { echoedScript: script })"),
        'getNativeChromeTabs must normalize with the exact script it executed, so the echo is removed by identity');
      return { ok: true };
    },
  },
{
    // A handoff that ends 'closed' is only actionable if the report can say
    // whether the observer saw ANYTHING. Both of these live on the durable
    // record because the live diagnostic is cleared at settle.
    name: 'buildAuthAttemptRecord: native challenge retains what the observer could see',
    run: () => {
      const watched = buildAuthAttemptRecord({
        platformId: 'indeed-native-challenge', result: 'closed', mode: 'native-chrome',
        nativeChallenge: {
          initialChallengeObserved: true, pollCount: 40, pollErrorCount: 0,
          sawFirstPartyTab: true, firstPollError: null, lastClassification: 'pending',
        },
      });
      assert(watched.nativeChallenge?.sawFirstPartyTab === true && watched.nativeChallenge?.firstPollError === null,
        'an observer that watched a real challenge page reports it saw a first-party tab');
      const blind = buildAuthAttemptRecord({
        platformId: 'indeed-native-challenge', result: 'closed', mode: 'native-chrome',
        nativeChallenge: {
          pollCount: 40, pollErrorCount: 40, sawFirstPartyTab: false,
          firstPollError: 'execution error: Not authorized to send Apple events to Google Chrome. (-1743)',
          lastClassification: 'unknown',
        },
      });
      assert(blind.nativeChallenge?.sawFirstPartyTab === false
        && blind.nativeChallenge?.firstPollError?.includes('-1743'),
      'a denied Apple event is distinguishable from a watched challenge instead of collapsing to last=unknown');
      // Same allowlist discipline as every neighbouring field: bounded, single
      // line, and never a guessed boolean.
      const messy = buildAuthAttemptRecord({
        platformId: 'indeed-native-challenge', result: 'closed', mode: 'native-chrome',
        nativeChallenge: { sawFirstPartyTab: 'yes', firstPollError: `line1\nline2\t${'z'.repeat(400)}` },
      });
      assert(messy.nativeChallenge?.sawFirstPartyTab === null,
        'a non-boolean sawFirstPartyTab is reported as unknown rather than coerced into a claim');
      assert(messy.nativeChallenge?.firstPollError.length <= 200
        && !/[\r\n\t]/.test(messy.nativeChallenge.firstPollError),
      'firstPollError is single-line and length-capped so it cannot break the report table');
      const absent = buildAuthAttemptRecord({
        platformId: 'indeed-native-challenge', result: 'closed', mode: 'native-chrome',
        nativeChallenge: { pollCount: 3 },
      });
      assert(absent.nativeChallenge?.sawFirstPartyTab === null && absent.nativeChallenge?.firstPollError === null,
        'a producer that stamped neither field reports null for both');
      // The producer side: the poll must stamp them through the same update that
      // writes the rest of the evidence, or the durable record never sees them.
      const authSrc = fs.readFileSync(path.join('electron', 'ipc', 'browser', 'authWindows.js'), 'utf8');
      assert(/sawFirstPartyTab,\n\s+firstPollError: firstPollErrorMessage,\n\s+\}\);/.test(authSrc),
        'the poll loop must stamp sawFirstPartyTab and firstPollError onto the native-challenge record');
      return { ok: true };
    },
  },
{
    name: 'Indeed session reset is origin-scoped and cannot clear another platform’s cookies',
    run: () => {
      const origins = getIndeedSessionResetOrigins();
      const hosts = origins.map(origin => new URL(origin).hostname).sort();
      assert(new Set(origins).size === origins.length, `reset origins must be deduped (got ${origins.join(', ')})`);
      assert(hosts.includes('www.indeed.com') && hosts.includes('ca.indeed.com') && hosts.includes('secure.indeed.com'),
        `reset must cover public, Canadian, and auth Indeed origins (got ${hosts.join(', ')})`);
      assert(hosts.every(host => host === 'indeed.com' || host.endsWith('.indeed.com')),
        `reset origins must stay within Indeed's registrable domain (got ${hosts.join(', ')})`);

      for (const domain of ['indeed.com', '.indeed.com', 'ca.indeed.com', '.ca.indeed.com', 'secure.indeed.com']) {
        assert(isIndeedCookieDomain(domain) === true, `Indeed cookie domain accepted → ${domain}`);
      }
      for (const domain of ['', '.google.com', 'google.com', 'evilindeed.com', 'indeed.com.evil', '.indeed.com.evil']) {
        assert(isIndeedCookieDomain(domain) === false, `non-Indeed/lookalike cookie domain rejected → ${domain || '(empty)'}`);
      }
      return { origins: origins.length };
    },
  },
{
    name: 'Indeed session preflight separates authenticated state, a Cloudflare wall, and an anonymous public landing',
    run: () => {
      const authenticated = classifyIndeedSessionPreflight({
        hasPPID: true,
        landedUrl: 'https://ca.indeed.com/',
        challengeReason: null,
      });
      assert(authenticated.status === 'authenticated',
        `PPID is affirmative session proof (got ${JSON.stringify(authenticated)})`);

      // Native Chrome can persist a real account session in state that a later
      // CDP cookie read does not expose. A clean authenticated account URL is
      // therefore an alternate proof, but a public /jobs/home page is not.
      const authenticatedSettings = classifyIndeedSessionPreflight({
        hasPPID: false,
        authenticatedUrl: true,
        landedUrl: 'https://secure.indeed.com/settings/account',
        challengeReason: null,
      });
      assert(authenticatedSettings.status === 'authenticated' && authenticatedSettings.proof === 'authenticated-url',
        `clean account-settings access proves the native session when PPID is not CDP-visible (got ${JSON.stringify(authenticatedSettings)})`);

      const challenge = classifyIndeedSessionPreflight({
        hasPPID: false,
        landedUrl: 'https://ca.indeed.com/?__cf_chl_rt_tk=token',
        challengeReason: 'cf-verify-text',
      });
      assert(challenge.status === 'challenge',
        `a no-PPID Cloudflare landing must be challenge, not authenticated (got ${JSON.stringify(challenge)})`);

      const challengedSettings = classifyIndeedSessionPreflight({
        hasPPID: false,
        authenticatedUrl: true,
        landedUrl: 'https://secure.indeed.com/settings/account?__cf_chl_rt_tk=token',
        challengeReason: 'cf-verify-text',
      });
      assert(challengedSettings.status === 'challenge',
        `a challenge must override an otherwise-authenticated-looking URL (got ${JSON.stringify(challengedSettings)})`);

      const publicLanding = classifyIndeedSessionPreflight({
        hasPPID: false,
        landedUrl: 'https://ca.indeed.com/',
        challengeReason: null,
      });
      assert(publicLanding.status === 'needs-login',
        `a public no-PPID landing must not be accepted as logged in (got ${JSON.stringify(publicLanding)})`);

      assert(shouldHandoffIndeedChallengeToNative('cf-verify-text') === true,
        'the report’s text-only Cloudflare wall chooses native Chrome handoff, never a controlled-browser wait/restart');
      assert(shouldHandoffIndeedChallengeToNative('cloudflare-challenge-frame', { interactive: true }) === true,
        'an embedded Cloudflare widget likewise chooses native Chrome instead of CDP interaction');
      assert(shouldHandoffIndeedChallengeToNative('indeed-login-wall') === false
        && shouldHandoffIndeedChallengeToNative('') === false,
      'login walls and unknown states do not create a native-challenge handoff');
      return { ok: true };
    },
  },
{
    // BUG 1 regression: the preflight navigates to the auth-gated
    // secure.indeed.com/settings/account on purpose, so a logged-out user's
    // redirect to Indeed's OWN sign-in page (getChallengeSignals'
    // "indeed-login-wall") is the ORDINARY logged-out signal, not a bot wall.
    // Before the fix, classifyIndeedSessionPreflight checked challengeReason
    // first with no carve-out, so this case returned "challenge" and the
    // needs-login branch (indeedBrowser.js ~631-643) was unreachable — the user
    // got told to "wait before retrying" with no way to actually log in.
    name: 'classifyIndeedSessionPreflight: a login-wall redirect is needs-login, never a bot challenge',
    run: () => {
      const loginWall = classifyIndeedSessionPreflight({
        hasPPID: false,
        landedUrl: 'https://secure.indeed.com/auth?continue=https%3A%2F%2Fsecure.indeed.com%2Fsettings%2Faccount',
        challengeReason: 'indeed-login-wall',
      });
      assert(loginWall.status === 'needs-login' && loginWall.reason === 'redirected-to-sign-in',
        `a login-wall redirect must classify as needs-login/redirected-to-sign-in, not challenge (got ${JSON.stringify(loginWall)})`);

      // A REAL Cloudflare wall must still win — every reason the wider codebase
      // treats as an actual bot challenge (see shouldHandoffIndeedChallengeToNative
      // and getChallengeSignals) must classify as "challenge", never be swallowed
      // by the login-wall carve-out.
      for (const reason of ['cf-verify-text', 'challenge-shell', 'cloudflare-challenge-frame', 'cloudflare-challenge-url']) {
        const challenged = classifyIndeedSessionPreflight({
          hasPPID: false,
          landedUrl: 'https://secure.indeed.com/settings/account',
          challengeReason: reason,
        });
        assert(challenged.status === 'challenge' && challenged.reason === reason,
          `a real Cloudflare reason (${reason}) must still classify as challenge (got ${JSON.stringify(challenged)})`);
      }

      // hasPPID / authenticatedUrl win over a login-wall reason (the login-wall
      // check runs only after the affirmative-proof check) …
      const ppidOverLoginWall = classifyIndeedSessionPreflight({
        hasPPID: true,
        landedUrl: 'https://secure.indeed.com/auth?continue=...',
        challengeReason: 'indeed-login-wall',
      });
      assert(ppidOverLoginWall.status === 'authenticated' && ppidOverLoginWall.proof === 'PPID',
        `a PPID cookie must win over a login-wall reason (got ${JSON.stringify(ppidOverLoginWall)})`);
      const authUrlOverLoginWall = classifyIndeedSessionPreflight({
        hasPPID: false,
        authenticatedUrl: true,
        landedUrl: 'https://secure.indeed.com/auth?continue=...',
        challengeReason: 'indeed-login-wall',
      });
      assert(authUrlOverLoginWall.status === 'authenticated' && authUrlOverLoginWall.proof === 'authenticated-url',
        `an authenticated-looking URL must win over a login-wall reason (got ${JSON.stringify(authUrlOverLoginWall)})`);

      // … but NOT over a real challenge: the challenge check runs FIRST, so a
      // real Cloudflare wall must override even a present PPID/authenticatedUrl
      // (a stale cookie proves nothing about the page actually served).
      const challengeOverPPID = classifyIndeedSessionPreflight({
        hasPPID: true,
        authenticatedUrl: true,
        landedUrl: 'https://secure.indeed.com/settings/account',
        challengeReason: 'cf-verify-text',
      });
      assert(challengeOverPPID.status === 'challenge' && challengeOverPPID.reason === 'cf-verify-text',
        `a real challenge must override hasPPID/authenticatedUrl (got ${JSON.stringify(challengeOverPPID)})`);

      // A navigation that never landed anywhere (about:blank) says nothing about
      // the session either way — must stay "unreachable", not be asserted as
      // needs-login/challenge.
      assert(classifyIndeedSessionPreflight({ landedUrl: 'about:blank' }).status === 'unreachable',
        'about:blank (navigation never completed) must classify as unreachable');
      assert(classifyIndeedSessionPreflight({ landedUrl: '' }).status === 'unreachable',
        'an empty landedUrl must classify as unreachable');
      return { ok: true };
    },
  },
{
    // BUG 3: Puppeteer's default launch args force the Chromium MOCK keychain
    // (a fixed, static OSCrypt key) on every Puppeteer-launched Chrome. The raw
    // child_process.spawn native login/challenge windows must carry the exact
    // same flags or they use the REAL macOS Keychain key instead — two
    // encryption domains on one shared cookie DB, so cookies written by one
    // Chrome are silently unreadable by the other (this is what actually lost
    // the Indeed session: the native login wrote real-Keychain-encrypted rows
    // the Puppeteer scrape browser's mock-keychain profile could never decrypt).
    name: 'PUPPETEER_OSCRYPT_PARITY_ARGS matches puppeteer-core\'s own OSCrypt-relevant default args',
    run: () => {
      assert(Array.isArray(PUPPETEER_OSCRYPT_PARITY_ARGS)
        && PUPPETEER_OSCRYPT_PARITY_ARGS.includes('--password-store=basic')
        && PUPPETEER_OSCRYPT_PARITY_ARGS.includes('--use-mock-keychain'),
      `PUPPETEER_OSCRYPT_PARITY_ARGS must carry both OSCrypt flags → ${JSON.stringify(PUPPETEER_OSCRYPT_PARITY_ARGS)}`);

      // Derive the truth from puppeteer-core itself rather than hardcoding it
      // twice: every Puppeteer launch here only filters "--enable-automation"
      // out of defaultArgs() (ignoreDefaultArgs: ["--enable-automation"]), so
      // "--password-store=basic" and "--use-mock-keychain" always survive into
      // the real scrape/login Chrome. If puppeteer-core ever drops or renames
      // either flag, the raw-spawned native windows (authWindows.js
      // openNativeLoginWindow / openNativeIndeedChallengeWindow) would silently
      // fall out of parity with the Puppeteer-launched browser sharing the same
      // profile — this must fail loud instead of that going unnoticed.
      const launcherPath = path.join('node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'node', 'ChromeLauncher.js');
      const launcherSrc = fs.readFileSync(launcherPath, 'utf8');
      assert(launcherSrc.includes('--password-store=basic'),
        'puppeteer-core ChromeLauncher.js must still inject --password-store=basic into its default launch args');
      assert(launcherSrc.includes('--use-mock-keychain'),
        'puppeteer-core ChromeLauncher.js must still inject --use-mock-keychain into its default launch args');
      return { ok: true };
    },
  },
{
    // BUG 3 wiring: the on-disk survival check (accounts.js
    // annotateCookieSurvival) and the scrape preflight both key off this exact
    // cookie name for Indeed — pin the shape so a future edit can't silently
    // widen or narrow it (e.g. adding a second candidate cookie would change
    // cookieListHasAuth's match semantics for every caller).
    name: 'PLATFORM_AUTH_COOKIES.indeed is exactly ["PPID"]',
    run: () => {
      assert(JSON.stringify(PLATFORM_AUTH_COOKIES.indeed) === JSON.stringify(['PPID']),
        `PLATFORM_AUTH_COOKIES.indeed must be exactly ["PPID"] → ${JSON.stringify(PLATFORM_AUTH_COOKIES.indeed)}`);
      // The cookie lookup reads back through page.cookies(url), which returns
      // only cookies that APPLY to each url — a host-only cookie on
      // secure.indeed.com is invisible to an apex-only query. Since an
      // "absent" answer now REVOKES a confirmed native login, an incomplete
      // host list would tell a user who just signed in that their login did
      // not persist. Pin the same host set the Indeed scrape preflight queries.
      const indeedDomains = PLATFORM_COOKIE_DOMAINS.indeed || [];
      for (const host of ['.indeed.com', 'www.indeed.com', 'secure.indeed.com']) {
        assert(indeedDomains.includes(host),
          `PLATFORM_COOKIE_DOMAINS.indeed must cover ${host} → ${JSON.stringify(indeedDomains)}`);
      }
      return { ok: true };
    },
  },
{
    // Swappa added Cloudflare Turnstile to its login page; under Puppeteer/CDP the
    // challenge's `interactiveEnd` postMessage is rejected as an "unexpected source"
    // → no clearance token → the widget re-spawns forever. The fix is to run the
    // login in a real, non-CDP Chrome (NATIVE_LOGIN_PLATFORMS) — the same path
    // built for Google-SSO/Indeed. This guards the wiring + the generalized
    // (previously indeed-only) native success detection.
    name: 'Swappa login routes through native (non-CDP) Chrome with /my/swappa success marker',
    run: () => {
      assert(NATIVE_LOGIN_PLATFORMS.has('swappa'), 'swappa must be a native (non-CDP) login platform to pass Turnstile');
      assert(NATIVE_LOGIN_PLATFORMS.has('indeed'), 'indeed native login must remain (regression guard)');
      // Login URL carries an (encoded) ?next=/my/swappa so a completed login lands
      // on a precise marker; the post-login URL is decoded so the marker still matches.
      assert(/swappa\.com\/login\?next=(%2F|\/)my(%2F|\/)swappa/i.test(PLATFORM_LOGIN_URLS.swappa), `swappa login URL → ${PLATFORM_LOGIN_URLS.swappa}`);
      // Success detection (generalized from indeed-only):
      assert(isNativeLoginSuccess('swappa', 'https://swappa.com/my/swappa', 'My Swappa - Swappa') === true, 'landed on /my/swappa → logged in');
      assert(isNativeLoginSuccess('swappa', 'https://swappa.com/login?next=/my/swappa', 'Sign In') === false, 'still on the login page → not yet');
      assert(isNativeLoginSuccess('swappa', 'https://swappa.com/login', 'Just a moment...') === false, 'Cloudflare interstitial title → not a success');
      assert(isNativeLoginSuccess('swappa', 'https://swappa.com/', 'Swappa') === false, 'homepage is not the success marker');
      // Indeed's public /jobs search is deliberately NOT an authenticated
      // success marker. An anonymous page can reach it, and accepting it made a
      // Cloudflare/interstitial login flow look connected before any account
      // signal existed. The settings account page is the only native URL proof.
      assert(isNativeLoginSuccess('indeed', 'https://www.indeed.com/jobs?q=x', 'Jobs') === false,
        'public Indeed /jobs is not proof of a completed login');
      assert(isNativeLoginSuccess('indeed', 'https://secure.indeed.com/settings/account', 'Account settings | Indeed') === true,
        'Indeed authenticated settings page is a native-login success marker');
      assert(isNativeLoginSuccess('indeed', 'https://secure.indeed.com/settings/account?__cf_chl_rt_tk=token', 'Just a moment...') === false,
        'Cloudflare URL/title at an otherwise authenticated-looking path is never a login success');
      return { ok: true };
    },
  },
{
    // Mercari delegates sign-in to Google SSO. Under Puppeteer/CDP, Google bounces
    // the OAuth flow back to mercari.com/login → the reported "keeps redirecting
    // google login back to mercari login page" loop. Fix: route Mercari login
    // through the same native (non-CDP) Chrome path as indeed/swappa. The login URL
    // is the auth-gated /mypage hub so a completed login returns to the precise
    // mercari.com/mypage marker; the /account/googleauth OAuth callback must NOT
    // false-succeed mid-redirect.
    name: 'Mercari login routes through native (non-CDP) Chrome with /mypage success marker',
    run: () => {
      assert(NATIVE_LOGIN_PLATFORMS.has('mercari'), 'mercari must be a native (non-CDP) login platform (Google SSO loops under CDP)');
      assert(NATIVE_LOGIN_PLATFORMS.has('swappa') && NATIVE_LOGIN_PLATFORMS.has('indeed'), 'swappa + indeed native login must remain (regression guard)');
      // Login URL must be Mercari's DEDICATED /login/ page (the auth-gated hub renders
      // a blank grey screen in the raw --app window — "mercari log in is grey screen"),
      // AND must carry a login_callback back to /mypage so the post-login landing still
      // hits the mercari.com/mypage success marker. Guards both regressions at once.
      assert(/mercari\.com\/login\b/i.test(PLATFORM_LOGIN_URLS.mercari), `mercari login URL must be the dedicated /login page (not the grey-screen hub) → ${PLATFORM_LOGIN_URLS.mercari}`);
      assert(/login_callback=.*mypage/i.test(PLATFORM_LOGIN_URLS.mercari), `mercari login URL must carry a login_callback returning to /mypage → ${PLATFORM_LOGIN_URLS.mercari}`);
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/mypage/listings/', 'My Listings - Mercari') === true, 'landed on /mypage → logged in');
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/login/', 'Log in to Mercari') === false, 'still on the login page → not yet');
      // Logged-out inline login form served AT the /mypage success URL (HTTP 200,
      // NO redirect; SSR shell carries the generic marketing title): the URL marker
      // matches but the title gate must reject it, else the window auto-closes
      // before the user can sign in ("keeps refreshing / can't verify human").
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/mypage/listings/active/', 'Your Go-to Marketplace for Deals on Used & Secondhand Items | Mercari') === false, 'logged-out inline form at /mypage → not a success');
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/us/selling/dashboard/', 'Your Go-to Marketplace for Deals on Used & Secondhand Items | Mercari') === false, 'logged-out inline form at selling dashboard → not a success');
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/mypage/listings/', 'Log in | Mercari') === false, 'pipe-separated mercari login title at /mypage → not a success');
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/mypage/listings/', 'Sign in | Mercari') === false, 'pipe-separated mercari sign-in title at /mypage → not a success');
      // The Google-OAuth callback step must not be mistaken for success.
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/account/googleauth?code=abc', 'Mercari') === false, 'OAuth callback is not the success marker');
      assert(isNativeLoginSuccess('mercari', 'https://accounts.google.com/o/oauth2/v2/auth?...', 'Sign in - Google Accounts') === false, 'on Google sign-in → not yet');
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/', 'Mercari') === false, 'homepage is not the success marker');
      // Empty/loading <title> at the marker URL must NOT auto-succeed — the
      // title-render race that false-closed the window mid-login (session cached
      // connected:true while the user was still on the login page). Inline-login
      // platforms require a settled, non-empty title.
      assert(isInlineLoginPlatform('mercari') === true, 'mercari serves login inline at its success URL');
      assert(isInlineLoginPlatform('swappa') === false && isInlineLoginPlatform('indeed') === false, 'swappa/indeed login URLs are distinct from the success marker');
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/mypage/listings/', '') === false, 'mercari /mypage with EMPTY (loading) title → not a success (title-render race)');
      assert(isNativeLoginSuccess('mercari', 'https://www.mercari.com/mypage/listings/', 'Just a moment...') === false, 'mercari /mypage showing a CF interstitial title → not a success');
      // swappa is NOT inline-login, so an empty title at its success marker still
      // succeeds (its login lives at a distinct /login URL — no ambiguity).
      assert(isNativeLoginSuccess('swappa', 'https://swappa.com/my/swappa', '') === true, 'swappa /my/swappa with empty title still succeeds (distinct login URL, no inline ambiguity)');
      assert(isNativeLoginSuccess('swappa', 'https://swappa.com/my/swappa', 'Sign in | Swappa') === false, 'swappa hub showing a pipe-separated login title → not yet');
      assert(isNativeLoginSuccess('swappa', 'https://swappa.com/my/swappa', 'Just a moment...') === false, 'swappa hub showing a CF challenge title → not yet (wait for the challenge to clear)');
      return { ok: true };
    },
  },
{
    name: 'captcha resolve host equivalence: Glassdoor regional redirect remains in the first-party solve flow',
    run: () => {
      assert(areCaptchaResolveHostsEquivalent('www.glassdoor.com', 'www.glassdoor.ca'),
        'Glassdoor .com → .ca authenticated redirect must keep the resolve probe alive');
      assert(areCaptchaResolveHostsEquivalent('glassdoor.co.uk', 'www.glassdoor.com.au'),
        'allowlisted Glassdoor regional domains are mutually first-party-equivalent');
      assert(areCaptchaResolveHostsEquivalent('www.glassdoor.com', 'fr.glassdoor.ca'),
        'Glassdoor locale subdomains remain in the first-party resolve flow');
      assert(areCaptchaResolveHostsEquivalent('www.glassdoor.com', 'www.glassdoor.com'),
        'the normal same-host resolve path remains equivalent');
      assert(!areCaptchaResolveHostsEquivalent('www.glassdoor.com', 'glassdoor.example'),
        'lookalike domains must not be accepted into the auto-extract flow');
      assert(!areCaptchaResolveHostsEquivalent('www.glassdoor.com', 'evilglassdoor.ca'),
        'a suffix lookalike without a dot boundary must be rejected');
      assert(!areCaptchaResolveHostsEquivalent('www.glassdoor.com', 'glassdoor.ca.evil'),
        'an allowlisted host embedded inside an attacker domain must be rejected');
      assert(!areCaptchaResolveHostsEquivalent('www.glassdoor.com', 'www.linkedin.com'),
        'an unrelated destination remains a hard stop');
      assert(!areCaptchaResolveHostsEquivalent('', 'www.glassdoor.ca'),
        'missing origin never grants cross-host equivalence');
      const mismatch = captchaResolveHostMismatchDiagnostic(
        'www.glassdoor.com', 'https://www.linkedin.com/feed', 'LinkedIn Feed',
      );
      assert(mismatch.allowed === false && mismatch.hostMismatch === true && mismatch.probeSkippedReason === 'host-mismatch',
        `unrelated host remains rejected with an explicit reportable reason (${JSON.stringify(mismatch)})`);
      assert(mismatch.currentHost === 'www.linkedin.com' && mismatch.finalTitle === 'LinkedIn Feed',
        'host mismatch diagnostics retain the landing URL/host/title without evaluating the page body');
      return { ok: true };
    },
  },
{
    name: 'captcha resolve window recognizes Cloudflare Turnstile and challenge iframe variants',
    run: () => {
      const selectors = CAPTCHA_RESOLVE_CHALLENGE_SELECTORS.map(entry => entry.selector).join(' ');
      assert(selectors.includes('.cf-turnstile')
        && selectors.includes('cf-chl-widget')
        && selectors.includes('challenges.cloudflare.com')
        && selectors.includes('#cf-challenge-running'),
      'the explicit Solve window must not auto-close while any supported Cloudflare widget is visible');
      return { selectors: CAPTCHA_RESOLVE_CHALLENGE_SELECTORS.length };
  },
},
{
    name: 'captcha resolve no-extractor pages require an observed challenge before auto-close',
    run: () => {
      const cleanPage = { noChallenge: true, consentVisible: false, textLength: 2000 };
      assert(shouldAutoCloseCaptchaResolveWithoutExtractor(cleanPage) === false,
        'a normal page opened by Solve must remain user-controlled when this window never observed a challenge');
      assert(shouldAutoCloseCaptchaResolveWithoutExtractor({ ...cleanPage, sawChallenge: true }) === true,
        'after a visible challenge disappears, a substantial recovered page may auto-close and resume');
      assert(shouldAutoCloseCaptchaResolveWithoutExtractor({ ...cleanPage, sawChallenge: true, consentVisible: true }) === false,
        'a consent overlay must keep even a previously challenged page open');
      assert(shouldAutoCloseCaptchaResolveWithoutExtractor({ ...cleanPage, sawChallenge: true, textLength: 20 }) === false,
        'a tiny redirect/loading body is not enough evidence of a recovered no-extractor page');
      return { requiresObservedChallenge: true };
    },
  },
{
    name: 'Glassdoor startup verifier rejects the anonymous public jobs landing page',
    run: () => {
      const cfg = getJobLoginConfig('glassdoor');
      const anonymous = 'Recommended Jobs For You | Glassdoor Job Search Skip to main content Search Notifications Loading... Sign In Upload your resume - let employers find you Your job';
      const anonymousCanadianShell = 'Recommended Jobs For You | Glassdoor Job Search Skip to main content Search Notifications Loading... Sign in Find your perfect job Search Upload your CV - let employers find you';
      const loggedIn = 'Recommended Jobs For You | Glassdoor Job Search Search Notifications Saved Jobs Profile Recommended for you';
      assert(getSoftLoginWallMatch(anonymous, cfg) === 'sign in upload your resume - let employers find you',
        'Glassdoor anonymous /Job/index.htm body must not fall through to connected:true');
      assert(getSoftLoginWallMatch(anonymousCanadianShell, cfg) === 'upload your cv - let employers find you',
        'Glassdoor’s regional anonymous shell may separate Sign in from the CV CTA, but must still reject the false connected verdict');
      assert(getSoftLoginWallMatch(loggedIn, cfg) === null,
        'Glassdoor logged-in jobs body must not false-positive as a login wall');
      return { ok: true };
    },
  },
{
    // isLoginUrlPath is the SINGLE shared login-URL predicate (authWindows.js),
    // replacing 5 drifted near-copies across the login window, HTTP verify, native
    // read, and hub-scan auth-wall. Guard the union coverage + the /author non-match
    // (accounts.js once used bare `auth`, which wrongly matched /author).
    name: 'isLoginUrlPath: unified login-URL detection, no /author false-match',
    run: () => {
      for (const u of [
        'https://www.mercari.com/login/?login_callback=%2Fmypage',
        'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn',
        'https://reverb.com/signin?redirect_to=%2Fmy',
        'https://www.depop.com/login/?redirect=%2Fproducts',
        'https://example.com/account/login',
        'https://example.com/log-in',
        'https://example.com/authenticate?next=/x',
        'https://example.com/auth/start',
      ]) assert(isLoginUrlPath(u) === true, `login URL detected → ${u}`);
      // Must NOT match: /author (the bare-`auth` bug), and non-login hub pages.
      assert(isLoginUrlPath('https://example.com/author/jane') === false, '/author is NOT a login URL (auth(?!or) guard)');
      assert(isLoginUrlPath('https://www.mercari.com/mypage/listings/active/') === false, 'a real seller hub is not a login URL');
      assert(isLoginUrlPath('https://www.ebay.com/mys/active') === false, 'eBay seller hub is not a login URL');
      assert(isLoginUrlPath('') === false && isLoginUrlPath(null) === false && isLoginUrlPath(undefined) === false, 'empty/null/undefined → false (null-safe)');
      return { ok: true };
    },
  },
{
    // A login-verify FAILURE captured the page text per-check but never rendered
    // it (top-level bodyHead is connected-path only), so a soft-wall "logged out"
    // verdict showed no way to see WHAT the page said — was it a real sign-in
    // shell, or a logged-in SPA that hadn't client-rendered its account UI yet?
    // The bug-report trace must now surface the per-check bodyHead on failures.
    name: 'session trace surfaces captured bodyHead on a verify FAILURE (not just connected)',
    run: () => {
      const platforms = [{ id: 'aptdeco', name: 'AptDeco' }];
      // Soft-wall failure: no top-level bodyHead (matches verifySellMonitorLogin's
      // failure return shape `{ target, checks }`), bodyHead lives on the check.
      const failCache = {
        aptdeco: { lastTrace: { target: 'https://www.aptdeco.com/sell/new', checks: [{
          target: 'https://www.aptdeco.com/sell/new', status: 200, finalUrl: 'https://www.aptdeco.com/sell/new',
          softWallMatch: 'already have an account? sign in',
          bodyHead: "Let's start listing your furniture. First time selling? Already have an account? Sign in",
        }] } },
      };
      const failOut = renderSessionTraceBlocks(platforms, failCache);
      assert(/bodyHead:/.test(failOut), `failure trace must render the captured bodyHead -> ${failOut}`);
      assert(/start listing your furniture/.test(failOut), 'the actual captured page text must appear so logged-out-shell vs logged-in-SPA is distinguishable');

      // Connected path already has a top-level bodyHead — don't duplicate it per check.
      const okCache = {
        aptdeco: { lastTrace: {
          target: 'https://www.aptdeco.com/sell/new', finalUrl: 'https://www.aptdeco.com/sell/new', status: 200,
          bodyHead: 'Beds Chairs Sofas What are you selling',
          checks: [{ target: 'https://www.aptdeco.com/sell/new', status: 200, bodyHead: 'Beds Chairs Sofas What are you selling' }],
        } },
      };
      const okOut = renderSessionTraceBlocks(platforms, okCache);
      assert((okOut.match(/bodyHead:/g) || []).length === 1, `connected trace renders bodyHead once (no per-check dup) -> ${okOut}`);
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
    name: 'Reverb ACTIVE listings mapping (sold Price Guide API retired → live listings)',
    run: () => {
      // Reverb PERMANENTLY retired its public Price Guide (sold) API in mid-2026
      // — /api/priceguide now 403s "no longer publicly available" (verified live
      // 2026-07-09). The still-working /api/listings/all returns LIVE for-sale
      // inventory (asking prices), so Reverb is now an ACTIVE comp source and
      // reverbListingsToComps maps that API's listings[] into the comp shape.
      const listings = [
        { id: 94534350, title: 'Rode NT4 Stereo X/Y Condenser Microphone Mic', make: 'RODE', model: 'Rode NT4', condition: { display_name: 'Very Good' }, price: { amount: '455.00', display: '$455' }, _links: { web: { href: 'https://reverb.com/item/94534350-rode-nt4' } } },
        { id: 77235041, title: 'Rode NT4', make: 'RODE', model: 'Rode NT4', condition: { display_name: 'Brand New' }, price: { amount: '580.36', display: '$580.36' }, _links: { web: { href: 'https://reverb.com/item/77235041-rode-nt4' } } },
        { id: 77235041, title: 'Rode NT4 (dup id)', condition: { display_name: 'Brand New' }, price: { amount: '580.36', display: '$580.36' }, _links: { web: { href: 'https://reverb.com/item/77235041-rode-nt4' } } }, // dup id → deduped
        { id: 5, title: 'Broken freebie', condition: 'Poor', price: { amount: '0.00', display: '$0' }, _links: { web: { href: 'https://reverb.com/item/5' } } },                                        // zero price → dropped
        { id: 6, title: 'No price object' },                                                                                                                                                            // no price → dropped
      ];
      const comps = reverbListingsToComps(listings);
      assert(comps.length === 2, `expected 2 comps (dup id + zero-price + no-price dropped), got ${comps.length}`);
      assert(comps.every(c => c.source === 'reverb'), 'source should be reverb');
      assert(comps[0].price === 455 && comps[0].condition === 'Very Good', `wrong first comp → ${JSON.stringify(comps[0])}`);
      assert(comps[0].url === 'https://reverb.com/item/94534350-rode-nt4', `url should be the listing web href → ${comps[0].url}`);
      assert(!comps.some(c => 'soldDate' in c), 'active comps carry NO soldDate (they are asking prices, not completed sales)');
      // A string condition (some listings serve condition as a bare string) maps through too.
      const strCond = reverbListingsToComps([{ id: 9, title: 'X', condition: 'Mint', price: { amount: '10.00', display: '$10' }, _links: { web: { href: 'https://reverb.com/item/9' } } }]);
      assert(strCond[0].condition === 'Mint', `string condition should pass through → ${JSON.stringify(strCond[0])}`);
      // Falls back to make+model when a listing has no title.
      const noTitle = reverbListingsToComps([{ id: 10, make: 'RODE', model: 'NT5', price: { amount: '200.00', display: '$200' }, _links: { web: { href: 'https://reverb.com/item/10' } } }]);
      assert(noTitle[0].title === 'RODE NT5', `title should fall back to make+model → ${noTitle[0].title}`);
      return { ok: true, comps: comps.length, prices: comps.map(c => c.price) };
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
        'https://reverb.com/my/selling/listings?__cf_chl_rt_tk=abc123',
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
    // Regression: eBay's post-login "Trust this device?" page (accounts.ebay.com/
    // acctsec/trust-a-device) carries logged-in nav chrome, so the DOM heuristic
    // fired and force-closed the window before the user could click "Trust" —
    // leaving the device untrusted so eBay re-prompts 2FA every login (reported).
    // The poller must WAIT on this interstitial and only auto-close once eBay
    // redirects to its `ru=` destination.
    name: 'login auto-close: wait on post-login trust-a-device interstitial, close on its destination',
    run: () => {
      const trustUrl = 'https://accounts.ebay.com/acctsec/trust-a-device?id=CoTckUcxRxFAYQo5uzBcP&ru=http%3A%2F%2Fwww.ebay.com';
      assert(isPostLoginInterstitialUrl(trustUrl), 'eBay trust-a-device must be recognised as a post-login interstitial');
      // Punctuation variants a redesign could ship.
      for (const u of ['https://x/trust-this-device', 'https://x/trust_device', 'https://x/trusteddevice']) {
        assert(isPostLoginInterstitialUrl(u), `device-trust variant should be recognised: ${u}`);
      }
      // Must NOT swallow real logged-in landings — those still auto-close.
      for (const u of ['https://www.ebay.com/', 'https://www.ebay.com/mye/myebay/summary', 'https://www.ebay.com/sh/lst/active']) {
        assert(!isPostLoginInterstitialUrl(u), `logged-in destination must NOT be treated as an interstitial: ${u}`);
      }
      // It is distinct from a captcha/challenge — different wait reason, same effect (keep waiting).
      assert(!isAuthChallengeUrl(trustUrl), 'trust-a-device is not a captcha/challenge URL');
      assert(getLoginAutoCloseWaitReason({ platformId: 'ebay', currentUrl: trustUrl }) === 'post-login-interstitial',
        'poller must keep the window open on the eBay trust-a-device interstitial');
      // After the user clicks through, eBay lands on the real destination → auto-close allowed.
      assert(getLoginAutoCloseWaitReason({ platformId: 'ebay', currentUrl: 'https://www.ebay.com/' }) === null,
        'poller must allow auto-close once eBay redirects past the trust prompt');
      return { ok: true };
    },
  },
{
    // Non-CDP native-Chrome hub reader (Swappa/Mercari sit behind CDP-detecting
    // anti-bot that 403s/wedges every headless read). The osascript/spawn plumbing
    // can't be unit-tested, but the pure classification helpers — which decide what
    // the bug report shows and whether a read counts as ok — can and must be.
    name: 'nativeChromeReader: platform gate + read-result classification',
    run: () => {
      // Only the CDP-walled platforms route through native reads; the headless ones must NOT.
      // eBay was promoted (its hub reads get the /splashui/captcha anti-bot wall under
      // headless CDP even with valid cookies — see the "ebay still unknown" reports).
      assert(NATIVE_READ_PLATFORMS.has('swappa') && NATIVE_READ_PLATFORMS.has('mercari') && NATIVE_READ_PLATFORMS.has('ebay'), 'swappa+mercari+ebay are native-read platforms');
      for (const p of ['facebook', 'reverb', 'poshmark']) {
        assert(!NATIVE_READ_PLATFORMS.has(p), `${p} reads fine headless and must NOT be a native-read platform`);
      }
      // shouldUseNativeRead is darwin-gated; the test runner runs on darwin here.
      if (process.platform === 'darwin') {
        assert(shouldUseNativeRead('swappa') === true, 'swappa uses native read on macOS');
        assert(shouldUseNativeRead('ebay') === true, 'ebay uses native read on macOS (CDP /splashui wall)');
        assert(shouldUseNativeRead('facebook') === false, 'facebook still reads headless');
      } else {
        assert(shouldUseNativeRead('swappa') === false, 'native read is macOS-only');
        assert(shouldUseNativeRead('ebay') === false, 'native read is macOS-only');
      }

      // Startup-verify skip set (accounts.js verifyOne): platforms CDP-walled on BOTH
      // axes — native LOGIN (Google-SSO/Turnstile loop) AND native READ (403/wedge) —
      // skip the doomed CDP startup verify (the mercari 35s anti-bot wedge that made
      // startup the long pole); the native read owns their login state during Check All.
      // The predicate must resolve to EXACTLY {swappa, mercari} on macOS: eBay is
      // native-read only (its login verify works) and indeed is native-login only.
      if (process.platform === 'darwin') {
        const skipsStartupVerify = (id) => NATIVE_LOGIN_PLATFORMS.has(id) && shouldUseNativeRead(id);
        assert(skipsStartupVerify('mercari') === true && skipsStartupVerify('swappa') === true, 'mercari+swappa skip the CDP startup verify (native-login AND native-read)');
        assert(skipsStartupVerify('ebay') === false, 'ebay does NOT skip startup verify (native-read only; its login verify works, does not wedge)');
        assert(skipsStartupVerify('indeed') === false, 'indeed does NOT skip startup verify (native-login only; not native-read)');
        assert(skipsStartupVerify('facebook') === false, 'facebook does NOT skip startup verify (neither native-login nor native-read)');
      }

      // The one manual prerequisite — detect the Apple-Events toggle being off so
      // the bug report can name the exact fix instead of an opaque AppleScript error.
      assert(isAppleEventsJsDisabledError('Google Chrome got an error: Executing JavaScript through AppleScript is turned off.'), 'detects toggle-off error');
      assert(!isAppleEventsJsDisabledError('some unrelated osascript failure'), 'does not over-match unrelated errors');

      // Challenge sniff catches Cloudflare even when native Chrome rendered it.
      assert(nativeReadLooksChallenged('<title>Just a moment...</title>'), 'detects CF interstitial');
      assert(nativeReadLooksChallenged('<div id="cf-challenge">x</div>'), 'detects cf-challenge marker');
      assert(!nativeReadLooksChallenged('<html><body>My listings dashboard</body></html>'), 'a real dashboard is not a challenge');

      // Output parsing: finalUrl <SEP> html, and the no-window sentinel.
      const parsed = parseNativeReadOutput('https://swappa.com/account###NRSEP_8f3a2c###<html>hi</html>');
      assert(parsed.finalUrl === 'https://swappa.com/account' && parsed.html === '<html>hi</html>', 'splits finalUrl from html');
      const parsedWithTitle = parseNativeReadOutput('https://swappa.com/my/swappa###NRSEP_8f3a2c###Just a moment...###NRSEP_8f3a2c###NRERR:JS:Executing JavaScript through AppleScript is turned off.');
      assert(parsedWithTitle.finalUrl === 'https://swappa.com/my/swappa' && parsedWithTitle.title === 'Just a moment...' && /AppleScript/.test(parsedWithTitle.error), 'splits finalUrl + title + JavaScript error');
      assert(parseNativeReadOutput('NRERR:NOWINDOW').sentinel === 'NRERR:NOWINDOW', 'surfaces the no-window sentinel');

      // Result classification → the scanSellerHubPages fetcher contract.
      const good = nativeReadToFetchResult({ requestedUrl: 'https://swappa.com/account/listings', finalUrl: 'https://swappa.com/account/listings', html: '<html>'.padEnd(500, 'x') + '</html>' });
      assert(good.ok === true && good.status === 200, 'real content → ok:200');

      const bounced = nativeReadToFetchResult({ requestedUrl: 'https://www.mercari.com/mypage/listings/', finalUrl: 'https://www.mercari.com/login/?login_callback=%2Fmypage', html: '<html>login</html>' });
      assert(bounced.ok === false && /login page/i.test(bounced.error), 'login bounce → terminal error, not a false-ok');
      // The /login bounce must carry loginBounce:true so the read loop STOPS instead
      // of driving the remaining hub URLs (each re-bouncing) — the swappa thrash.
      assert(bounced.loginBounce === true, 'login bounce sets loginBounce:true so the read loop breaks (no thrash through the rest)');

      const challenged = nativeReadToFetchResult({ requestedUrl: 'https://swappa.com/my/swappa', finalUrl: 'https://swappa.com/my/swappa', html: 'Just a moment... checking your browser' });
      assert(challenged.ok === false && challenged.challenged === true && /challenge/i.test(challenged.error), 'native CF challenge → terminal error and stop flag');

      // eBay's anti-bot splash/captcha is served ON-host (ebay.com/splashui/…), so it
      // slips past BOTH the login-bounce regex and the CF-content sniff — it must still
      // be classified as a challenge (blocked source, never scanned as hub content). This
      // is the safety net for the "ebay still unknown" promotion to native read.
      const ebaySplash = nativeReadToFetchResult({ requestedUrl: 'https://www.ebay.com/mye/myebay/summary', finalUrl: 'https://www.ebay.com/splashui/captcha?ap=1&appName=orch&ru=https%3A%2F%2Fsignin.ebay.com%2Fsignin', html: '<html><body>Please verify yourself</body></html>'.padEnd(500, ' ') });
      assert(ebaySplash.ok === false && ebaySplash.challenged === true && /splash|captcha/i.test(ebaySplash.error), 'eBay on-host /splashui captcha → challenged (not a false-ok scanned as hub content)');
      const ebayHub = nativeReadToFetchResult({ requestedUrl: 'https://www.ebay.com/mye/myebay/summary', finalUrl: 'https://www.ebay.com/mye/myebay/summary', html: '<html>'.padEnd(800, 'x') + 'Active listings</html>' });
      assert(ebayHub.ok === true && ebayHub.status === 200, 'eBay real seller-hub HTML (native read past the wall) → ok:200');

      const empty = nativeReadToFetchResult({ requestedUrl: 'https://swappa.com/x', finalUrl: 'https://swappa.com/x', html: '' });
      assert(empty.ok === false && /empty/i.test(empty.error), 'empty page → terminal error');

      const toggleOff = nativeReadToFetchResult({ requestedUrl: 'https://swappa.com/x', finalUrl: 'https://swappa.com/x', title: 'My Swappa - Swappa', error: 'Executing JavaScript through AppleScript is turned off' });
      assert(toggleOff.ok === false && toggleOff.appleEventsDisabled === true && toggleOff.title === 'My Swappa - Swappa' && /Allow JavaScript from Apple Events/i.test(toggleOff.error), 'toggle-off error names the exact Chrome setting and carries title for reports');

      // Login-state classifier: drives the "detect the login screen → WAIT for the
      // human to sign in → then read" flow. A logged-out hub must be detected so we
      // wait (not fail); a settled hub host must read as logged-in.
      assert(nativeReadLoginState('https://www.mercari.com/us/selling/dashboard/', 'www.mercari.com') === 'unknown', 'on-host but EMPTY title (2-arg) → keep polling, never a false logged-in (first-poll race fix)');
      assert(nativeReadLoginState('https://www.mercari.com/login/?login_callback=%2Fmypage', 'www.mercari.com') === 'logged-out', 'mercari /login bounce → logged-out (wait for human)');
      assert(nativeReadLoginState('https://accounts.google.com/v3/signin/challenge/pwd', 'swappa.com') === 'logged-out', 'swappa Google-OAuth bounce → logged-out');
      assert(nativeReadLoginState('https://www.facebook.com/two_step_verification/authentication/?x=1', 'www.facebook.com') === 'logged-out', '2FA screen → logged-out');
      assert(nativeReadLoginState('https://swappa.com/my/swappa', 'swappa.com') === 'unknown', 'swappa on-host + EMPTY title → keep polling (was a false logged-in that drove all 3 hub URLs while the CF "Performing security verification" loaded — the reported thrash)');
      assert(nativeReadLoginState('NRERR:NOWINDOW', 'swappa.com') === 'no-window', 'no-window sentinel → no-window');
      assert(nativeReadLoginState('about:blank', 'swappa.com') === 'no-window', 'about:blank (window still spawning) → no-window');
      assert(nativeReadLoginState('https://example.com/x', 'swappa.com') === 'unknown', 'off-host non-login URL → unknown (keep polling)');
      // eBay native-read login states. /splashui is ON-host but is the anti-bot captcha
      // wall → WAIT (human clears it in the visible window, like Swappa's CF); a settled
      // seller hub → read; a signin redirect → wait.
      assert(nativeReadLoginState('https://www.ebay.com/splashui/captcha?ap=1&appName=orch&ru=x', 'ebay.com', 'Security Measure', 'ebay') === 'logged-out', 'eBay /splashui anti-bot wall → logged-out (WAIT, do not scan the captcha as a hub)');
      assert(nativeReadLoginState('https://www.ebay.com/mye/myebay/summary', 'ebay.com', 'My eBay Summary', 'ebay') === 'logged-in', 'eBay settled seller hub → logged-in (read now)');
      assert(nativeReadLoginState('https://signin.ebay.com/ws/eBayISAPI.dll?SignIn', 'ebay.com', 'Sign in | eBay', 'ebay') === 'logged-out', 'eBay signin redirect → logged-out (wait for the human)');

      // Inline login form served AT the auth-gated URL (Mercari: HTTP 200, no /login
      // redirect, generic SEO <title>). URL is on-host but the title is the marketing
      // shell → must classify logged-out (WAIT) so the read doesn't thrash the tab.
      // The title is the ONLY discriminator (read toggle-free) for this case.
      assert(nativeReadLoginState('https://www.mercari.com/mypage/listings/active/', 'www.mercari.com', 'Your Go-to Marketplace for Deals on Used & Secondhand Items | Mercari', 'mercari') === 'logged-out', 'mercari inline login form (generic title) → logged-out (wait, do not thrash)');
      assert(nativeReadLoginState('https://www.mercari.com/mypage/listings/active/', 'www.mercari.com', 'Log in | Mercari', 'mercari') === 'logged-out', 'mercari pipe-separated login title → logged-out (wait, do not thrash)');
      assert(nativeReadLoginState('https://www.mercari.com/mypage/listings/active/', 'www.mercari.com', 'My Listings | Mercari', 'mercari') === 'logged-in', 'mercari real hub title → logged-in');
      assert(nativeReadLoginState('https://www.mercari.com/us/selling/dashboard/', 'www.mercari.com', '', 'mercari') === 'unknown', 'mercari empty/loading title at inline success URL → keep polling, not logged-in');
      assert(nativeReadLoginState('https://www.mercari.com/us/selling/dashboard/', 'www.mercari.com', 'https://www.mercari.com/us/selling/dashboard/', 'mercari') === 'unknown', 'mercari URL-as-title at inline success URL → keep polling, not logged-in');
      assert(nativeReadLoginState('https://www.mercari.com/us/selling/dashboard/', 'www.mercari.com') === 'unknown', 'back-compat: 2-arg call (no title) on-host → keep polling until the title settles');
      // Swappa hub bounced to a Cloudflare human-verification ("Just a moment…") at
      // its OWN host: title-aware classify must read logged-out so the read WAITS for
      // the user to solve it, instead of host-only 'logged-in' that drove the tab
      // through all 3 hub URLs (the reported "swappa lands on human verification,
      // keeps refreshing"). Title is read toggle-free, so this works with the
      // Apple-Events toggle OFF.
      assert(nativeReadLoginState('https://swappa.com/my/swappa', 'swappa.com', 'Just a moment...', 'swappa') === 'logged-out', 'swappa CF human-verification (title) → logged-out (wait, do not thrash)');
      assert(nativeReadLoginState('https://swappa.com/my/swappa', 'swappa.com', 'My Swappa - Swappa', 'swappa') === 'logged-in', 'swappa real hub title → logged-in');
      // First-poll race regression guard (NON-inline platform): an empty/loading or
      // URL-as-title at swappa's on-host hub must NOT classify logged-in — the guard
      // was previously gated on isInlineLoginPlatform (mercari-only), leaving swappa
      // exposed; it drove all 3 hub URLs (each /login-bounced) before the CF
      // verification could load. Now ALL native-read platforms keep polling.
      assert(nativeReadLoginState('https://swappa.com/my/swappa', 'swappa.com', '', 'swappa') === 'unknown', 'swappa empty title + platformId → keep polling (not logged-in)');
      assert(nativeReadLoginState('https://swappa.com/my/swappa', 'swappa.com', 'https://swappa.com/my/swappa', 'swappa') === 'unknown', 'swappa URL-as-title → keep polling (not logged-in)');

      // Shared logged-out-title helper (one source for native LOGIN + native READ).
      assert(isLoggedOutTitleForPlatform('mercari', 'Your Go-to Marketplace for Deals on Used & Secondhand Items | Mercari') === true, 'mercari SEO/marketing title → logged-out');
      assert(isLoggedOutTitleForPlatform('mercari', 'My Listings | Mercari') === false, 'mercari real hub title → not logged-out');
      assert(isLoggedOutTitleForPlatform('mercari', '') === false, 'empty title → no signal');
      // GENERIC markers apply to ALL platforms (restores the pre-refactor 'just a
      // moment'/'sign in' rejection + covers Swappa CF without a fabricated title).
      assert(isLoggedOutTitleForPlatform('swappa', 'Just a moment...') === true, 'CF interstitial title → logged-out on any platform');
      assert(isLoggedOutTitleForPlatform('swappa', 'Sign in to Swappa') === true, 'login title → logged-out on any platform');
      assert(isLoggedOutTitleForPlatform('swappa', 'Sign in | Swappa') === true, 'pipe-separated sign-in title → logged-out on any platform');
      assert(isLoggedOutTitleForPlatform('mercari', 'Log in | Mercari') === true, 'pipe-separated log-in title → logged-out on any platform');
      assert(isLoggedOutTitleForPlatform('mercari', 'Sign in & security | Mercari') === false, 'bare "sign in" inside a logged-in account/security title is not enough to reject');
      assert(isLoggedOutTitleForPlatform('swappa', 'My Swappa - Swappa') === false, 'real swappa hub title → not logged-out (no fabricated marker false-trips it)');

      // Content-level inline-login detector (toggle-on net): a read that returns the
      // login form HTML → ok:false loggedOut, and the read loop stops driving the tab.
      assert(nativeReadLooksLoggedOut('<h1>Log in to Mercari</h1><input type=password>') === true, 'mercari login heading in body → looks logged-out');
      assert(nativeReadLooksLoggedOut('<button>Continue with Apple</button>') === true, 'apple SSO button → looks logged-out');
      assert(nativeReadLooksLoggedOut('Email address Password Log in protected by reCAPTCHA') === true, 'generic login form (recaptcha+email+password+log in) → looks logged-out');
      assert(nativeReadLooksLoggedOut('<div>My Listings</div><a href="/logout">Log out</a> reCAPTCHA badge') === false, 'logged-in hub with a stray reCAPTCHA badge → NOT logged-out (no email/password form)');
      const loggedOutRead = nativeReadToFetchResult({ requestedUrl: 'https://www.mercari.com/mypage/listings/', finalUrl: 'https://www.mercari.com/mypage/listings/active/', html: '<html><body><h1>Log in to Mercari</h1></body></html>' });
      assert(loggedOutRead.ok === false && loggedOutRead.loggedOut === true && /LOGIN FORM/i.test(loggedOutRead.error), 'on-host inline login form read → ok:false loggedOut (surfaces in Blocked-sources, stops thrash)');
      return { ok: true };
    },
  },
{
    // Auto-enable "Allow JavaScript from Apple Events" on OUR profile so the native
    // read works without the user flipping the menu toggle each session. The pure
    // decision must be SAFE: it merges the bool into browser{} without clobbering
    // other keys, returns null (no write) when already on or when the Preferences
    // shape is unexpected (a malformed write would make Chrome reset the profile →
    // lost logins).
    name: 'withAppleEventsJsEnabled: safe Preferences merge for the Apple-Events JS toggle',
    run: () => {
      // Fresh / missing profile → seed the pref.
      assert(withAppleEventsJsEnabled(undefined)?.browser?.allow_javascript_apple_events === true, 'missing Preferences (ENOENT) → seed { browser:{ allow_javascript_apple_events:true } }');
      assert(withAppleEventsJsEnabled({})?.browser?.allow_javascript_apple_events === true, 'empty prefs → adds the pref');
      // Already enabled → null (skip the write entirely).
      assert(withAppleEventsJsEnabled({ browser: { allow_javascript_apple_events: true } }) === null, 'already enabled → no write');
      // Preserve other keys + sibling browser keys.
      const merged = withAppleEventsJsEnabled({ foo: 1, browser: { window_placement: { x: 2 }, allow_javascript_apple_events: false } });
      assert(merged?.foo === 1 && merged.browser.window_placement.x === 2 && merged.browser.allow_javascript_apple_events === true, 'preserves other top-level + browser sub-keys while flipping the pref to true');
      // Unexpected shapes must NOT be written (never clobber a corrupt/odd file).
      assert(withAppleEventsJsEnabled(null) === null, 'null → no write');
      assert(withAppleEventsJsEnabled([1, 2]) === null, 'array → no write');
      assert(withAppleEventsJsEnabled('garbage') === null, 'non-object → no write');
      assert(withAppleEventsJsEnabled({ browser: 'not-an-object' })?.browser?.allow_javascript_apple_events === true, 'a non-object browser value is replaced with a clean { allow_javascript_apple_events:true }');
      return { ok: true };
    },
  },
{
    // IO wrapper: the actual file write. The load-bearing safety property is that a
    // CORRUPT/unreadable Preferences must NEVER be overwritten (a malformed write
    // would make Chrome reset the profile → lost logins). darwin-gated (the function
    // and the native-read path both are); skip elsewhere.
    name: 'ensureAppleEventsJsEnabled: seeds/merges the pref, never clobbers a corrupt Preferences',
    run: async () => {
      if (process.platform !== 'darwin') return { ok: true, skipped: 'darwin-only' };
      const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-prefs-'));
      const prefsPath = path.join(base, 'Default', 'Preferences');
      try {
        // 1. Missing Preferences (ENOENT) → file created with the pref enabled.
        await ensureAppleEventsJsEnabled(base);
        const seeded = JSON.parse(await fs.promises.readFile(prefsPath, 'utf8'));
        assert(seeded.browser.allow_javascript_apple_events === true, 'ENOENT → seeds a valid Preferences with the pref on');

        // 2. Valid Preferences, pref absent → pref added, other keys preserved.
        await fs.promises.writeFile(prefsPath, JSON.stringify({ profile: { name: 'keep-me' }, browser: { x: 1 } }), 'utf8');
        await ensureAppleEventsJsEnabled(base);
        const merged = JSON.parse(await fs.promises.readFile(prefsPath, 'utf8'));
        assert(merged.browser.allow_javascript_apple_events === true && merged.browser.x === 1 && merged.profile.name === 'keep-me', 'merges the pref while preserving other keys');

        // 3. CORRUPT Preferences (malformed JSON) → MUST be left exactly as-is.
        const corrupt = '{ this is not json ';
        await fs.promises.writeFile(prefsPath, corrupt, 'utf8');
        await ensureAppleEventsJsEnabled(base);
        const after = await fs.promises.readFile(prefsPath, 'utf8');
        assert(after === corrupt, 'corrupt Preferences is NEVER overwritten (no profile reset / lost logins)');

        // 4. No orphaned temp file left behind.
        const leftovers = (await fs.promises.readdir(path.dirname(prefsPath))).filter(f => f.includes('.tmp-'));
        assert(leftovers.length === 0, `no orphaned .tmp- files (found ${JSON.stringify(leftovers)})`);
        return { ok: true };
      } finally {
        await fs.promises.rm(base, { recursive: true, force: true }).catch(() => {});
      }
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
    name: 'visible auth windows: reject unsafe URLs, diagnose blank startup, and suppress retry-created blank tabs',
    run: () => {
      assert(validateVisibleWindowUrl('https://example.test/login').ok,
        'visible auth/captcha navigation accepts canonical HTTPS URLs');
      for (const unsafe of ['about:blank', 'javascript:alert(1)', 'file:///tmp/x', '', 'not a url']) {
        assert(!validateVisibleWindowUrl(unsafe).ok, `visible auth/captcha navigation rejects ${JSON.stringify(unsafe)}`);
      }
      const blank = classifyVisibleWindowNavigation({
        requestedUrl: 'https://example.test/login', actualUrl: 'about:blank',
        assignmentError: 'Execution context was destroyed', fallbackAttempted: true,
        fallbackError: 'Navigation timeout of 4000 ms exceeded',
      });
      assert(!blank.ok && blank.result === 'navigation-error'
        && blank.requestedUrl === 'https://example.test/login'
        && blank.actualUrl === 'about:blank' && blank.fallbackAttempted
        && blank.error.includes('Navigation timeout'),
      `blank startup is terminal/actionable after one fallback, got ${JSON.stringify(blank)}`);
      const landed = classifyVisibleWindowNavigation({
        requestedUrl: 'https://example.test/login', actualUrl: 'https://example.test/home',
        assignmentError: 'context destroyed during native navigation', fallbackAttempted: false,
      });
      assert(landed.ok && landed.result === 'navigated',
        'a native location assignment may destroy its context but is successful once the page leaves about:blank');
      const unsafeLanding = classifyVisibleWindowNavigation({
        requestedUrl: 'https://example.test/login', actualUrl: 'chrome-error://chromewebdata/',
      });
      assert(!unsafeLanding.ok && unsafeLanding.result === 'navigation-error'
        && unsafeLanding.error.includes('unsafe/non-http(s)'),
      `a non-http(s) landing must not be mistaken for successful navigation — got ${JSON.stringify(unsafeLanding)}`);
      const launch = visibleWindowLaunchOptions({ args: ['--window-size=1100,800'] });
      assert(launch.waitForInitialPage === false && launch.args.includes('--no-startup-window')
        && launch.ignoreDefaultArgs.includes('about:blank'),
      'every visible Puppeteer launch removes Puppeteer\'s positional about:blank and suppresses Chrome startup windows before a collision retry can hand them to the holder session');
      assert(visibleWindowLaunchOptions(launch).args.filter(arg => arg === '--no-startup-window').length === 1,
        'launch hardening remains idempotent across option composition');
      assert(visibleWindowLaunchOptions(launch).ignoreDefaultArgs.filter(arg => arg === 'about:blank').length === 1,
        'about:blank filtering remains idempotent across option composition');
      return { blankResult: blank.result, startupWindowSuppressed: true };
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
    name: 'login auto-close: Reverb auth cookie on login URL is not a completed login',
    run: () => {
      assert(canAuthCookieBypassLoginUrl('glassdoor'), 'Glassdoor keeps the suppressed-redirect auth-cookie exception');
      assert(!canAuthCookieBypassLoginUrl('reverb'), 'Reverb auth cookie must not bypass the login URL guard');
      assert(getLoginAutoCloseWaitReason({
        platformId: 'reverb',
        currentUrl: 'https://reverb.com/login',
        cookieSignal: true,
      }) === 'login-url-cookie-not-trusted',
      'Reverb user_credentials on /login must keep the window open so human verification can finish');
      assert(getLoginAutoCloseWaitReason({
        platformId: 'glassdoor',
        currentUrl: 'https://www.glassdoor.com/profile/login_input.htm',
        cookieSignal: true,
      }) === null,
      'Glassdoor auth cookie may still close on its suppressed-redirect login URL');
      assert(getLoginAutoCloseWaitReason({
        platformId: 'glassdoor',
        currentUrl: 'https://www.glassdoor.com/profile/login_input.htm',
        cookieSignal: true,
        challengeDomSignal: true,
      }) === 'challenge-dom',
      'Visible challenge DOM blocks auto-close even for a platform allowed to use cookie-on-login');
      assert(getLoginAutoCloseWaitReason({
        platformId: 'reverb',
        currentUrl: 'https://reverb.com/',
        cookieSignal: true,
      }) === null,
      'Reverb auth cookie can still auto-close after the browser reaches a non-login page');
      assert(getLoginAutoCloseWaitReason({
        platformId: 'reverb',
        currentUrl: 'https://reverb.com/my/selling/listings?__cf_chl_rt_tk=abc123',
        cookieSignal: true,
      }) === 'challenge-url',
      'Cloudflare challenge URLs block auto-close even when an auth cookie is present');
      return { ok: true };
    },
  }
];
