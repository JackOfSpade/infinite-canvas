/**
 * Compact view of every Marketplace Status MODULE node's OWN last hub-scan
 * (`marketplacestatus` node → `data.platformStatus`). This answers "did
 * pressing Check Status complete, and what did each platform's notification hub
 * return?" — which is invisible everywhere else in the report: the Node
 * Diagnostics preview has no `platformStatus` branch (the module row reads blank),
 * and the per-card "Marketplace Status Roll-up" is a DIFFERENT thing (per-listing
 * checks, often hours stale). Rendered EARLY so it survives clipboard truncation.
 *
 * Per platform it shows: read status (ok / needs-login / error / unknown), how
 * long ago it was checked (a recent age proves the check actually just ran vs a
 * persisted morning result), attention counts split high-vs-total (the same
 * urgency split the UI uses), the read/unread message count (`r/u`) the scan
 * saw, how many hub pages were read vs errored, and the AI summary line. Below
 * the table it lists each platform's actual flagged items (headline + verbatim
 * evidence, high-urgency first) so a "wrong item flagged" report — e.g. an
 * already-read message surfaced as action-needed — is debuggable without the
 * user pasting page HTML. The decisive "did it complete cleanly?" signals are
 * bubbled into the headline: any needs-login / error status, or a hub page that
 * errored (`sources … status:error`) means the AI scan ran on incomplete input.
 *
 * Pure (no electron / IO imports) so it's unit-testable in the plain-node runner.
 * Returns '' when the canvas has no marketplacestatus node with results.
 */
import { formatAge } from './helpers.js';

export function buildMarketplaceModuleRollup(nodes) {
  // Collect every marketplacestatus node's platformStatus, recursing into
  // grouped sub-canvases (a module can live inside a CanvasNode group).
  const modules = []; // { nodeId, platformStatus }
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node) continue;
      if (node.type === 'marketplacestatus' && node.data?.platformStatus && typeof node.data.platformStatus === 'object') {
        modules.push({ nodeId: node.id, platformStatus: node.data.platformStatus });
      }
      const inner = node.data?.canvasData?.nodes;
      if (Array.isArray(inner) && inner.length) visit(inner);
    }
  };
  visit(nodes);

  // Flatten to one row per (module, platform). Prefix the platform with a short
  // node id only when more than one module node exists, to keep the common
  // single-module case clean.
  const multi = modules.length > 1;
  const rows = [];
  const detailBlocks = []; // per-platform flagged-item detail (the "which item & why")
  let mostRecent = 0;
  let needsLogin = 0;
  let errored = 0;
  let sourcesErrored = 0;
  let totalHigh = 0;
  let anyReadState = false; // did any hub carry a message read/unread signal?

  for (const m of modules) {
    for (const [platformId, r] of Object.entries(m.platformStatus)) {
      if (!r || typeof r !== 'object') continue;
      const status = r.status || 'unknown';
      const attention = Array.isArray(r.attention) ? r.attention : [];
      const high = attention.filter(a => a?.urgency === 'high').length;
      const sources = Array.isArray(r.sources) ? r.sources : [];
      const srcErr = sources.filter(s => s?.status === 'error').length;
      const ts = r.lastChecked ? new Date(r.lastChecked).getTime() : 0;
      const rs = r.readState && typeof r.readState === 'object' ? r.readState : null;
      const rsRead = Number(rs?.read) || 0;
      const rsUnread = Number(rs?.unread) || 0;
      if (rsRead || rsUnread) anyReadState = true;
      if (Number.isFinite(ts) && ts > mostRecent) mostRecent = ts;
      if (status === 'needs-login') needsLogin += 1;
      if (status === 'error') errored += 1;
      if (srcErr > 0) sourcesErrored += 1;
      totalHigh += high;

      const label = `${multi ? `${String(m.nodeId).slice(0, 6)}/` : ''}${platformId}`;
      const readCol = rsRead || rsUnread ? `${rsRead}r/${rsUnread}u` : '—';
      // Escape the markdown table delimiter — `summary` is free-form AI text
      // (often a quoted buyer message) that can contain a literal `|`.
      const summary = (r.summary || r.message || '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/\|/g, '\\|');
      rows.push(
        `| ${label} | ${status} | ${Number.isFinite(ts) && ts ? formatAge(ts) : 'never'} | ${attention.length} (${high}) | ${readCol} | ${sources.length} (${srcErr}) | ${summary || '—'} |`,
      );

      // Per-platform flagged-item detail — the headline + verbatim evidence the
      // model produced, so a "wrong item flagged" report (e.g. an already-read
      // message surfaced as action-needed) is debuggable without the user
      // pasting page HTML. High-urgency first; capped to keep the section bounded.
      if (attention.length > 0) {
        const ordered = [...attention].sort((a, b) => (b?.urgency === 'high' ? 1 : 0) - (a?.urgency === 'high' ? 1 : 0));
        const CAP = 6;
        const itemLines = ordered.slice(0, CAP).map((a) => {
          const urgency = a?.urgency === 'high' ? '🔴 high' : '⚪ low';
          const cat = a?.category ? ` ${String(a.category).replace(/\s+/g, ' ').trim().slice(0, 24)}` : '';
          const headline = String(a?.headline || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const evidence = String(a?.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 140);
          return `  - ${urgency}${cat} — ${headline || '(no headline)'}${evidence ? ` · evidence: “${evidence}”` : ''}`;
        });
        if (ordered.length > CAP) itemLines.push(`  - …and ${ordered.length - CAP} more item(s)`);
        detailBlocks.push(`- **${label}**${rsRead || rsUnread ? ` _(${rsRead} read / ${rsUnread} unread message(s) detected)_` : ''}:\n${itemLines.join('\n')}`);
      }
    }
  }

  if (rows.length === 0) return '';

  const lines = [
    `- ${modules.length} module node(s) · ${rows.length} platform result(s) · most recent check ${formatAge(mostRecent)}`,
  ];
  if (needsLogin > 0) lines.push(`- ⚠️ ${needsLogin} platform(s) read **needs-login** — the hub scan was skipped there; user must re-login in Settings → Marketplace Login.`);
  if (errored > 0) lines.push(`- ⚠️ ${errored} platform(s) read **error** — could not read the hub pages at all.`);
  if (sourcesErrored > 0) lines.push(`- ⚠️ ${sourcesErrored} platform(s) had a hub page **error** (AI scan ran on incomplete input — see Sources (err) column).`);
  if (needsLogin === 0 && errored === 0 && sourcesErrored === 0) lines.push(`- ✅ Every checked platform read its hub cleanly${totalHigh > 0 ? ` (${totalHigh} high-urgency action item(s) flagged)` : ''}.`);
  if (anyReadState) lines.push(`- 📨 Message read-state was detected (\`r/u\` column = read/unread conversations on the hub page(s)). An already-read message should NOT be flagged high-urgency — if one is, check the flagged-item evidence below.`);

  const detailSection = detailBlocks.length > 0
    ? `\n\n**Flagged items** _(headline + verbatim evidence per platform — high-urgency first):_\n${detailBlocks.join('\n')}`
    : '';

  return `
## Marketplace Status Module
> Each \`marketplacestatus\` node's OWN last hub-scan (\`data.platformStatus\`) —
> "did Check Status complete, and what did each platform's hub return?". Distinct
> from the per-card "Marketplace Status Roll-up" (that's per-listing checks). The
> Node Diagnostics row for this node shows no platformStatus, so this is the only
> place it appears. \`Checked\` age proves whether the result is from a check that
> just ran or a persisted older one. \`Attention\` is total (high-urgency). \`r/u\`
> = read/unread message conversations the scan saw (a read message flagged
> high-urgency is a bug — see the flagged-item evidence below).

${lines.join('\n')}

| Platform | Status | Checked | Attention (high) | r/u | Sources (err) | Summary |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}${detailSection}
`;
}
