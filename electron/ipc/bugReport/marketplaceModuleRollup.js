/**
 * Compact view of every Marketplace Status MODULE node's OWN last hub-scan
 * (`marketplacestatus` node → `data.platformStatus`). This answers "did
 * pressing Check All complete, and what did each platform's notification hub
 * return?" — which is invisible everywhere else in the report: the Node
 * Diagnostics preview has no `platformStatus` branch (the module row reads blank).
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
import { formatAge, visitCanvasNodes, clipReportText } from './helpers.js';

export function buildMarketplaceModuleRollup(nodes) {
  // Collect every marketplacestatus node's platformStatus, recursing into
  // grouped sub-canvases (a module can live inside a CanvasNode group).
  const modules = []; // { nodeId, platformStatus }
  visitCanvasNodes(nodes, (node) => {
    if (node.type === 'marketplacestatus' && node.data?.platformStatus && typeof node.data.platformStatus === 'object') {
      modules.push({ nodeId: node.id, platformStatus: node.data.platformStatus });
    }
  });

  // Flatten to one row per (module, platform). Prefix the platform with a short
  // node id only when more than one module node exists, to keep the common
  // single-module case clean.
  const multi = modules.length > 1;
  const rows = [];
  const detailBlocks = []; // per-platform flagged-item detail (the "which item & why")
  const blockedBlocks = []; // per-platform WHY each non-ok hub source failed
  let mostRecent = 0;
  let needsLogin = 0;
  let errored = 0;
  let sourcesErrored = 0;
  // Platforms that read OK overall but had at least one hub URL blocked
  // (logged-out / unreadable) — the masking case "any ok source wins" hides.
  let maskedBlocked = 0;
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
      // Distinct from srcErr: a needs-login / unknown SOURCE is an auth wall or
      // unreadable page, not a fetch/AI failure — conflating them would mislabel
      // the column. Only counts as "masked" when the platform itself read OK.
      const srcBlocked = sources.filter(s => s?.status === 'needs-login' || s?.status === 'unknown').length;
      const ts = r.lastChecked ? new Date(r.lastChecked).getTime() : 0;
      const rs = r.readState && typeof r.readState === 'object' ? r.readState : null;
      const rsRead = Number(rs?.read) || 0;
      const rsUnread = Number(rs?.unread) || 0;
      if (rsRead || rsUnread) anyReadState = true;
      if (Number.isFinite(ts) && ts > mostRecent) mostRecent = ts;
      if (status === 'needs-login') needsLogin += 1;
      if (status === 'error') errored += 1;
      if (srcErr > 0) sourcesErrored += 1;
      if (status === 'ok' && srcBlocked > 0) maskedBlocked += 1;
      totalHigh += high;

      const label = `${multi ? `${String(m.nodeId).slice(0, 6)}/` : ''}${platformId}`;
      const readCol = rsRead || rsUnread ? `${rsRead}r/${rsUnread}u` : '—';
      // Escape the markdown table delimiter — `summary` is free-form AI text
      // (often a quoted buyer message) that can contain a literal `|`.
      const summary = clipReportText((r.summary || r.message || '').replace(/\s+/g, ' ').trim(), 80).replace(/\|/g, '\\|');
      rows.push(
        `| ${label} | ${status} | ${Number.isFinite(ts) && ts ? formatAge(ts) : 'never'} | ${attention.length} (${high}) | ${readCol} | ${sources.length} (${srcErr}/${srcBlocked}) | ${summary || '—'} |`,
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
          const cat = a?.category ? ` ${clipReportText(String(a.category).replace(/\s+/g, ' ').trim(), 24)}` : '';
          const headline = clipReportText(String(a?.headline || '').replace(/\s+/g, ' ').trim(), 120);
          const evidence = clipReportText(String(a?.evidence || '').replace(/\s+/g, ' ').trim(), 140);
          // WHICH watch URL this flag came from. A "(no source — link is dead)" row is
          // itself the answer to "the link did not take me to source": the model's
          // claimed sourceUrl didn't match a scanned hub URL so it was dropped, OR the
          // flag came from a notifications/activity feed that no longer shows the item.
          const src = a?.sourceUrl
            ? ` · src: ${String(a.sourceUrl).replace(/\s+/g, '').slice(0, 140)}`
            : ' · src: (none — jump-to-source link is dead)';
          return `  - ${urgency}${cat} — ${headline || '(no headline)'}${evidence ? ` · evidence: “${evidence}”` : ''}${src}`;
        });
        if (ordered.length > CAP) itemLines.push(`  - …and ${ordered.length - CAP} more item(s)`);
        detailBlocks.push(`- **${label}**${rsRead || rsUnread ? ` _(${rsRead} read / ${rsUnread} unread message(s) detected)_` : ''}:\n${itemLines.join('\n')}`);
      }

      // Per-source block/error REASON detail — when any hub URL didn't read ok,
      // surface WHY (the disambiguate verdict: anti-bot wall vs login-gated vs
      // empty/degraded shell vs transient verify-inconclusive). The aggregate
      // Summary collapses all of these to "Could not read this platform's hub
      // pages" and the err/blk column is only a count, so without this a
      // "swappa/mercari read error" report can't tell a Cloudflare wall (retry)
      // from a client-rendered shell (unreadable headless) from a real logout
      // (re-login) — a distinction that otherwise lives only in the fast-rotating
      // main-process logs.
      // Reasons are deduped (5 identical Mercari shells → one line ×5).
      const problemSources = sources.filter(s => s?.status && s.status !== 'ok');
      if (problemSources.length > 0) {
        const byReason = new Map(); // `${status}::${reason}` → { status, reason, count }
        for (const s of problemSources) {
          const reason = clipReportText(String(s.message || s.warning || '(no reason captured)').replace(/\s+/g, ' ').trim(), 200);
          const key = `${s.status}::${reason}`;
          const prev = byReason.get(key);
          if (prev) prev.count += 1;
          else byReason.set(key, { status: s.status, reason, count: 1 });
        }
        const reasonLines = [...byReason.values()].map(({ status: st, reason, count }) =>
          `  - \`${st}\`${count > 1 ? ` ×${count}` : ''}: ${reason}`);
        const titleLines = problemSources
          .filter(s => s?.title || s?.finalUrl)
          .slice(0, 4)
          .map((s) => {
            const title = clipReportText(String(s.title || '').replace(/\s+/g, ' ').trim(), 120);
            const finalUrl = String(s.finalUrl || '').replace(/\s+/g, ' ').trim().slice(0, 160);
            const flags = [
              s.appleEventsDisabled ? 'apple-events-off' : '',
              s.loggedOut ? 'logged-out' : '',
              s.challenged ? 'challenge' : '',
            ].filter(Boolean).join(', ');
            return `  - trace: ${title ? `title="${title}"` : 'title=(not captured)'}${finalUrl ? ` · finalUrl=\`${finalUrl}\`` : ''}${flags ? ` · ${flags}` : ''}`;
          });
        blockedBlocks.push(`- **${label}** (overall: ${status}):\n${reasonLines.join('\n')}`);
        if (titleLines.length > 0) blockedBlocks[blockedBlocks.length - 1] += `\n${titleLines.join('\n')}`;
      }
    }
  }

  if (rows.length === 0) return '';

  const lines = [
    `- ${modules.length} module node(s) · ${rows.length} platform result(s) · most recent check ${formatAge(mostRecent)}`,
  ];
  if (needsLogin > 0) lines.push(`- ⚠️ ${needsLogin} platform(s) read **needs-login** — the hub scan was skipped there; user must re-login in Settings → Marketplace Login.`);
  if (errored > 0) lines.push(`- ⚠️ ${errored} platform(s) read **error** — could not read the hub pages at all.`);
  if (sourcesErrored > 0) lines.push(`- ⚠️ ${sourcesErrored} platform(s) had a hub page **error** (AI scan ran on incomplete input — see the \`err\` count in the Sources column).`);
  if (maskedBlocked > 0) lines.push(`- ⚠️ ${maskedBlocked} platform(s) read **ok** but had a hub URL **blocked** (logged-out / unreadable — see the \`blk\` count) — the platform looks clean because a sibling watch URL read fine, yet one of its hub URLs needs attention.`);
  if (needsLogin === 0 && errored === 0 && sourcesErrored === 0 && maskedBlocked === 0) lines.push(`- ✅ Every checked platform read its hub cleanly${totalHigh > 0 ? ` (${totalHigh} high-urgency action item(s) flagged)` : ''}.`);
  if (anyReadState) lines.push(`- 📨 Message read-state was detected (\`r/u\` column = read/unread conversations on the hub page(s)). An already-read message should NOT be flagged high-urgency — if one is, check the flagged-item evidence below.`);

  const detailSection = detailBlocks.length > 0
    ? `\n\n**Flagged items** _(headline + verbatim evidence per platform — high-urgency first):_\n${detailBlocks.join('\n')}`
    : '';

  const blockedSection = blockedBlocks.length > 0
    ? `\n\n**Blocked / unreadable hub sources** _(WHY each non-ok hub URL failed — anti-bot wall vs login-gated vs empty shell vs transient verify; the Summary collapses all of these):_\n${blockedBlocks.join('\n')}`
    : '';

  return `
## Marketplace Status Module
> Each \`marketplacestatus\` node's OWN last hub-scan (\`data.platformStatus\`) —
> "did Check All complete, and what did each platform's hub return?". The
> Node Diagnostics row for this node shows no platformStatus, so this is the only
> place it appears. \`Checked\` age proves whether the result is from a check that
> just ran or a persisted older one. \`Attention\` is total (high-urgency). \`r/u\`
> = read/unread message conversations the scan saw (a read message flagged
> high-urgency is a bug — see the flagged-item evidence below). \`Sources\` is
> \`total (err/blk)\`: err = a hub page that failed to fetch / AI-scan, blk = a
> hub URL that was logged-out or unreadable while a sibling read OK (so the
> platform reads clean but one watch URL still needs attention).

${lines.join('\n')}

| Platform | Status | Checked | Attention (high) | r/u | Sources (err/blk) | Summary |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}${detailSection}${blockedSection}
`;
}
