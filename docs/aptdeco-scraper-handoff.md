# AptDeco Scraper Implementation Handoff

Prepared: 2026-06-15  
Target: `www.aptdeco.com`  
Audience: next Claude Code instance implementing AptDeco marketplace scraping in this repo.

## Executive Summary

Implement AptDeco as an **active asking-price comp source**, not as a sold-price source.

Observed public AptDeco browse/category pages expose active inventory with listing titles, asking prices, original/retail prices, product links, quantity/set size, and merch badges. I did not find public sold/completed-sale pages in the visible site surface. Treating AptDeco as `category: 'sold'` would pollute FMV pricing because the numbers are current asking prices, not realized sale prices.

Recommended source id: `aptdeco-active`.

Recommended initial behavior:

- Add `aptdeco-active` to `PRICE_COMP_SOURCES` as a Tier 1 or Tier 2 **active** furniture/home source.
- Add a browser-pool extractor in `electron/extractors/marketplace.js`.
- Wire it into `buildCompTasks()` in `electron/ipc/marketplace.js` with `category: 'active'`.
- Do **not** add it to `COMP_SOURCE_LOGIN_PLATFORM` unless implementation proves login is required for the pages being scraped.
- Do **not** add it to `SELL_PLATFORMS` unless the product also intends to support posting/monitoring seller listings on AptDeco.

## Research Notes

Sources checked:

- `https://www.aptdeco.com/`
- `https://www.aptdeco.com/just-added`
- `https://www.aptdeco.com/catalog/furniture/sofas`
- `https://www.aptdeco.com/catalog/furniture/sofas?page=2`
- `https://www.aptdeco.com/sell`
- `https://www.aptdeco.com/sell/new`

Local raw `curl` probing was not available in this session: sandbox DNS failed, and escalated network access was rejected by the environment. The next instance should do one short DevTools pass in a real browser before coding the URL builder.

Observed page behavior:

- Home page renders product cards server-side enough for text extraction. Example card text includes title, price, retail estimate, discount, delivery deal, and badges.
- `just-added` renders a large active-results page with filters and pagination.
- Category pages use routes like `/catalog/furniture/sofas`.
- Pagination uses `?page=N`, verified on `/catalog/furniture/sofas?page=2`.
- Product links are present on cards, but this session could not expose raw `href` values. Likely route shape is `/product/<slug>-<number>` based on AptDeco link behavior, but verify exact raw anchors in DevTools before committing selectors.
- `sell/new` is reachable publicly but shows sign-in affordances for existing accounts; this is seller-flow surface, not comp data.

Useful visible text patterns:

- Result-count area: `1694 results`, `Clear All Filters See 1,694 Products`.
- Sort label: `Sort: Recommended`.
- Card title line: `Crate and Barrel Sofa`.
- Current price plus original/strikethrough pattern: `$897$1,055  •  Qty: 1`.
- Quantity/set pattern: `Qty: 1`, `Set of 3`.
- Retail estimate pattern: `Est retail: $3,099|71% off`.
- Badges: `Price Drop`, `Great Price`, `Ending Soon`, delivery discount text.

## Critical Unknown: Search URL or API

Before implementing, discover whether AptDeco has a query-specific endpoint:

1. Open `https://www.aptdeco.com/` in Chrome.
2. Use the site search UI if present.
3. Inspect route changes and XHR/fetch calls in DevTools.
4. Look for one of:
   - a query URL such as `/catalog?...`,
   - a JSON API returning product arrays,
   - embedded state in HTML,
   - only category/filter browse pages.

Do not ship a broad `/just-added` scrape as the default comp source unless there is no better URL. A broad active furniture page will return many irrelevant results, burn tokens, and rely too heavily on downstream title ranking.

If there is no full-text search endpoint, use a narrow category route derived from item category/query. That requires changing `buildCompTasks(query)` to accept category context, because `scrapeCompsForQuery(query, { category })` currently receives category but does not pass it into `buildCompTasks()`.

## Repo Integration Points

### `electron/extractors/marketplace.js`

Add:

- `APTDECO_ACTIVE_CONFIG`
- `APTDECO_ACTIVE_EXTRACTOR`

Suggested config:

```js
export const APTDECO_ACTIVE_CONFIG = {
  waitMs: 2500,
  timeoutMs: 35000,
  waitFor: 'a[href*="/product/"]', // verify raw AptDeco href pattern first
  scrollFirst: false,
  dismissCookies: true,
  referer: 'https://www.google.com/',
  expectedMinItems: 3,
};
```

The extractor should be DOM-based initially unless DevTools reveals a cleaner JSON/API source. Favor structural signals over CSS class names:

- Candidate cards: deduped product anchors. Start with `a[href*="/product/"]` only after raw HTML/DevTools confirms that href pattern.
- URL: normalize anchor `href` against `location.origin`.
- Title: prefer anchor text; fallback to `img[alt]` after stripping `Used ` prefix and ` for sale on AptDeco` suffix.
- Price: search the card-ish ancestor text for the first money token. Existing `MONEY_PARSE_FN` already avoids fused current/original prices by taking the first money amount.
- Condition: probably unavailable on cards; leave blank unless detail page/API exposes it cheaply.
- `source`: `aptdeco-active`.
- Return `{ items, yieldStats }`.
- Track `seen`, `noFields`, `noTitle`, `noPrice`, `noLink` like the eBay/Poshmark/Mercari extractors.
- Throw `SITE_CHANGED` with `SITE_CHANGED_DIAG` if candidates exist but no usable items are extracted.

Ancestor strategy for cards:

- Start from the product anchor.
- Walk up a few ancestors and choose the smallest ancestor whose text contains a `$`.
- Avoid `document.body` as a card unless nothing else works.
- This avoids tying the extractor to obfuscated classes while still capturing nearby price/retail text.

### `electron/ipc/marketplace.js`

Import the new config/extractor and add one task:

```js
{
  id: 'aptdeco-active',
  category: 'active',
  url: aptDecoUrlForQuery(query /*, category if buildCompTasks is extended */),
  extractorJS: APTDECO_ACTIVE_EXTRACTOR,
  options: APTDECO_ACTIVE_CONFIG,
}
```

If a category-aware fallback is needed, change:

```js
function buildCompTasks(query) { ... }
```

to:

```js
function buildCompTasks(query, { category } = {}) { ... }
```

and update these callers:

- `scrapeOneSource()`
- `scrapeCompsForQuery()`
- captcha-resolve lookup near `buildCompTasks('')`

For captcha-resolve with an empty query, ensure it can still find the source definition. If URL construction requires a real query/category, factor source definitions so lookup by id does not depend on a valid URL.

### `src/utils/constants.js`

Add to `PRICE_COMP_SOURCES`:

```js
{ id: 'aptdeco-active', name: 'AptDeco Active', letter: 'AD', color: '#00a66c', domain: 'aptdeco.com' },
```

Use the final sampled brand color if adding a favicon. `PlatformBadge` falls back to the letter badge when no local favicon exists.

Optional but preferred:

- Add `src/assets/favicons/aptdeco.com.png`.

### `src/utils/marketplaceLoginPreflight.js`

Do not add AptDeco initially. Public catalog/category pages were visible without login. Adding it here would make every price run require an AptDeco account before there is evidence that auth is needed.

### `electron/ipc/stealthBrowser.js`

Only touch `SELL_MONITOR_PLATFORMS` if adding AptDeco as a seller listing/status-monitor platform. That is separate from comp scraping.

If seller monitoring is later desired, likely starting points:

- `sellerUrl`: discover from logged-in account UI.
- `verifyUrl`: some universal logged-in account page, not seller onboarding.
- `bodySignals`: `sign in`, `already have an account`, `email address password`, etc.

### `electron/ipc/marketplace.js` Platform Recommendations

The pricing synthesis prompt currently says:

```text
Furniture/Home -> Facebook Marketplace (0% local) only
Use platform IDs: ebay, facebook, mercari, poshmark, depop, swappa, reverb
```

If AptDeco becomes a real listing destination, update the prompt and schema/platform list. If it is comp-only, do not add it to recommended platforms.

## URL Builder Strategy

Best case after DevTools:

- Use AptDeco's real full-text search route/API with `query`.
- Keep `category: 'active'`.
- Let downstream relevance filtering and synthesis decide fit.

Fallback if no full-text search exists:

- Route by category:
  - Sofas: `/catalog/furniture/sofas`
  - Tables: `/catalog/furniture/tables`
  - Chairs: `/catalog/furniture/chairs`
  - Beds: `/catalog/furniture/beds`
  - Storage: `/catalog/furniture/storage-organization` or verify exact route from nav
  - Rugs: `/catalog/rugs` or verify exact route
  - Lighting: `/catalog/lighting` or verify exact route
  - Decor: `/catalog/decor` or verify exact route
  - Outdoor: `/catalog/outdoor-garden` or verify exact route

Do not guess unchecked routes in code. Click each nav route or inspect anchors.

If category fallback is used, add a warning or provenance note in the implementation comments that AptDeco is category-browse, not exact search. This source should be considered active market context, not high-confidence title-matched comps.

## Tests to Add

Add a fixture:

- `scripts/fixtures/aptdeco-body.html`

Fixture should contain at least:

- one normal card: title, single current price, product link;
- one discounted card: `$897$1,055` to prove first-money parsing;
- one `Set of 3` card;
- one card missing title or price to verify `yieldStats.noFields`;
- duplicate product link to verify dedupe.

Add tests in `scripts/test-runner.js` near existing marketplace extractor tests:

- AptDeco extractor returns `{ items, yieldStats }`.
- `items[0].source === 'aptdeco-active'`.
- price parsing takes current price, not original price.
- URL normalizes to an absolute `https://www.aptdeco.com/...` product URL using the verified product href pattern.
- duplicate product URLs dedupe.
- missing subfields increment `yieldStats`.
- empty page throws `SITE_CHANGED` with `[diag ... cards=0]`.
- `ALL_COMP_SOURCE_IDS.includes('aptdeco-active')`.
- `buildCompTasks()` includes AptDeco with `category: 'active'` when not scoped.
- `MARKETPLACE_TEST_SOURCE=aptdeco` includes `aptdeco-active` via family scope.
- `computeMissingLogins([{ id: 'aptdeco-active' }], {})` remains empty unless login is intentionally added.

Run:

```bash
npm test
npm run lint
```

Run e2e only if UI source-card behavior or constants affect the rendered flow:

```bash
npm run test:e2e
```

## Anti-Bot and Rate-Limit Considerations

AptDeco pages were readable through the web fetcher as public HTML. That is encouraging, but do not assume it is stable under headless browser automation.

Use existing browser-pool behavior:

- shared stealth browser,
- one concurrent page per domain,
- adaptive cooldown,
- anti-bot detector,
- visible Solve flow if blocked.

Do not implement custom retry loops inside the extractor. Let `browserPool` and `antiBotDetector` classify blocks/timeouts.

If DevTools finds a public JSON endpoint, prefer direct `safeApiFetch` only if it is stable and does not require browser-only tokens. Otherwise stick with browser DOM extraction, because it integrates with Solve and session reuse.

## Common Mistakes to Avoid

- Do not mark AptDeco comps as sold.
- Do not add AptDeco to hard login preflight for public comp pages.
- Do not scrape `/just-added` broadly as the first implementation if a query or category-specific route exists.
- Do not rely on CSS classes until raw HTML proves stable names. The visible site appears React/SPA-like and classes may churn.
- Do not parse `$897$1,055` as `8971055` or `897.1055`; reuse the existing first-money parser.
- Do not add AptDeco to `SELL_PLATFORMS` unless posting/status support is in scope.
- Do not forget the source id in every emitted item; downstream grouping uses `item.source`.
