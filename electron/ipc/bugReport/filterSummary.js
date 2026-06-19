function codeIncludesFull(filterCode) {
  return String(filterCode || '')
    .trim()
    .toUpperCase()
    .split(/[+\s,]+/)
    .includes('FULL');
}

function cleanInlineCode(value) {
  return String(value || '').replace(/`/g, "'");
}

export function buildFilterSummaryMarkdown(payload = {}) {
  const filterCode = String(payload.filterCode || '').trim();
  if (!filterCode) return '';

  const stats = payload.filterStats && typeof payload.filterStats === 'object'
    ? payload.filterStats
    : null;
  const omittedSections = Array.isArray(stats?.omittedSections)
    ? stats.omittedSections.filter(Boolean)
    : [];
  const isFull = codeIncludesFull(filterCode);

  const detailParts = [];
  if (stats) {
    const shown = Number(stats.eventsShown);
    const total = Number(stats.eventsTotal);
    if (Number.isFinite(shown) && Number.isFinite(total)) {
      detailParts.push(shown < total
        ? `event log trimmed to ${shown} of ${total} line(s) (matched categories + nearby context)`
        : `event log kept all ${total} line(s)`);
    }
    if (omittedSections.length > 0) {
      detailParts.push(`sections omitted: ${omittedSections.join(', ')}`);
    }
  }

  let guidance;
  if (isFull && omittedSections.length > 0) {
    guidance = 'FULL was combined with section exclusions; the event log is unfiltered. Use plain `FULL` or Save to file if omitted sections matter.';
  } else if (isFull) {
    guidance = 'Full report requested — no filter-code event/section reduction was applied. Clipboard export may still truncate to fit the clipboard cap; use Save to file for the uncapped report.';
  } else if (stats && Number(stats.eventsShown) === Number(stats.eventsTotal) && omittedSections.length === 0) {
    guidance = 'Filter code applied, but it did not remove any currently captured event lines.';
  } else {
    guidance = 'This is a filtered view — events or sections outside the selected codes may be omitted. Use `FULL` if the timeline looks incomplete.';
  }

  const detail = detailParts.length > 0 ? ` — ${detailParts.join('; ')}.` : '.';
  return `\n**Filter code applied:** \`${cleanInlineCode(filterCode)}\`${detail}\n*${guidance}*`;
}
