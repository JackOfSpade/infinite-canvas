import { READ_STATE_READ_TOKEN, READ_STATE_UNREAD_TOKEN, annotateReadState, assert, buildMarketplaceModuleRollup, buildSellHubPriceDropRollup, buildSellHubResolveRollup, buildSellHubResolveSnapshot, deriveHubScanStatus, isFacebookShareUrl, listingUrlMatchesPlatform, normalizeMarketplaceWatchUrls, resolveAttentionSourceUrls, scanSellerHubPages, stripHtmlForAnalysis, stripReadStateTokens, summarizeReadState, visitCanvasNodes } from '../test-dependencies.js';

export default [
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
    name: 'marketplace watch URLs: trims, deduplicates, and preserves order',
    run: () => {
      const normalized = normalizeMarketplaceWatchUrls([
        ' https://example.com/dashboard ',
        '',
        'https://example.com/messages',
        'https://example.com/dashboard',
        null,
        42,
      ]);
      assert(normalized.join(',') === 'https://example.com/dashboard,https://example.com/messages',
        `watch URL normalization should preserve first-seen order, got ${normalized.join(',')}`);
      assert(normalizeMarketplaceWatchUrls(null).length === 0, 'non-array watch URLs normalize to empty');
      return { urls: normalized.length };
    },
  },
{
    name: 'Marketplace hub scan: isolates page/AI failures, preserves account items, and derives outcomes',
    run: async () => {
      const dashboard = 'https://example.com/dashboard';
      const messages = 'https://example.com/messages';
      const readableHtml = `<main>${'Quiet seller dashboard. '.repeat(20)}</main>`;
      let llmCalls = 0;
      const result = await scanSellerHubPages({
        platformId: 'test-platform',
        urlSpecs: [
          { url: dashboard, urlLabel: 'hub', fetcher: async () => { throw new Error('network down'); } },
          { url: messages, urlLabel: 'hub', fetcher: async () => ({ ok: true, status: 200, finalUrl: messages, html: readableHtml }) },
        ],
        llmText: async () => {
          llmCalls += 1;
          return {
            summary: 'One buyer offer',
            attention: [
              { urgency: 'low', category: 'offer', headline: 'Buyer offered $50', evidence: 'Offer $50', sourceUrl: messages },
              { urgency: 'high', category: 'offer', headline: 'Buyer offered $50', evidence: 'Offer expires today', sourceUrl: messages },
            ],
          };
        },
      });
      assert(llmCalls === 1, `one readable page should produce one consolidated LLM call, got ${llmCalls}`);
      assert(result.status === 'ok', `a readable page should win over a sibling fetch error, got ${result.status}`);
      assert(result.sources.length === 2 && result.sources.some(s => s.status === 'error') && result.sources.some(s => s.status === 'ok'),
        'hub scan keeps both readable and failed source outcomes');
      assert(result.attention.length === 2,
        'account-wide scan keeps same-headline items because they may belong to separate listings');
      assert(result.attention.every(item => item.sourceUrl === messages), 'attention items keep their validated source URL');

      let shouldNotCall = 0;
      const failed = await scanSellerHubPages({
        platformId: 'test-platform',
        urlSpecs: [{ url: dashboard, urlLabel: 'hub', fetcher: async () => { throw new Error('offline'); } }],
        llmText: async () => { shouldNotCall += 1; return {}; },
      });
      assert(failed.status === 'error' && shouldNotCall === 0, 'all fetch failures return error without an LLM call');
      const invalidResponse = await scanSellerHubPages({
        platformId: 'test-platform',
        urlSpecs: [{ url: dashboard, urlLabel: 'hub', fetcher: async () => null }],
        llmText: async () => { shouldNotCall += 1; return {}; },
      });
      assert(invalidResponse.status === 'error' && invalidResponse.sources[0]?.message.includes('returned no response'),
        'malformed fetcher output becomes a diagnostic page error');
      // A hub URL that RESOLVES to a 4xx/5xx with a styled error body (fetchHtmlAuthed
      // reports ok:true for any HTTP status) must terminate as an error — NOT get
      // stripped and sent to the token-heavy hub-scan LLM as if it were content.
      const brokenWatch = await scanSellerHubPages({
        platformId: 'test-platform',
        urlSpecs: [{ url: dashboard, urlLabel: 'hub', fetcher: async () => ({ ok: true, status: 404, finalUrl: dashboard, html: `<main>${'Page not found. '.repeat(40)}</main>` }) }],
        llmText: async () => { shouldNotCall += 1; return {}; },
      });
      assert(brokenWatch.status === 'error' && /HTTP 404/.test(brokenWatch.sources[0]?.message || ''),
        `a 4xx hub page becomes a terminal error, got ${brokenWatch.status} / ${brokenWatch.sources[0]?.message}`);
      assert(shouldNotCall === 0, '4xx hub page must not reach the LLM');
      const noUrls = await scanSellerHubPages({ platformId: 'test-platform', urlSpecs: null, llmText: async () => ({}) });
      assert(noUrls.status === 'unknown' && noUrls.sources.length === 0, 'missing URL list returns a clean unknown result');
      assert(deriveHubScanStatus([{ status: 'needs-login' }, { status: 'error' }]) === 'needs-login', 'needs-login wins when no page was readable');
      assert(deriveHubScanStatus([{ status: 'unknown' }, { status: 'error' }]) === 'unknown', 'mixed unknown/error remains unknown');

      const aiFailed = await scanSellerHubPages({
        platformId: 'test-platform',
        urlSpecs: [{ url: messages, urlLabel: 'hub', fetcher: async () => ({ ok: true, status: 200, finalUrl: messages, html: readableHtml }) }],
        llmText: async () => { throw new Error('model unavailable'); },
      });
      assert(aiFailed.status === 'error' && aiFailed.sources[0]?.message.includes('AI scan failed'),
        'AI failure turns readable inputs into an explicit error outcome');

      // sanitizeAttention scrub + coercion wiring: a non-compliant model can leak
      // ⟦READ⟧/⟦UNREAD⟧ sentinels into headline/evidence/summary and emit an
      // invalid urgency/category. The scan must scrub the tokens everywhere and
      // coerce to low/other — this backs the read-message false-flag fix and is
      // only reachable through scanSellerHubPages (sanitizeAttention isn't exported).
      const scrubbed = await scanSellerHubPages({
        platformId: 'test-platform',
        urlSpecs: [{ url: messages, urlLabel: 'hub', fetcher: async () => ({ ok: true, status: 200, finalUrl: messages, html: readableHtml }) }],
        llmText: async () => ({
          summary: `Quiet ${READ_STATE_READ_TOKEN} inbox`,
          attention: [{
            urgency: 'CRITICAL',
            category: 'totally-made-up',
            headline: `Buyer ${READ_STATE_UNREAD_TOKEN} asked a question`,
            evidence: `${READ_STATE_READ_TOKEN} Is this still available?`,
            sourceUrl: messages,
          }],
        }),
      });
      assert(scrubbed.attention.length === 1, 'a valid-but-non-compliant attention item survives sanitization');
      const scrubbedItem = scrubbed.attention[0];
      assert(scrubbedItem.urgency === 'low', `invalid urgency coerces to low, got ${scrubbedItem.urgency}`);
      assert(scrubbedItem.category === 'other', `invalid category coerces to other, got ${scrubbedItem.category}`);
      assert(![scrubbedItem.headline, scrubbedItem.evidence, scrubbed.summary].some(s => s.includes(READ_STATE_READ_TOKEN) || s.includes(READ_STATE_UNREAD_TOKEN)),
        'read-state sentinels are scrubbed from headline, evidence, and summary');
      assert(scrubbedItem.headline.includes('Buyer') && scrubbedItem.headline.includes('asked a question'), 'scrubbed headline keeps its words');
      assert(scrubbedItem.sourceUrl === messages, 'sanitized item keeps a resolved sourceUrl');

      const controller = new AbortController();
      controller.abort();
      let abortPropagated = false;
      try {
        await scanSellerHubPages({
          platformId: 'test-platform',
          signal: controller.signal,
          urlSpecs: [{
            url: messages,
            urlLabel: 'hub',
            fetcher: async () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              throw error;
            },
          }],
          llmText: async () => ({}),
        });
      } catch (error) {
        abortPropagated = error?.name === 'AbortError';
      }
      assert(abortPropagated, 'abort errors propagate instead of being downgraded to a page failure');
      return { sources: result.sources.length, attention: result.attention.length };
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
            attention: [
              // No sourceUrl → the rollup must flag the dead jump-to-source link (the
              // reported "link did not take me to source").
              { urgency: 'high', category: 'question', headline: 'Buyer message about price', evidence: 'Thanks. If change price let me know that. Thanks' },
              // Has a sourceUrl → the rollup shows WHICH watch URL the flag came from.
              { urgency: 'low', category: 'engagement', headline: 'New watcher', evidence: '1 watcher', sourceUrl: 'https://www.ebay.com/sh/lst/active' },
            ],
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
      // Per-flagged-item source URL: shows which watch URL each flag came from, and
      // explicitly flags a dead jump-to-source link (the "link did not take me to source").
      assert(md.includes('src: https://www.ebay.com/sh/lst/active'), 'a flagged item with a sourceUrl shows which hub URL it came from');
      assert(md.includes('jump-to-source link is dead'), 'a flagged item with NO sourceUrl is marked as a dead jump-to-source link');
      assert(/\b4r\/1u\b/.test(md), 'read/unread column shows 4r/1u');
      assert(md.includes('read-state'), 'notes that read-state was detected');
      assert(md.includes('$50 \\| OBO'), 'literal pipe in summary is escaped so the table row keeps its 7 cells');
      // Masking case: a platform reads OK overall but one of its watch URLs logged
      // out. "Any ok source wins" (deriveHubScanStatus) hides that, so the rollup
      // must surface a blocked tally AND withhold the all-clear line.
      const maskedMd = buildMarketplaceModuleRollup([{
        id: 'mod-2', type: 'marketplacestatus',
        data: { platformStatus: {
          mercari: { status: 'ok', summary: 'Quiet', attention: [], sources: [{ status: 'ok' }, { status: 'needs-login' }], lastChecked: new Date().toISOString() },
        } },
      }]);
      assert(/read \*\*ok\*\* but had a hub URL \*\*blocked\*\*/.test(maskedMd), 'a logged-out sibling watch URL surfaces a blocked tally even when the platform reads ok');
      assert(!/Every checked platform read its hub cleanly/.test(maskedMd), 'the all-clear line is withheld when a watch URL was blocked');
      assert(/\| mercari \| ok \|.*\| 2 \(0\/1\) \|/.test(maskedMd), 'the Sources column shows total (err/blk) with the blocked count');
      // Blocked-source REASON detail: a platform that reads `unknown` with every
      // hub source blocked (Swappa Cloudflare wall, Mercari client-rendered shell)
      // must surface WHY per source — the count column + "Could not read…" summary
      // alone can't tell anti-bot (retry) from logout (re-login). Identical
      // reasons are deduped with a ×N tally.
      const blockedMd = buildMarketplaceModuleRollup([{
        id: 'mod-3', type: 'marketplacestatus',
        data: { platformStatus: {
          swappa: { status: 'unknown', summary: 'Could not read this platform’s hub pages.', attention: [],
            sources: [
              { url: 'https://swappa.com/account/listings', status: 'unknown', message: 'Anti-bot challenge (HTTP 403 → cf wall); session is still logged in. Retry later.' },
              { url: 'https://swappa.com/inbox', status: 'unknown', message: 'Anti-bot challenge (HTTP 403 → cf wall); session is still logged in. Retry later.', title: 'Just a moment...', finalUrl: 'https://swappa.com/my/swappa', challenged: true },
            ],
            lastChecked: new Date().toISOString() },
          mercari: { status: 'unknown', summary: 'Could not read this platform’s hub pages.', attention: [],
            sources: [
              { url: 'https://www.mercari.com/mypage/listings/active/', status: 'unknown', message: 'Empty or near-empty response (412 bytes).', title: 'https://www.mercari.com/mypage/listings/active/', finalUrl: 'https://www.mercari.com/mypage/listings/active/', appleEventsDisabled: true },
            ],
            lastChecked: new Date().toISOString() },
        } },
      }]);
      assert(/Blocked \/ unreadable hub sources/.test(blockedMd), 'renders a blocked-source reason section when a hub source is non-ok');
      assert(/Anti-bot challenge.*session is still logged in/.test(blockedMd), 'surfaces the Cloudflare/anti-bot block reason (retry, not logout)');
      assert(/`unknown` ×2/.test(blockedMd), 'identical block reasons are deduped with a ×N tally');
      assert(/Empty or near-empty response/.test(blockedMd), 'surfaces the empty client-rendered shell reason distinctly from the anti-bot one');
      assert(/title="Just a moment\.\.\."/.test(blockedMd), 'blocked native read source surfaces captured title');
      assert(/apple-events-off/.test(blockedMd), 'blocked native read source surfaces Apple Events disabled flag');
      assert(/ · challenge/.test(blockedMd), 'blocked native read source surfaces anti-bot challenge flag');
      // A fully-clean platform (all sources ok) must NOT appear in the blocked section.
      assert(!/Blocked \/ unreadable hub sources/.test(md), 'no blocked section when every source read ok');
      // No marketplacestatus node → empty (unchanged behavior).
      assert(buildMarketplaceModuleRollup([{ id: 'x', type: 'sellhub', data: {} }]) === '', 'no module node → empty string');
      return { ok: true };
    },
  },
{
    name: 'buildSellHubPriceDropRollup: surfaces zero target plans compactly',
    run: () => {
      const md = buildSellHubPriceDropRollup([
        {
          id: 'hub-free-target',
          type: 'sellhub',
          data: {
            hubState: 'priced',
            product: { generated_title: 'Table Lamp | Blue' },
            priceDropReminderWeeks: 0.5,
            priceDropMustSellDate: '2026-07-31',
            priceDropTargetPrice: 0,
            priceDropStartingTier: 'best',
            priceDropPlanStartingPrice: 55,
          },
        },
        { id: 'card-1', type: 'marketplacecard', data: { hubId: 'hub-free-target', priceDropReminderDue: true } },
        { id: 'card-2', type: 'marketplacecard', data: { hubId: 'hub-free-target' } },
      ]);
      assert(md.includes('SellHub Price-Drop Plans'), 'renders the compact SellHub price-drop section');
      assert(md.includes('**$0**') && /\| \$0 \|/.test(md), 'zero target is rendered as $0, not omitted as empty/off');
      assert(md.includes('Table Lamp \\| Blue'), 'markdown table delimiters in item titles are escaped');
      assert(/\| 2 \(1 due\) \|/.test(md), 'connected marketplace cards and due reminders are summarized');
      assert(buildSellHubPriceDropRollup([{ id: 'hub-empty', type: 'sellhub', data: { hubState: 'priced' } }]) === '',
        'unplanned sellhubs do not add a noisy report section');
      // A planned sellhub nested inside a CanvasNode group must still be found —
      // exercises the shared visitCanvasNodes recursion the rollup relies on.
      const nested = buildSellHubPriceDropRollup([
        {
          id: 'group-1',
          type: 'group',
          data: {
            canvasData: {
              nodes: [
                { id: 'nested-hub', type: 'sellhub', data: { hubState: 'priced', product: { generated_title: 'Buried Lamp' }, priceDropTargetPrice: 12 } },
              ],
            },
          },
        },
      ]);
      assert(nested.includes('Buried Lamp'), 'rollup descends into grouped sub-canvases (shared visitCanvasNodes recursion)');
      return { ok: true };
    },
  },
{
    name: 'buildSellHubResolveRollup: surfaces active resolve queue compactly',
    run: () => {
      const snapshot = buildSellHubResolveSnapshot(
        [{
          id: 'hub-resolve-1',
          type: 'sellhub',
          data: {
            hubState: 'researching',
            product: { generated_title: 'Camera Slider | Bundle' },
          },
        }],
        [{
          id: 'hub-resolve-1',
          hubState: 'researching',
          isApplyingResolves: true,
          queuedResolvesCount: 2,
          resolveQueueWait: 1,
          activeResolveSourceIds: ['ebay-sold'],
          queuedResolveSourceIds: ['swappa-sold'],
          compProgress: {
            'ebay-sold': { status: 'done', count: 60 },
            'swappa-sold': { status: 'error', count: 0, warning: { code: 'scrape-timeout' } },
          },
        }],
      );
      assert(snapshot.length === 1 && snapshot[0].workCount === 2,
        'resolve snapshot should keep hubs with active resolved-source work');
      const md = buildSellHubResolveRollup(snapshot);
      assert(md.includes('SellHub Source Resolve Queue'), 'resolve rollup should render a compact section');
      assert(md.includes('Camera Slider \\| Bundle'), 'resolve rollup should escape markdown table delimiters');
      assert(md.includes('behind 1 browser op'), 'resolve rollup should show source-rescrape browser queue wait');
      assert(md.includes('ebay-sold') && md.includes('swappa-sold'), 'resolve rollup should show active and queued source ids');
      assert(md.includes('scrape-timeout'), 'resolve rollup should preserve warning codes in source progress');
      return { ok: true };
    },
  },
{
    name: 'visitCanvasNodes: depth-first walk descends into grouped sub-canvases; non-array is a no-op',
    run: () => {
      const seen = [];
      visitCanvasNodes([
        { id: 'a', type: 'sellhub' },
        {
          id: 'g', type: 'group',
          data: { canvasData: { nodes: [
            { id: 'b', type: 'marketplacecard' },
            { id: 'g2', type: 'group', data: { canvasData: { nodes: [{ id: 'c', type: 'sellhub' }] } } },
          ] } },
        },
      ], (n) => seen.push(n.id));
      assert(seen.join(',') === 'a,g,b,g2,c', `visits every node depth-first incl. nested (got ${seen.join(',')})`);
      let calls = 0;
      visitCanvasNodes(null, () => { calls += 1; });
      visitCanvasNodes(undefined, () => { calls += 1; });
      visitCanvasNodes([null, undefined], () => { calls += 1; });
      assert(calls === 0, 'non-array input and null entries are skipped without calling fn');
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
  }
];
