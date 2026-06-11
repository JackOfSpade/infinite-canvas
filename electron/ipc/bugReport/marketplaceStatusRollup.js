/**
 * Compact aggregate of every marketplace listing card's LAST status check, so
 * "did the status check go smoothly?" is answerable at a glance without scanning
 * the ~60 per-card rows in Node Diagnostics — which, being verbose and uncapped,
 * are exactly what blows the clipboard char budget and truncates the event log /
 * logs out of the report. The caller renders this EARLY (before the node table),
 * so it survives that truncation.
 *
 * The decisive signal it surfaces is `listing-err→watch`: the listing's OWN page
 * check errored but a platform-watch verdict carried the card to a correct final
 * status. That's a right answer riding a fallback — a systematically failing
 * direct check (e.g. eBay item pages erroring under rate-limit) that a per-card
 * glance misses because the final status looks fine. The WHY of each error now
 * lives in that card's `checkTrace … listing=error (reason)`.
 *
 * Pure (no electron / IO imports) so it's unit-testable in the plain-node runner.
 * Returns '' when the canvas has no marketplace cards.
 */
const STATES = ['live', 'sold', 'ended', 'needs-login', 'unknown', 'error'];

function formatAge(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  const h = Math.floor(s / 3600);
  const mn = Math.floor((s % 3600) / 60);
  return h ? `${h}h${mn}m ago` : `${mn}m ago`;
}

export function buildMarketplaceStatusRollup(nodes) {
  const cards = [];
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node) continue;
      if (node.type === 'marketplacecard' && node.data?.platformId) cards.push(node.data);
      const inner = node.data?.canvasData?.nodes; // grouped sub-canvases (see collectMarketplaceListings)
      if (Array.isArray(inner) && inner.length) visit(inner);
    }
  };
  visit(nodes);
  if (cards.length === 0) return '';

  const perPlatform = new Map(); // platformId → { total, byState{}, rescued }
  const rescuedByPlatform = new Map();
  const needsLoginByPlatform = new Map();
  const unknownByPlatform = new Map();
  const tally = (m, key) => m.set(key, (m.get(key) || 0) + 1);
  let mostRecent = 0;

  for (const d of cards) {
    const platform = d.platformId;
    let p = perPlatform.get(platform);
    if (!p) { p = { total: 0, byState: {}, rescued: 0 }; perPlatform.set(platform, p); }
    p.total += 1;
    const state = STATES.includes(d.status) ? d.status : 'unknown';
    p.byState[state] = (p.byState[state] || 0) + 1;
    if (state === 'needs-login') tally(needsLoginByPlatform, platform);
    if (state === 'unknown') tally(unknownByPlatform, platform);
    // listing-err→watch: the listing's own-page source errored, yet the card
    // reached a definite live/sold/ended — a platform-watch verdict carried it.
    const srcs = Array.isArray(d.lastCheckTrace?.sources) ? d.lastCheckTrace.sources : [];
    const listingErrored = srcs.some(s => s.label === 'listing' && s.status === 'error');
    if (listingErrored && (state === 'live' || state === 'sold' || state === 'ended')) {
      p.rescued += 1;
      tally(rescuedByPlatform, platform);
    }
    const t = d.lastChecked ? new Date(d.lastChecked).getTime() : 0;
    if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
  }

  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const totalRescued = sum(rescuedByPlatform);
  const totalNeedsLogin = sum(needsLoginByPlatform);
  const totalUnknown = sum(unknownByPlatform);
  const totalErr = cards.filter(d => d.status === 'error').length;
  const fmtBreakdown = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ');

  const lines = [
    `- ${cards.length} listing card(s) across ${perPlatform.size} platform(s) · most recent check ${formatAge(mostRecent)}`,
  ];
  if (totalRescued > 0) {
    lines.push(`- ⚠️ ${totalRescued} card(s) had the **listing-page check error, rescued by a platform-watch** (${fmtBreakdown(rescuedByPlatform)}) — correct final status on a fallback; the direct check is failing. See each card's \`checkTrace … listing=error (reason)\` for the cause.`);
  }
  if (totalNeedsLogin > 0) lines.push(`- ⚠️ ${totalNeedsLogin} needs-login (${fmtBreakdown(needsLoginByPlatform)}) — a transient verify timeout no longer flips a connected session here (verifySellMonitorLogin \`inconclusive\`), so a remaining one is a real logout.`);
  if (totalUnknown > 0) lines.push(`- ${totalUnknown} unknown (${fmtBreakdown(unknownByPlatform)}) — e.g. a Facebook HTTP-400 listing with no watch match (ambiguous by design).`);
  if (totalRescued === 0 && totalNeedsLogin === 0 && totalErr === 0) lines.push('- ✅ No errored, rescued, or needs-login cards — every listing resolved cleanly.');

  const header = ['Platform', 'Cards', ...STATES, 'listing-err→watch'];
  const sep = header.map(() => '---');
  const rows = [...perPlatform.entries()].sort((a, b) => b[1].total - a[1].total).map(([id, p]) =>
    `| ${id} | ${p.total} | ${STATES.map(s => p.byState[s] || 0).join(' | ')} | ${p.rescued} |`);

  return `
## Marketplace Status Roll-up
> Aggregate of every marketplacecard's LAST status check — answers "did the
> status check go smoothly?" without scanning the per-card Node Diagnostics rows
> (verbose + uncapped, so they truncate first). \`listing-err→watch\` = the
> listing's own-page check errored but a platform-watch verdict carried the card:
> a correct status riding a fallback, i.e. a systematically failing direct check.

${lines.join('\n')}

| ${header.join(' | ')} |
| ${sep.join(' | ')} |
${rows.join('\n')}
`;
}
