import { createHash } from 'node:crypto';
import { sanitizeJobSearchDateDiagnostics } from '../../../src/utils/jobSearchDateDiagnostics.js';
import { normalizeSourceCoverage, normalizeSourceQueryProgress } from '../../../src/utils/jobSearchSourceCoverage.js';
import { completionTimestampIso } from '../../../src/utils/completionTimestamp.js';

function identifier(value) {
  return typeof value === 'string' && value
    ? `#${createHash('sha256').update(value).digest('hex').slice(0, 10)}`
    : 'not recorded';
}

function timestamp(value) {
  return completionTimestampIso(value) || 'not recorded';
}

// Saved node receipts are diagnostic observations, never an input to the
// search-window policy. Traverse nested canvases without retaining any source
// documents, listing rows, input text, or raw identifiers in the report.
export function buildJobSearchDateHistory(nodes) {
  const lines = ['\n## Job Search Date History (JOBDATES)',
    '> Latest eight date decisions per module, newest first. Saved module metadata survives Clear Scrape and workspace save/reopen; this live snapshot does not prove a disk save. Terminal collection evidence is reported separately in Job Recovery Diagnostics. Missing older evidence cannot be reconstructed. Dates and fixed reason codes only; run and hub IDs are one-way digests.'];
  const pending = [nodes];
  const visited = new WeakSet();
  const seenHubs = new Set();
  let scanned = 0;
  let hubs = 0;
  let truncated = false;
  while (pending.length && scanned < 20_000 && hubs < 1000) {
    const level = pending.pop();
    if (!Array.isArray(level) || visited.has(level)) continue;
    visited.add(level);
    for (const node of level) {
      if (scanned++ >= 20_000 || hubs >= 1000) { truncated = true; break; }
      if (Array.isArray(node?.data?.canvasData?.nodes)) pending.push(node.data.canvasData.nodes);
      if (node?.type !== 'jobhub') continue;
      if (typeof node.id === 'string' && seenHubs.has(node.id)) continue;
      if (typeof node.id === 'string') seenHubs.add(node.id);
      hubs++;
      const data = node.data || {};
      lines.push(`- Hub \`${identifier(node.id)}\` · current last scraped ${timestamp(data.lastCompletedRunAt)} · current coverage start ${timestamp(data.lastSearchCoverageStartedAt)}.`);
      const history = sanitizeJobSearchDateDiagnostics(data.jobSearchDateDiagnostics);
      // Per-platform bookmarks are what tells a partial run from a complete
      // one: each platform id is a fixed public name, so the ids themselves are
      // safe to print alongside their dates.
      const sourceCoverage = normalizeSourceCoverage(data.sourceCoverage);
      const coverageSourceIds = Object.keys(sourceCoverage).sort();
      if (coverageSourceIds.length) {
        lines.push(`  - Per-platform bookmarks: ${coverageSourceIds
          .map(sourceId => `${sourceId} coverage start ${timestamp(sourceCoverage[sourceId].coverageStartedAt)} · completed ${timestamp(sourceCoverage[sourceId].completedAt)}`)
          .join('; ')}.`);
      }
      // Why a held-back platform's date has not moved, and how close it is:
      // counts and dates only, never the query text.
      const queryProgress = normalizeSourceQueryProgress(data.sourceQueryProgress);
      const progressSourceIds = Object.keys(queryProgress).sort();
      if (progressSourceIds.length) {
        lines.push(`  - Queries finished by blocked runs (skipped next run): ${progressSourceIds
          .map(sourceId => `${sourceId} ${queryProgress[sourceId].finishedQueries.length} finished · oldest run start ${timestamp(queryProgress[sourceId].oldestStartedAt)} · ${
            queryProgress[sourceId].bookmarkAt === (sourceCoverage[sourceId]?.coverageStartedAt ?? null) ? 'current' : 'stale (date has moved)'}`)
          .join('; ')}.`);
      }
      if (!history.length) {
        lines.push('  - Date decisions: not retained — older or missing diagnostics do not establish why this date was kept.');
        continue;
      }
      for (const entry of [...history].reverse()) {
        lines.push(`  - ${timestamp(entry.recordedAt)} · \`${entry.event}\` · reason \`${entry.reason}\` · run \`${identifier(entry.runId)}\` · last scraped ${timestamp(entry.previousCompletedAt)} → ${timestamp(entry.nextCompletedAt)} · coverage start ${timestamp(entry.previousCoverageStartedAt)} → ${timestamp(entry.nextCoverageStartedAt)}.`);
        if (entry.event !== 'clear') {
          lines.push(`    - Collection: \`${entry.collectionDisposition}\` · started ${timestamp(entry.collectionStartedAt)} · completed ${timestamp(entry.collectionCompletedAt)}.`);
        }
      }
    }
  }
  if (!hubs) lines.push('- No Job Search module metadata was available in this report.');
  if (truncated || pending.length) lines.push('- Scan truncated at the diagnostic node/module limit.');
  return lines.join('\n') + '\n';
}
