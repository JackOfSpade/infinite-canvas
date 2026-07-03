function shortId(id) {
  return String(id || '').slice(0, 8) || 'unknown';
}

function escapeCell(value) {
  return String(value ?? '-').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function productLabel(data = {}) {
  const product = data.product || {};
  return product.generated_title || product.title || product.model || product.brand || '(untitled)';
}

function summarizeSourceProgress(progress = {}) {
  const entries = Object.entries(progress || {});
  if (entries.length === 0) return '-';
  const important = entries.filter(([, v]) => {
    const status = v?.status;
    return status === 'searching' || status === 'error' || v?.warning || status === 'done';
  });
  return important
    .slice(0, 9)
    .map(([sourceId, v]) => {
      const count = v?.count ?? '?';
      const warning = v?.warning?.code ? `[${v.warning.code}]` : '';
      return `${sourceId}=${v?.status || '?'}/${count}${warning}`;
    })
    .join(', ') || '-';
}

export function buildSellHubResolveSnapshot(nodes = [], nodeStates = []) {
  const dataById = new Map();
  for (const node of nodes || []) {
    if (node?.type === 'sellhub') dataById.set(node.id, node.data || {});
  }

  return (nodeStates || [])
    .filter(state => dataById.has(state?.id))
    .map(state => {
      const data = dataById.get(state.id) || {};
      const queued = Array.isArray(state.queuedResolveSourceIds) ? state.queuedResolveSourceIds : [];
      const active = Array.isArray(state.activeResolveSourceIds) ? state.activeResolveSourceIds : [];
      const workCount = Number(state.queuedResolvesCount) || queued.length + active.length || 0;
      return {
        id: state.id,
        title: productLabel(data),
        hubState: data.hubState || state.hubState || 'empty',
        isApplyingResolves: state.isApplyingResolves === true,
        workCount,
        resolveQueueWait: Number(state.resolveQueueWait) || 0,
        activeSources: active,
        queuedSources: queued,
        progressSummary: summarizeSourceProgress(state.compProgress),
      };
    })
    .filter(row => row.isApplyingResolves || row.workCount > 0 || row.resolveQueueWait > 0);
}

export function buildSellHubResolveRollup(resolveStates = []) {
  if (!Array.isArray(resolveStates) || resolveStates.length === 0) return '';

  const rows = resolveStates.map(row => {
    const phase = row.isApplyingResolves ? 'applying' : 'queued';
    const wait = row.resolveQueueWait > 0
      ? `behind ${row.resolveQueueWait} browser op${row.resolveQueueWait === 1 ? '' : 's'}`
      : '-';
    const active = row.activeSources?.length ? row.activeSources.join(',') : '-';
    const queued = row.queuedSources?.length ? row.queuedSources.join(',') : '-';
    return `| \`${shortId(row.id)}\` | ${escapeCell(row.title).slice(0, 70)} | ${escapeCell(row.hubState)} | ${phase} * ${row.workCount} | ${escapeCell(wait)} | ${escapeCell(active)} | ${escapeCell(queued)} | ${escapeCell(row.progressSummary).slice(0, 180)} |`;
  }).join('\n');

  return `
## SellHub Source Resolve Queue
> Compact renderer-side state for captcha/Solve results that are being merged
> back into SellHub comp data. This is intentionally outside the large Node
> Diagnostics table so clipboard-capped reports still show whether a hub is
> actually applying resolved sources, queued behind another browser operation,
> or displaying a stale busy message.

| Hub | Item | State | Resolve work | Browser wait | Active | Queued | Source progress |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}
`;
}
