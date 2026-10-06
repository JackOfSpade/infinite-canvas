/**
 * Merge per-source scrape progress events into a UI progress state.
 *
 * Terminal completion events can omit fields carried by earlier progress
 * events, so warning/url (and the per-source count) stay sticky until an event
 * explicitly clears them. Keeping `count` sticky matches its siblings below and
 * prevents a status-only update from blanking a card that already showed "N jobs".
 *
 * `status` is assigned UNCONDITIONALLY, and that is deliberate: there is no
 * "never go back from terminal" rule here, because re-entering 'searching'
 * after a terminal event on the SAME sourceId and the same card is real,
 * shipping behaviour —
 *   - electron/ipc/jobs.js (mid-run LinkedIn description enrichment, whose own
 *     comment says the re-entry is what cancels the card's dismiss timer),
 *   - electron/ipc/jobs.js (the LinkedIn Solve re-fetch),
 *   - electron/ipc/marketplace.js (scrapeOneSource, the post-Solve comp rescrape),
 *   - electron/ipc/compProgressAggregator.js (cumulative mid-bundle beat).
 * Adding a regression guard here would re-introduce the disappearing-card bug
 * those re-entries exist to prevent. The one case where a genuinely STALE beat
 * could arrive after a result is already fenced at its source, by
 * `terminalManualSourceIds` in electron/ipc/jobs.js — fence it there, not here.
 */
export function mergeSourceProgress(prev, payload) {
  // A source can complete its provider collection and then re-enter
  // `searching` for a downstream activity (currently LinkedIn description
  // enrichment). Keep that activity distinct from the source-level
  // `completed`/`total` counters, whose denominator is usually source/query
  // work rather than individual descriptions. Terminal source events clear an
  // activity even when the backend only needs to send its normal status.
  const clearsActivity = isTerminalSourceStatus(payload.status) || payload.activity === null;
  return {
    status:  payload.status,
    count:   payload.count !== undefined ? payload.count : prev?.count ?? null,
    detail:  payload.detail ?? null,
    warning: payload.warning !== undefined ? payload.warning : prev?.warning ?? null,
    url:     payload.url     !== undefined ? payload.url     : prev?.url     ?? null,
    // A terminal source event can omit the run token emitted by its earlier
    // progress beat. Keep it sticky so a later Solve stays bound to the exact
    // run that produced this source card rather than falling back to a newer
    // hub-wide token.
    jobRunId: payload.jobRunId !== undefined ? payload.jobRunId : prev?.jobRunId ?? null,
    completed: payload.completed !== undefined ? payload.completed : prev?.completed ?? null,
    total:     payload.total     !== undefined ? payload.total     : prev?.total     ?? null,
    activity: payload.activity !== undefined
      ? payload.activity
      : (clearsActivity ? null : prev?.activity ?? null),
    activityCompleted: payload.activityCompleted !== undefined
      ? payload.activityCompleted
      : (clearsActivity ? null : prev?.activityCompleted ?? null),
    activityTotal: payload.activityTotal !== undefined
      ? payload.activityTotal
      : (clearsActivity ? null : prev?.activityTotal ?? null),
  };
}

// Statuses that represent a settled outcome for a source. Shared so a consumer
// deciding "has the backend spoken?" cannot drift from this module's contract;
// one private copy still exists (SellHubNode's TERMINAL_COMP_STATUSES).
export const TERMINAL_SOURCE_STATUSES = new Set(['done', 'error', 'skipped']);

export function isTerminalSourceStatus(status) {
  return TERMINAL_SOURCE_STATUSES.has(status);
}

/**
 * Keep a source-progress consumer on one run generation. A late event from a
 * retired run must not repaint a freshly reset card; untagged legacy events are
 * accepted only before the first token has ever been observed.
 */
export function createSourceProgressRunGuard(initialRunId = null) {
  let activeRunId = initialRunId || null;
  const retiredRunIds = new Set();
  const trimRetired = () => {
    while (retiredRunIds.size > 24) retiredRunIds.delete(retiredRunIds.values().next().value);
  };
  return {
    accepts(runId) {
      if (!runId) return !activeRunId && retiredRunIds.size === 0;
      if (retiredRunIds.has(runId)) return false;
      if (activeRunId && activeRunId !== runId) return false;
      activeRunId = runId;
      return true;
    },
    retireActive() {
      if (activeRunId) {
        retiredRunIds.add(activeRunId);
        trimRetired();
      }
      activeRunId = null;
    },
    // An explicit Job Search Resume intentionally continues the same durable
    // run token after a user stop. Re-open only that exact token; all other
    // retired generations remain fenced so late events cannot repaint it.
    resume(runId) {
      if (!runId) return false;
      retiredRunIds.delete(runId);
      activeRunId = runId;
      return true;
    },
    active() {
      return activeRunId;
    },
  };
}
