import { READ_STATE_READ_TOKEN, READ_STATE_UNREAD_TOKEN, annotateReadState, assert, buildMarketplaceModuleRollup, buildSellHubPriceDropRollup, buildSellHubResolveRollup, buildSellHubResolveSnapshot, deriveHubScanStatus, fs, normalizeMarketplaceWatchUrls, path, prepareHubPages, resolveAttentionSourceUrls, scanPreparedHubPages, stripHtmlForAnalysis, stripReadStateTokens, summarizeReadState, visitCanvasNodes, withStatusCheckLock } from '../test-dependencies.js';

// Runs the real two-stage production sequence — prepareHubPages (scrape +
// transport-outcome classification, no LLM call) then scanPreparedHubPages
// (the human copy/paste LLM handoff + result binding) — instead of the
// deleted scanSellerHubPages convenience wrapper that used to compose them
// for exactly this kind of single-platform test. This is what
// marketplace.js's Check-All handler actually calls, so exercising it here
// is strictly better coverage than the wrapper gave.
async function runHubScan({ urlSpecs, llmText, signal, platformId = 'test-platform' }) {
  const prepared = await prepareHubPages({ urlSpecs, platformId, signal });
  return scanPreparedHubPages({ ...prepared, signal, llmText });
}

export default [
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
      const result = await runHubScan({
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
      const failed = await runHubScan({
        urlSpecs: [{ url: dashboard, urlLabel: 'hub', fetcher: async () => { throw new Error('offline'); } }],
        llmText: async () => { shouldNotCall += 1; return {}; },
      });
      assert(failed.status === 'error' && shouldNotCall === 0, 'all fetch failures return error without an LLM call');
      const invalidResponse = await runHubScan({
        urlSpecs: [{ url: dashboard, urlLabel: 'hub', fetcher: async () => null }],
        llmText: async () => { shouldNotCall += 1; return {}; },
      });
      assert(invalidResponse.status === 'error' && invalidResponse.sources[0]?.message.includes('returned no response'),
        'malformed fetcher output becomes a diagnostic page error');
      // A hub URL that RESOLVES to a 4xx/5xx with a styled error body (fetchHtmlAuthed
      // reports ok:true for any HTTP status) must terminate as an error — NOT get
      // stripped and sent to the token-heavy hub-scan LLM as if it were content.
      const brokenWatch = await runHubScan({
        urlSpecs: [{ url: dashboard, urlLabel: 'hub', fetcher: async () => ({ ok: true, status: 404, finalUrl: dashboard, html: `<main>${'Page not found. '.repeat(40)}</main>` }) }],
        llmText: async () => { shouldNotCall += 1; return {}; },
      });
      assert(brokenWatch.status === 'error' && /HTTP 404/.test(brokenWatch.sources[0]?.message || ''),
        `a 4xx hub page becomes a terminal error, got ${brokenWatch.status} / ${brokenWatch.sources[0]?.message}`);
      assert(shouldNotCall === 0, '4xx hub page must not reach the LLM');
      // No watch URLs: the deleted scanSellerHubPages wrapper used to short-circuit
      // this with its own "No watch URLs configured" message before ever touching
      // prepareHubPages. That message is gone along with it — production
      // (marketplace.js) never reaches prepareHubPages with an empty list; it checks
      // watchUrls.length itself first. What's still guaranteed, and worth locking
      // down here, is that prepareHubPages handles urlSpecs:null structurally
      // (empty llmInputs/sources, no throw) and scanPreparedHubPages turns that into
      // the same clean 'unknown' shape via deriveHubScanStatus on an empty list.
      const noUrls = await runHubScan({ urlSpecs: null, llmText: async () => ({}) });
      assert(noUrls.status === 'unknown' && noUrls.sources.length === 0, 'missing URL list returns a clean unknown result');
      assert(deriveHubScanStatus([{ status: 'needs-login' }, { status: 'error' }]) === 'needs-login', 'needs-login wins when no page was readable');
      assert(deriveHubScanStatus([{ status: 'unknown' }, { status: 'error' }]) === 'unknown', 'mixed unknown/error remains unknown');

      const aiFailed = await runHubScan({
        urlSpecs: [{ url: messages, urlLabel: 'hub', fetcher: async () => ({ ok: true, status: 200, finalUrl: messages, html: readableHtml }) }],
        llmText: async () => { throw new Error('model unavailable'); },
      });
      assert(aiFailed.status === 'error' && aiFailed.sources[0]?.message.includes('AI scan failed'),
        'AI failure turns readable inputs into an explicit error outcome');

      // sanitizeAttention scrub + coercion wiring: a non-compliant model can leak
      // ⟦READ⟧/⟦UNREAD⟧ sentinels into headline/evidence/summary and emit an
      // invalid urgency/category. The scan must scrub the tokens everywhere and
      // coerce to low/other — this backs the read-message false-flag fix and is
      // only reachable through scanPreparedHubPages (sanitizeAttention isn't exported).
      const scrubbed = await runHubScan({
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
        // Abort ownership lives entirely in stage 1: prepareHubPages rethrows an
        // AbortError from a fetcher instead of swallowing it into a terminal page
        // failure (see its per-URL catch), so this throws before runHubScan ever
        // reaches scanPreparedHubPages.
        await runHubScan({
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
    // marketplace.js's check-marketplace-status handler runs a Check All scan
    // as two passes over prepareHubPages/scanPreparedHubPages (the split this
    // test targets) specifically so browser scraping for every platform
    // finishes before any platform's manual AI handoff is issued — otherwise
    // a human would have to paste platform A's prompt before platform B's
    // scrape even starts. This proves the property directly against the real
    // exported functions marketplace.js composes, using the SAME two-phase
    // shape (collect every prepare, THEN Promise.all every scan) it uses, and
    // guards the composition itself with a source check so a regression to
    // an inline per-platform prepare-then-scan loop is caught even though the
    // full check-marketplace-status handler (browser automation + IPC) is out
    // of reach for a unit test.
    name: 'Marketplace hub scan: prepare-then-scan split completes every platform\'s page fetch before any AI handoff is issued',
    run: async () => {
      const order = [];
      // Three simulated platforms with deliberately uneven fetch latency —
      // the slowest (platform-a) must still finish its fetch before the
      // FASTEST platform's (platform-c) AI handoff fires, which only holds if
      // every prepareHubPages call is awaited before any scanPreparedHubPages
      // call begins (the actual two-pass shape), not if scan were interleaved
      // per platform as the loop went.
      const platforms = [
        { id: 'platform-a', delayMs: 12 },
        { id: 'platform-b', delayMs: 6 },
        { id: 'platform-c', delayMs: 0 },
      ];
      const urlFor = (id) => `https://example.com/${id}/hub`;

      // Pass 1 — mirrors marketplace.js's per-platform loop: call
      // prepareHubPages for every platform and collect the pending ones;
      // nothing here awaits an LLM call.
      const pendingScans = [];
      for (const platform of platforms) {
        const prepared = await prepareHubPages({
          platformId: platform.id,
          urlSpecs: [{
            url: urlFor(platform.id),
            urlLabel: 'hub',
            fetcher: async () => {
              if (platform.delayMs > 0) await new Promise(resolve => setTimeout(resolve, platform.delayMs));
              order.push(`fetch:${platform.id}`);
              return { ok: true, status: 200, finalUrl: urlFor(platform.id), html: `<main>${'Quiet seller dashboard. '.repeat(20)}</main>` };
            },
          }],
        });
        pendingScans.push({ platformId: platform.id, prepared });
      }

      // Pass 2 — mirrors marketplace.js's Promise.all(pendingScans.map(...)):
      // every remaining platform's manual handoff is issued together, only
      // after pass 1 has finished for ALL platforms.
      await Promise.all(pendingScans.map(({ platformId, prepared }) => scanPreparedHubPages({
        ...prepared,
        llmText: async () => {
          order.push(`llm:${platformId}`);
          return { summary: '', attention: [] };
        },
      })));

      const lastFetchIndex = Math.max(...order.map((entry, i) => entry.startsWith('fetch:') ? i : -1));
      const firstLlmIndex = order.findIndex(entry => entry.startsWith('llm:'));
      assert(order.filter(e => e.startsWith('fetch:')).length === 3 && order.filter(e => e.startsWith('llm:')).length === 3,
        `every platform must both fetch and get scanned exactly once, got: ${order.join(', ')}`);
      assert(firstLlmIndex > lastFetchIndex,
        `no AI handoff may be issued before every platform's page fetch has completed, got order: ${order.join(', ')}`);

      // Guard the composition itself: marketplace.js must call prepareHubPages
      // inside its per-platform loop (never scanPreparedHubPages there) and
      // defer every scan into one batched Promise.all AFTER that loop — the
      // shape this test exercises above.
      const marketplaceSource = fs.readFileSync(path.resolve('electron/ipc/marketplace.js'), 'utf8');
      const handlerStart = marketplaceSource.indexOf("handleSafe('check-marketplace-status'");
      assert(handlerStart >= 0, 'check-marketplace-status handler must still exist in marketplace.js');
      const loopStart = marketplaceSource.indexOf('const pendingScans = [];', handlerStart);
      const pass2Start = marketplaceSource.indexOf('await Promise.all(pendingScans.map(', handlerStart);
      assert(loopStart > handlerStart && pass2Start > loopStart,
        'the handler must declare a pendingScans collector before batching every platform\'s AI handoff in one Promise.all');
      const perPlatformLoop = marketplaceSource.slice(loopStart, pass2Start);
      // The loop may finalize a platform inline ONLY when prepareHubPages found
      // no LLM-eligible page (every hub page already hit a terminal transport
      // outcome, so scanPreparedHubPages makes no AI call) — that immediate
      // scanPreparedHubPages call costs nothing to await early. Any platform
      // WITH llm-eligible pages must instead be queued onto pendingScans and
      // deferred to pass 2, never scanned inline.
      assert(perPlatformLoop.includes('await prepareHubPages('),
        'the per-platform loop must scrape via prepareHubPages');
      const inlineFinalizeIndex = perPlatformLoop.indexOf('llmInputs.length === 0');
      const pendingPushIndex = perPlatformLoop.indexOf('pendingScans.push(');
      assert(inlineFinalizeIndex >= 0 && pendingPushIndex > inlineFinalizeIndex,
        'a platform may only be scanned inline (no queued handoff) when its prepared payload has zero llm-eligible pages; every other platform must be queued onto pendingScans instead');
      return { fetches: 3, handoffs: 3, orderedAfterAllFetches: true };
    },
  },
{
    // FIX 2 regression test. statusCheckLock exists SOLELY to cap request-
    // burst concurrency against the seller's one residential IP — its own
    // header promises every queued check "settles on its own fetch timeouts
    // ... it cannot wedge here the way an indefinite captcha-wait scrape
    // could" (see statusCheckLock.js). Pass 2 of the hub scan (the manual AI
    // handoff) makes no network request at all — it waits on an unbounded
    // human copy/paste that can take minutes or forever now that every LLM
    // call is a manual handoff. If check-marketplace-status held the lock
    // across pass 2, one hub's unanswered handoff dialog would starve every
    // OTHER hub's Check-All / per-card recheck behind it, forever — exactly
    // the failure mode the lock's own header says can't happen. This proves
    // it two ways: (1) functionally, against the real withStatusCheckLock,
    // that a second caller's lock-held work is NOT blocked by a first
    // caller's still-pending post-release work — the shape the fixed handler
    // relies on; and (2) structurally, against marketplace.js's actual
    // source, that the handler is built in that shape (lock wraps only the
    // pass-1 loop; pass 2's Promise.all and the final return sit outside it)
    // — full end-to-end coverage of the real handler is out of reach for a
    // unit test (browser automation + IPC), same as the sibling test above.
    name: 'Marketplace status check: statusCheckLock must not be held across the AI-handoff pass',
    run: async () => {
      const order = [];
      // Run A's "pass 1": a short, lock-held bit of scrape-shaped work.
      const runAPass1 = withStatusCheckLock(async () => {
        order.push('A:pass1:start');
        await new Promise(resolve => setTimeout(resolve, 5));
        order.push('A:pass1:end');
      });
      await runAPass1;
      // Run A's "pass 2": simulates the unbounded human copy/paste handoff —
      // deliberately NOT wrapped in withStatusCheckLock, mirroring the fixed
      // handler. Held open under our own control (not a timer) so the test
      // proves ordering rather than racing a clock.
      let resolveAPass2;
      const aPass2 = new Promise(resolve => { resolveAPass2 = resolve; });
      const runAPass2 = (async () => {
        order.push('A:pass2:start');
        await aPass2;
        order.push('A:pass2:end');
      })();

      // Run B's pass 1 is issued WHILE run A's pass 2 is still pending. If the
      // lock were (incorrectly) held across pass 2, this would queue behind
      // run A's handoff and never start until resolveAPass2() fires below —
      // which this test never calls before asserting. Under the fix, run A
      // already released the lock after its pass 1, so run B's pass 1 can
      // acquire and finish immediately.
      const runBPass1 = withStatusCheckLock(async () => {
        order.push('B:pass1:start');
        order.push('B:pass1:end');
      });
      await runBPass1;

      assert(order.includes('B:pass1:end') && !order.includes('A:pass2:end'),
        `a second check's pass 1 must complete while the first check's AI handoff is still pending, got order: ${order.join(', ')}`);

      // Release run A's handoff and confirm the full sequence resolves cleanly.
      resolveAPass2();
      await runAPass2;
      assert(order.join(',') === 'A:pass1:start,A:pass1:end,A:pass2:start,B:pass1:start,B:pass1:end,A:pass2:end',
        `unexpected interleaving: ${order.join(', ')}`);

      // Sanity check that the assertion above actually exercises the bug FIX 2
      // prevents, rather than passing vacuously: reproduce the ORIGINAL
      // composition (pass 2 awaited INSIDE the lock callback) and confirm it
      // really does starve a second check's pass 1 the way the bug report
      // described — a held lock across an unanswered handoff dialog.
      let releaseBuggyHandoff;
      const buggyHandoff = new Promise(resolve => { releaseBuggyHandoff = resolve; });
      const buggyRunA = withStatusCheckLock(async () => {
        await buggyHandoff; // the bug: pass 2 awaited while still holding the lock
      });
      let buggyBFinished = false;
      const buggyRunB = withStatusCheckLock(async () => { buggyBFinished = true; });
      await new Promise(resolve => setTimeout(resolve, 5));
      assert(buggyBFinished === false,
        'the pre-fix composition (pass 2 inside withStatusCheckLock) really does block a second check\'s pass 1 for as long as the first check\'s handoff is unanswered — confirms the assertions above are testing a real invariant, not a vacuous one');
      releaseBuggyHandoff();
      await Promise.all([buggyRunA, buggyRunB]);
      assert(buggyBFinished === true, 'the buggy composition eventually unblocks once its handoff is answered (queue is not itself broken)');

      // Structural guard on the real handler: the lock must wrap ONLY the
      // pass-1 per-platform loop, with results/recordResult/pendingScans
      // hoisted above it so pass 2 (after release) can still reach them.
      const marketplaceSource = fs.readFileSync(path.resolve('electron/ipc/marketplace.js'), 'utf8');
      const handlerStart = marketplaceSource.indexOf("handleSafe('check-marketplace-status'");
      assert(handlerStart >= 0, 'check-marketplace-status handler must still exist in marketplace.js');
      const resultsDeclIndex = marketplaceSource.indexOf('const results = {};', handlerStart);
      const pendingScansDeclIndex = marketplaceSource.indexOf('const pendingScans = [];', handlerStart);
      const lockCallIndex = marketplaceSource.indexOf('withStatusCheckLock(async () => {', handlerStart);
      assert(resultsDeclIndex >= 0 && pendingScansDeclIndex >= 0 && lockCallIndex >= 0
        && resultsDeclIndex < lockCallIndex && pendingScansDeclIndex < lockCallIndex,
        'results/pendingScans must be declared OUTSIDE (before) the withStatusCheckLock callback so pass 2 can still use them after release');
      const releaseMarkerIndex = marketplaceSource.indexOf('statusCheckLock released above', lockCallIndex);
      const pass2Index = marketplaceSource.indexOf('await Promise.all(pendingScans.map(', lockCallIndex);
      const returnResultsIndex = marketplaceSource.lastIndexOf('return { results };');
      assert(releaseMarkerIndex > lockCallIndex && pass2Index > releaseMarkerIndex && returnResultsIndex > pass2Index,
        'pass 2 (the AI handoff Promise.all) and the final return must sit textually AFTER the lock is released, never inside the withStatusCheckLock callback');
      return { order: order.length, structuralGuardOk: true };
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
  }
];
