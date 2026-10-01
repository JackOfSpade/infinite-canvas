import { reportCorrelationDigest, visitCanvasNodes } from './helpers.js';

function escapeCell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\s+/g, ' ').trim();
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '—';
  const rounded = Math.round(n * 100) / 100;
  return `$${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
}

function formatCadence(value) {
  const weeks = Number(value) || 0;
  return weeks > 0 ? `${weeks}wk` : 'off';
}

export function buildSellHubPriceDropRollup(nodes) {
  const hubs = [];
  const cardCounts = new Map();
  const dueCounts = new Map();

  visitCanvasNodes(nodes, (node) => {
    if (node.type === 'sellhub') hubs.push(node);
    if (node.type === 'marketplacecard' && node.data?.hubId) {
      const hubId = node.data.hubId;
      cardCounts.set(hubId, (cardCounts.get(hubId) || 0) + 1);
      if (node.data.priceDropReminderDue) dueCounts.set(hubId, (dueCounts.get(hubId) || 0) + 1);
    }
  });

  if (hubs.length === 0) return '';

  const planned = hubs.filter((node) => {
    const d = node.data || {};
    return Number(d.priceDropReminderWeeks) > 0
      || !!d.priceDropMustSellDate
      || d.priceDropTargetPrice != null
      || !!d.priceDropStartingTier
      || d.priceDropPlanStartingPrice != null
      || !!d.priceDropApplyAllExcluded;
  });
  if (planned.length === 0) return '';

  // One predicate set, read by both the canvas-wide tallies and the per-row
  // flag strings, so a row can never disagree with the summary above it.
  const planFlags = (d) => {
    const target = d.priceDropTargetPrice != null ? Number(d.priceDropTargetPrice) : null;
    const start = d.priceDropPlanStartingPrice != null ? Number(d.priceDropPlanStartingPrice) : null;
    return {
      target,
      start,
      isFree: target === 0,
      dateNoTarget: !!d.priceDropMustSellDate && target == null,
      targetTooHigh: target != null && Number.isFinite(target) && Number.isFinite(start) && target >= start,
    };
  };

  // Tally over EVERY planned hub, not just the rendered slice — these lines are
  // stated as canvas-wide counts, so computing them inside the truncated
  // slice(0, 30) below would silently under-report on a large canvas.
  let freeTargets = 0;
  let missingTarget = 0;
  let targetTooHigh = 0;
  for (const node of planned) {
    const f = planFlags(node.data || {});
    if (f.isFree) freeTargets += 1;
    if (f.dateNoTarget) missingTarget += 1;
    if (f.targetTooHigh) targetTooHigh += 1;
  }

  const rows = planned.slice(0, 30).map((node) => {
    const d = node.data || {};
    const { target, start, isFree, dateNoTarget, targetTooHigh: rowTargetTooHigh } = planFlags(d);

    const flags = [
      d.priceDropApplyAllExcluded ? 'apply-all excluded' : '',
      d.locked ? 'locked' : '',
      isFree ? 'free target' : '',
      dateNoTarget ? 'date without target' : '',
      rowTargetTooHigh ? 'target >= start' : '',
    ].filter(Boolean).join(', ') || '—';
    const cards = cardCounts.get(node.id) || 0;
    const due = dueCounts.get(node.id) || 0;
    const cardText = due > 0 ? `${cards} (${due} due)` : String(cards);

    return `| \`${reportCorrelationDigest(node.id)}\` | item correlation \`${reportCorrelationDigest(node.id)}\` | ${escapeCell(d.hubState || '—')} | ${formatCadence(d.priceDropReminderWeeks)} | ${escapeCell(d.priceDropMustSellDate || '—')} | ${formatMoney(target)} | ${formatMoney(start)} | ${escapeCell(d.priceDropStartingTier || '—')} | ${cardText} | ${escapeCell(flags)} |`;
  });

  const summary = [
    `- ${hubs.length} sell-hub node(s); ${planned.length} have price-drop plan state.`,
  ];
  if (freeTargets > 0) summary.push(`- ${freeTargets} plan(s) target **$0** — this is treated as a valid free-listing target, not as an empty value.`);
  if (missingTarget > 0) summary.push(`- ⚠️ ${missingTarget} plan(s) have a must-sell date without a target price, so the deadline plan is incomplete.`);
  if (targetTooHigh > 0) summary.push(`- ⚠️ ${targetTooHigh} plan(s) have a target at or above the starting price.`);
  if (planned.length > rows.length) summary.push(`- The table below shows the first ${rows.length} planned hub(s); ${planned.length - rows.length} more are omitted to keep the report compact. The counts above cover all ${planned.length}.`);

  return `
## SellHub Price-Drop Plans
> Compact per-item price-drop state from SellHub nodes. This section can answer
> whether a target price like \`$0\` was accepted and persisted.

${summary.join('\n')}

| Hub | Item | State | Cadence | Must sell | Target | Start | Tier | Cards | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}
