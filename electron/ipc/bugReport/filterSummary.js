export function codeIncludesFull(filterCode) {
  return String(filterCode || '')
    .trim()
    .toUpperCase()
    .split(/[+\s,]+/)
    .includes('FULL');
}

function codeIncludesApplicationOutput(filterCode) {
  const codes = String(filterCode || '')
    .trim()
    .toUpperCase()
    .split(/[+\s,]+/)
    .filter(Boolean);
  return codes.includes('APPOUTPUT');
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
  const includesApplicationOutput = codeIncludesApplicationOutput(filterCode);

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
    guidance = 'FULL was combined with section exclusions; all currently retained event lines are selected. The complete sanitized final application-output projection remains included while available; it never reads artifact paths or raw career source. Use plain `FULL` if omitted sections matter.';
  } else if (isFull) {
    guidance = 'All currently retained report sections and event lines are selected — no filter-code reduction was applied. The complete sanitized final application-output projection is included while available, so résumé and cover-letter quality can be reviewed; it never reads artifact paths or raw career source. Copy and Save to file use the same uncapped rendering policy and content scope; their separately generated snapshots can differ in timestamps or live state. Copy writes its snapshot to an app-managed file and clipboards a path pointer to it; Save to file opens a save dialog to a location you choose. This does not restore history from an earlier app process.';
  } else if (includesApplicationOutput) {
    guidance = 'APPOUTPUT selects the complete, sanitized final application-output projection still retained in this app process. It never reads artifact paths or raw career source.';
  } else if (stats && Number(stats.eventsShown) === Number(stats.eventsTotal) && omittedSections.length === 0) {
    guidance = 'Filter code applied, but it did not remove any currently captured event lines.';
  } else {
    guidance = 'This is a filtered view — events or sections outside the selected codes may be omitted. Use `FULL` if the timeline looks incomplete.';
  }

  const detail = detailParts.length > 0 ? ` — ${detailParts.join('; ')}.` : '.';
  return `\n**Filter code applied:** \`${cleanInlineCode(filterCode)}\`${detail}\n*${guidance}*`;
}
