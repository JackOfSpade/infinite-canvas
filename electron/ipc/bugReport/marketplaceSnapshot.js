import { getMarketplaceTelemetry } from '../marketplace.js';
import { MARKETPLACE_TEST_MODE } from '../../../src/utils/compSourceScope.js';
import { ago, modelTag, pipelineScope, overPricedSoldFlag } from './helpers.js';

// Verdict for what the top-25/15 comp cap actually dropped — does it skew the
// price? Two facts matter. (1) Compare the TYPICAL dropped comp (its median) to
// the typical kept one, not a lone outlier — the old dropped.max ≥ kept.median
// test fired on essentially every run. (2) Crucially, the cap selects by
// title-match RELEVANCE, not price. So a kept/dropped PRICE gap is only a skew if
// the cap dropped comps as on-spec as the ones it kept; when the dropped comps
// are clearly less relevant (the cap shedding off-spec/junk listings, which tend
// to be cheap), a price gap is the EXPECTED result of good ranking, not a bias.
// Without that relevance check a well-ranked run that correctly drops cheap junk
// looks "biased HIGH" — a false alarm. keptScore/droppedScore are the median
// title-match scores (see marketplace.js medianScore).
//   • dropped median below the kept range      → cheap noise, cap working (no flag)
//   • dropped median ≈ kept median (≤15%)       → representative sample, NOT skewed
//   • price gap >15% but dropped less relevant  → cap shed off-spec comps, ranking working (no flag)
//   • price gap >15% at comparable relevance    → cap shed equally on-spec comps → price biased
const dropBandVerdict = (kept, dropped, keptScore, droppedScore) => {
  if (!kept || !dropped) return '';
  if (dropped.median < kept.min) {
    return ' Dropped sit below the kept band (low-relevance noise — cap working as intended).';
  }
  const rel = kept.median > 0 ? (dropped.median - kept.median) / kept.median : 0;
  if (Math.abs(rel) <= 0.15) {
    return ` ✅ dropped median $${dropped.median} ≈ kept median $${kept.median} — the cap dropped a representative sample, so the price is not skewed by it (the 25/15 cap is a by-design cost bound, not lost signal).`;
  }
  const pct = Math.round(Math.abs(rel) * 100);
  const dir = rel > 0 ? 'ABOVE' : 'BELOW';
  const bias = rel > 0 ? 'LOW' : 'HIGH';  // dropped pricier ⇒ kept skews low; dropped cheaper ⇒ kept skews high
  const haveScores = keptScore != null && droppedScore != null && keptScore > 0;
  const scoreNote = haveScores ? ` (median match score ${droppedScore} vs kept ${keptScore})` : '';
  // Dropped comps clearly less relevant than kept → the cap correctly kept the
  // closest matches; the price gap is the ranking working, not a bias.
  if (haveScores && droppedScore < keptScore * 0.85) {
    return ` dropped median $${dropped.median} is ${pct}% ${dir} kept median $${kept.median}, but the dropped comps are less relevant${scoreNote} — the cap kept the closest-matching listings and shed lower-relevance ${rel > 0 ? 'pricier' : 'cheaper'} ones, so the gap is the ranking working as intended, not a price bias.`;
  }
  return ` ⚠️ dropped median $${dropped.median} is ${pct}% ${dir} kept median $${kept.median} at comparable relevance${scoreNote} — the cap shed comps as on-spec as those it kept, so the price may be biased ${bias} (raise the cap or improve the comp ranking).`;
};

/**
 * Sell-side analog of buildJobsPipelineSnapshot: renders the last marketplace
 * pipeline funnel (photo analysis → comp scrape → captcha-resolve → price
 * synthesis → platform fit). Same rationale — the SellHub's in-memory tallies
 * vanish when the hub is deleted, and the raw funnel otherwise lives only in
 * the scrolling log buffer. The decisive line for "did we use all the comps we
 * found?" is synthesis's used-vs-found gap (the top-25/15 slice is by-design;
 * a recommended_price of null means comps were scraped but no price came out).
 */
export function buildMarketplacePipelineSnapshot(currentNodeIds, reportWindowId) {
  let t;
  try { t = getMarketplaceTelemetry(); } catch { return ''; }
  const hasResolves = t && t.resolves && Object.keys(t.resolves).length > 0;
  if (!t || (!t.analyze && !t.scrape && !hasResolves && !t.synthesis && !t.fit)) return '';

  const scope = pipelineScope(t.nodeId, t.windowId, currentNodeIds, reportWindowId);
  if (scope.foreign) return `\n## Marketplace Pipeline\n${scope.note}`;

  const lines = [];

  // Surface test mode so a deliberately-narrowed run isn't misread as a bug
  // ("why did only one comp source scrape?").
  if (MARKETPLACE_TEST_MODE.enabled && MARKETPLACE_TEST_MODE.sourceId) {
    lines.push(`> ⚙️ Marketplace test mode: comp scrape scoped to **${MARKETPLACE_TEST_MODE.sourceId}** only.`);
  }

  if (t.analyze) {
    const a = t.analyze;
    lines.push(`### Product analysis${ago(a.ts)}`);
    lines.push(`- ${a.photos} photo(s) → "${a.title}"${modelTag(a.model, a.fallback)}`);
  }

  if (t.scrape) {
    const s = t.scrape;
    const errored = s.errored ?? 0;
    const timedOut = s.timedOut ?? 0;
    const loginRequired = s.loginRequired ?? 0;
    lines.push(`\n### Comp scrape${ago(s.ts)}`);
    if (s.preflightBlocked) {
      // The run never scraped — the hard login preflight blocked it. Surface this
      // FIRST so a "0 comps" run isn't misread as empty results or a scrape bug.
      lines.push(`- ⛔ **Login preflight BLOCKED the run** — not logged in to: ${(s.missingLogins || []).join(', ') || '(unknown)'}. Policy requires login on all in-scope marketplaces before a price check runs; nothing was scraped. Log in (Settings → Accounts) and re-run.`);
    }
    lines.push(
      `- ${s.sources} sources → **${s.sold} sold + ${s.active} active** comps · ${s.warnings} warning(s)` +
      `${s.blocked > 0 ? `, ${s.blocked} anti-bot block(s)` : ''}` +
      `${loginRequired > 0 ? `, ${loginRequired} not-logged-in` : ''}` +
      `${timedOut > 0 ? `, ${timedOut} timed-out` : ''}` +
      `${errored > 0 ? `, ${errored} scrape error(s)` : ''}`,
    );
    if (s.bySource && Object.keys(s.bySource).length > 0) {
      // Per-source raw counts — pair with the synthesis "unique" line below to
      // spot a single source double-counting (e.g. a healthy-looking total
      // that's mostly one source's duplicates). A ⚠️<code> after a count names
      // WHY that source returned what it did — so a 0 isn't silently ambiguous.
      const sw = s.sourceWarnings || {};
      const yb = s.yieldBySource || {};
      const prov = s.provenanceBySource || {};
      // A browser-pool source (present in provenanceBySource) that returned NO
      // yieldStats is a bare-array extractor with no per-card drift counter — a
      // silent selector drift there can't be detected, so a healthy-looking count
      // can hide vanished listings. Flag it (suppressed when a sourceWarning already
      // explains the source). API sources (e.g. reverb) are never in
      // provenanceBySource, so they're correctly excluded rather than mis-flagged.
      const noDrift = (id) => (prov[id] && !yb[id] && !sw[id]) ? ' ⚠️no-drift-telemetry' : '';
      // A neutral extraction-yield suffix per source: "(144 seen, 96 no-fields)"
      // = 144 candidate cards on the page, 96 of which looked like listings but
      // yielded no usable price/title/link. `seen` is a raw card count (it
      // includes benign skips — eBay promo tiles, Mercari's twin anchors), so it
      // is shown as data, not auto-flagged; `noFields` is the clean partial-drift
      // signal that answers "did we get a price for EACH listing?" — a healthy
      // run reads "48 seen" (noFields omitted), a drifted one "144 seen, 96 no-fields".
      const fmtYield = (id) => {
        const y = yb[id];
        if (!y || typeof y.seen !== 'number') return '';
        return ` (${y.seen} seen${y.noFields > 0 ? `, ${y.noFields} no-fields` : ''})`;
      };
      // Per-source raw counts are now the full rendered page (extractors no
      // longer slice to a per-source cap), so a count reflects everything the
      // page offered rather than a floor.
      lines.push(`- Per source (raw items): ${Object.entries(s.bySource).map(([id, n]) => `${id}=${n}${fmtYield(id)}${noDrift(id)}${sw[id] ? ` ⚠️${sw[id].code}` : ''}`).join(', ')}`);
      // Spell out each flagged source's evidence (e.g. "extractor produced 0
      // items (expected ≥ 3)" = stale selectors / empty vs. a tiny-body block).
      for (const [id, w] of Object.entries(sw)) {
        lines.push(`  - \`${id}\` (${w.severity}): ${w.evidence}`);
      }
      // Conservative partial-drift hint: a source that dropped MORE cards to
      // missing fields than it kept almost certainly had a sub-selector move (it
      // still returned >0 items, so it never tripped SITE_CHANGED — exactly the
      // silent-degradation case a bare count would hide). Only fires on
      // dropped > kept to stay quiet on benign skip noise.
      for (const [id, y] of Object.entries(yb)) {
        const kept = s.bySource?.[id] ?? 0;
        const ySeen = typeof y?.seen === 'number' ? y.seen : 0;
        if (!y || typeof y.noFields !== 'number' || y.noFields === 0) continue;
        if (kept === 0 && ySeen > 0) {
          // TOTAL field-drop: rows were present but EVERY candidate failed
          // price/title/link extraction. For a JS-rendered source (e.g.
          // PriceCharting's js-price spans) this is usually fields that never
          // finished loading; it can also be a selector drift. The page returned
          // rows, so it is NOT a block/login wall — distinct from a clean 0.
          lines.push(`  - ⚠️ \`${id}\` saw ${ySeen} row(s) but extracted 0 — every candidate failed price/title/link extraction. Likely JS-rendered fields that never populated (content loads after the row skeleton), or a selector drift; the page returned rows so it is not a block. If it persists across re-runs, check the source's field selectors / readiness wait.`);
        } else if (y.noFields > kept && kept > 0) {
          lines.push(`  - ⚠️ \`${id}\` kept ${kept} but dropped ${y.noFields} card(s) for missing price/title/link — likely a PARTIAL selector drift (a field sub-selector moved). The source still returned data, so it did NOT trip SITE_CHANGED; check its title/price/link selectors.`);
        }
      }
      // Bare-array sources (no seen/noFields denominator) — name them once so the
      // ABSENCE of a drift signal is explicit rather than mistaken for a clean run.
      const noTelemetry = Object.keys(s.bySource).filter(id => prov[id] && !yb[id] && !sw[id]);
      if (noTelemetry.length > 0) {
        lines.push(`  - ⚠️ No partial-drift telemetry from: ${noTelemetry.join(', ')} — these return a bare list with no per-card seen/no-fields counter, so a silent selector drift (dropping real listings while items stay > 0) would NOT surface here. Treat their counts as unverified for completeness; the sources above carry a seen/no-fields denominator.`);
      }
    }
    if (s.provenanceBySource && Object.keys(s.provenanceBySource).length > 0) {
      // Scrape provenance: the URL each source was read from + the sold/active
      // category the pipeline CLAIMS for it (hard-coded on the task, never
      // verified against the page). The tell: a source bucketed `sold` whose URL
      // carries no sold/completed filter — cf. eBay `LH_Sold=1`, Poshmark
      // `availability=sold_out`, Mercari `status=sold_out` — is feeding ACTIVE
      // asking prices to the model as "what buyers actually paid" (e.g. Swappa's
      // `/search?q=` → a `/listings/<model>` page that is live for-sale inventory,
      // not completed sales). Shown as data, NOT auto-flagged: some sold sources
      // legitimately lack the literal token (PriceCharting's `type=prices` IS sold
      // data), so the URL is surfaced for a human to judge rather than mis-warned.
      lines.push('- Scrape provenance (URL read · claimed category — a `sold` source whose URL has no sold/completed filter is serving ACTIVE prices):');
      for (const [id, p] of Object.entries(s.provenanceBySource)) {
        lines.push(`  - \`${id}\` claims **${p.category}** ← ${p.url}`);
      }
    }
    if (s.apiQueryBySource && Object.keys(s.apiQueryBySource).length > 0) {
      // API sources (reverb, pricecharting) aren't browser-pool tasks, so they have
      // no scrape-provenance entry above. Their analog is the EFFECTIVE QUERY: the
      // string actually searched. PriceCharting rewrites the product title
      // (priceChartingQuery strips capacity/condition/"Console") before hitting a
      // product-catalog search — so its count is shaped by that rewrite. Surfacing
      // query + URL tells "normalizer over-stripped / wrong product" apart from
      // "the catalog genuinely has only N matching variants".
      lines.push('- API source query (the string actually searched — pricecharting normalizes the title; a surprising count is read against THIS, not the raw product name):');
      for (const [id, q] of Object.entries(s.apiQueryBySource)) {
        lines.push(`  - \`${id}\` q="${q.query}"${q.url ? ` → ${q.url}` : ''}`);
      }
    }
    if (s.blocked > 0) {
      lines.push('- _(anti-bot-blocked sources contribute 0 comps until solved via the card\'s Solve button — see the resolve stage / Recent Logs)_');
    }
    if (loginRequired > 0) {
      lines.push('- _(not-logged-in source(s) returned 0 from a login wall / anonymous page — NOT a stale-selectors bug. Log in to the platform in Settings > Accounts and retry.)_');
    }
    if (timedOut > 0) {
      lines.push('- _(timed-out source(s) = the page navigation never finished within the budget (usually bodyLen=0 — nothing loaded). A slow/hung site or an anti-bot tarpit, NOT a browser/profile-lock conflict. If the platform is not logged in, an anonymous request is likelier to be tarpitted — log in and retry.)_');
    }
    if (errored > 0) {
      lines.push('- _(scrape error(s) = the scrape threw before completing — e.g. a browser-launch/profile-lock conflict or network failure, NOT an anti-bot wall. A visible window opened mid-scrape can race the headless profile lock. See Recent Logs.)_');
    }
  }

  if (hasResolves) {
    // One line per resolved source (newest first) so a multi-source recovery
    // — e.g. Mercari then eBay — shows every resolve, not just the last.
    const entries = Object.entries(t.resolves).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    lines.push('\n### Captcha-resolve / Solve');
    for (const [sourceId, r] of entries) {
      // `via` distinguishes how the items reached the pricing set: 'inline' =
      // pulled directly from the visible captcha-resolve session; 'rescrape' =
      // inline came back empty and a headless rescrape recovered them. Reporting
      // the rescrape count (not the inline 0) is what keeps a successful recovery
      // from looking like a failure.
      const line = r.via === 'rescrape'
        ? `- \`${sourceId}\`${ago(r.ts)}: rescraped ${r.extracted} ${r.category} comp(s) into the pricing set (inline extract failed; recovered via headless rescrape)`
        : `- \`${sourceId}\`${ago(r.ts)}: inline-extracted ${r.extracted} ${r.category} comp(s) merged into the pricing set`;
      lines.push(line + (r.extracted === 0 ? ' ⚠️ recovered 0 — source contributed nothing to pricing' : ''));
    }
  }

  if (t.synthesis) {
    const s = t.synthesis;
    lines.push(`\n### Price synthesis${ago(s.ts)}`);
    if (s.junkRejected > 0) {
      // Non-genuine listings dropped before pricing — reported so the rejection
      // is transparent (and so a spike signals a new junk pattern to filter).
      // Two classes today (see filterJunkComps): accessories FOR the item (cases,
      // chargers, screen protectors — the bulk, esp. from Poshmark) and eBay
      // internal test listings. Keep the description in sync with the filter so
      // the example never contradicts the explanation.
      lines.push(`- 🧹 Rejected ${s.junkRejected} non-genuine listing(s) before pricing${s.junkExample ? ` (e.g. "${s.junkExample}")` : ''} — accessories for the item (cases/chargers/etc.) and eBay internal test listings, not real comps.`);
    }
    if (s.soldFound + s.activeFound === 0) {
      lines.push('- ⚠️ 0 comps available → no price synthesized (all sources empty or blocked).');
    } else {
      const capped = s.soldFound > s.soldUsed || s.activeFound > s.activeUsed;
      lines.push(
        `- Comps fed to the model: ${s.soldUsed}/${s.soldFound} sold + ${s.activeUsed}/${s.activeFound} active` +
        (capped ? ' _(capped at the top 25 sold / 15 active by title-match — by-design, not lost data)_' : ''),
      );
      // Found vs. unique — a gap means an extractor emitted the same listing
      // multiple times, so the "found"/"used" totals overstate the real signal
      // the model saw (duplicates aren't lost data, they're phantom data).
      const soldDup = s.soldUnique != null ? s.soldFound - s.soldUnique : 0;
      const activeDup = s.activeUnique != null ? s.activeFound - s.activeUnique : 0;
      if (soldDup > 0 || activeDup > 0) {
        lines.push(
          `- ⚠️ Duplicate comps: only **${s.soldUnique} unique** of ${s.soldFound} sold` +
          ` and **${s.activeUnique} unique** of ${s.activeFound} active — an extractor is double-counting listings, inflating the set fed to pricing (check Per-source counts above to find which).`,
        );
      } else if (s.soldUnique != null) {
        lines.push(`- All ${s.soldFound} sold / ${s.activeFound} active comps are distinct (no duplicate inflation).`);
      }
      // Price band of the comps actually fed to pricing — OUR independently
      // computed min/median/max (priceStats), distinct from the model's
      // self-reported market summary further down. Rendered EVERY run: the
      // kept/dropped verdict block below only prints when the budget cap actually
      // dropped comps, so an uncapped run (the common single-source scoped-test
      // case — all found comps fed) would otherwise show NO price distribution at
      // all. That left two things broken: the recommended price was uncheckable
      // against the real comps (only the model's own floor was shown — the very
      // number under suspicion), and the "verify against the kept band above"
      // hint on a thin anchor pointed at a band that wasn't there. Stats are
      // stamped on every synthesis, so this is a pure render fix, no new capture.
      const band = (st) => st ? `$${st.min}–$${st.max} (median $${st.median}, n=${st.n})` : null;
      const soldBand = band(s.soldKeptStats);
      const activeBand = band(s.activeKeptStats);
      if (soldBand || activeBand) {
        lines.push(
          `- Price band fed to pricing (our computed stats): ` +
          [soldBand && `${soldBand} sold`, activeBand && `${activeBand} active`].filter(Boolean).join(' · '),
        );
      }
      // What the cap actually dropped — the evidence behind "by-design, not lost
      // data." dropBandVerdict compares the dropped slice's median to the kept
      // band to say whether the drop SKEWED the price (and which way) vs. dropped
      // a representative sample (price unaffected) vs. cheap noise (cap working).
      if (capped) {
        const fmt = (st) => st ? `$${st.min}–$${st.max} (median $${st.median})` : '—';
        if (s.soldDroppedStats) {
          lines.push(
            `- Dropped ${s.soldDroppedStats.n} sold ${fmt(s.soldDroppedStats)}; kept ${fmt(s.soldKeptStats)}.` +
            dropBandVerdict(s.soldKeptStats, s.soldDroppedStats, s.soldKeptScore, s.soldDroppedScore),
          );
        }
        if (s.activeDroppedStats) {
          lines.push(
            `- Dropped ${s.activeDroppedStats.n} active ${fmt(s.activeDroppedStats)}; kept ${fmt(s.activeKeptStats)}.` +
            dropBandVerdict(s.activeKeptStats, s.activeDroppedStats, s.activeKeptScore, s.activeDroppedScore),
          );
        }
        // Per-source composition of the sold kept/dropped split — exposes a
        // source monopoly (one source filling the cap while a better one is
        // dropped) that the price-band lines alone can't show. The round-robin
        // selection should keep this balanced; a lopsided split is the tell.
        const bySrc = (m) => m && Object.keys(m).length
          ? Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')
          : '—';
        if (s.soldKeptBySource || s.soldDroppedBySource) {
          lines.push(`- Sold by source — kept: ${bySrc(s.soldKeptBySource)} · dropped: ${bySrc(s.soldDroppedBySource)}`);
        }
        // Wrong-product detector: a kept source whose comps barely match the
        // query (median match score collapsed to ~brand-only, well below the
        // overall kept score) returned off-target results — e.g. Swappa serving
        // Apple Vision Pro for an iPhone XS query. Round-robin selection forces
        // each source's "best" in even when that best is the wrong item, so this
        // junk reaches pricing silently unless named here.
        if (s.soldKeptScoreBySource && s.soldKeptScore > 0) {
          const offenders = Object.entries(s.soldKeptScoreBySource)
            .filter(([src, sc]) => sc != null && sc < s.soldKeptScore * 0.5 && (s.soldKeptBySource?.[src] || 0) >= 2)
            .sort((a, b) => a[1] - b[1])
            .map(([src, sc]) => `${src} (median match ${sc} vs overall ${s.soldKeptScore}, ${s.soldKeptBySource[src]} kept)`);
          if (offenders.length) {
            lines.push(`- ⚠️ Off-target source(s) in the priced set: ${offenders.join('; ')} — these kept comps barely match the query (likely wrong-product results), polluting the pricing input. Their prices skew the kept band above.`);
          }
        }
      }
      lines.push(`- Result: recommended_price=${s.recommendedPrice == null ? '**null** ⚠️ (comps scraped but no price produced)' : '$' + s.recommendedPrice}, match_quality=${s.matchQuality}${modelTag(s.model, s.fallback)}`);
      // Sanity flag: recommendation above the highest ACTUAL sold comp (see helper).
      const overPriced = overPricedSoldFlag(s.recommendedPrice, s.soldKeptStats, s.activeKeptStats);
      if (overPriced) lines.push(`- ⚠️ ${overPriced}`);
      // The model's own anchor/adjusted/bound split — the LAST place a comp can
      // be dropped (the model weighting it out). The found→fed cap is reported
      // above; this is the fed→actually-weighted gap. classified ≪ fed is normal
      // (the model ignores off-spec listings), but a tiny anchor count on a big
      // fed set is the tell that the price leans on very few real matches.
      if (s.compBreakdown) {
        const cb = s.compBreakdown;
        // Guard a malformed breakdown: the model occasionally fumbles this nested
        // object (leaks the inner counts / tool-call XML instead of nesting them),
        // so cb arrives as a string or with non-numeric counts. claude.js repairs
        // it, but if a malformed one still reaches here, say so — don't render the
        // misleading "0 anchor + 0 adjusted + 0 bound … thin anchor base" that a
        // raw `|| 0` would produce (the model DID classify; the shape was broken).
        const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
        const wellFormed = cb && typeof cb === 'object' && !Array.isArray(cb) &&
          (isNum(cb.anchor_count) || isNum(cb.adjusted_count) || isNum(cb.bound_count));
        if (!wellFormed) {
          lines.push(`- ⚠️ Model weighting unavailable — comp_breakdown came back malformed (${JSON.stringify(cb).slice(0, 80)}). The model's anchor/adjusted/bound split couldn't be read (structured-output shape error); the price itself is unaffected.`);
        } else {
          const anchor = cb.anchor_count || 0, adjusted = cb.adjusted_count || 0, bound = cb.bound_count || 0;
          const classified = anchor + adjusted + bound;
          const fed = (s.soldUsed || 0) + (s.activeUsed || 0);
          lines.push(
            `- Model weighting: ${anchor} anchor + ${adjusted} adjusted + ${bound} bound = ${classified} of ${fed} fed classified` +
            (classified < fed
              ? ` — the model weighted out the other ${fed - classified} as off-spec. The price leans on ${anchor} exact-match anchor listing(s)${anchor <= 2 ? ' ⚠️ (thin anchor base — verify against the kept band above)' : ''}.`
              : '.'),
          );
        }
      }
      // Model's own market summary — its internal tally of what it counted as
      // genuine comps (after its own classification). The fed→model-counted gap
      // is the last invisible drop: we feed N active but the model may count 0
      // if it judged them all as accessories/parts. Flag when active_count=0
      // despite activeUsed>0 so that's visible rather than a mystery.
      if (s.marketSummary) {
        const ms = s.marketSummary;
        const msActive = ms.active_count ?? null;
        const msSold = ms.sold_count ?? null;
        const soldPrices = (ms.sold_low != null && ms.sold_high != null)
          ? ` ($${ms.sold_low}–$${ms.sold_high}, median $${ms.sold_median ?? '?'})`
          : '';
        const activeFloor = ms.active_lowest != null ? ` (floor $${ms.active_lowest})` : '';
        const activeGap = msActive === 0 && (s.activeUsed || 0) > 0;
        const soldGap = msSold != null && msSold < (s.soldUsed || 0) * 0.5 && (s.soldUsed || 0) > 4;
        lines.push(
          `- Model's own market summary: ${msSold ?? '?'} sold${soldPrices} · ${msActive ?? '?'} active${activeFloor}` +
          (activeGap ? ` ⚠️ model counted 0 active despite ${s.activeUsed} being fed — model classified them all as off-spec (accessories/parts/wrong-product)` : '') +
          (soldGap ? ` ⚠️ model counted only ${msSold} sold of ${s.soldUsed} fed — most were classified as off-spec` : ''),
        );
      }
    }
  }

  if (t.fit) {
    const f = t.fit;
    lines.push(`\n### Platform fit${ago(f.ts)}`);
    lines.push(`- ${f.platforms} platform(s) → ${f.good} good / ${f.unfit} unfit${modelTag(f.model, f.fallback)}`);
  }

  return `
## Marketplace Pipeline
${scope.note}> Last sell-side run's funnel (photo analysis → comp scrape → price synthesis →
> platform fit), captured in the main process so it survives SellHub deletion
> and log-buffer scroll — the sell-side analog of the Job Search Pipeline. The
> "found → fed to the model" gap in synthesis answers "did we use all the comps
> we found?": the top-25/15 cap is by-design; blocked sources, a null price, and
> a found≫unique gap (an extractor double-counting) are not. Per-source raw
> counts + the unique line localize a silent inflation; anti-bot blocks and
> internal scrape errors are reported separately (a browser-launch/profile-lock
> race is NOT a captcha). "Model's own market summary" is the final funnel step:
> active_count=0 despite N fed means the model classified every active listing as
> off-spec (accessories/parts). Each stage stamps independently (resolve/rescrape alone).

${lines.join('\n')}
`;
}
