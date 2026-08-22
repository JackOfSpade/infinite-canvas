export const TRANSIENT_PROCESSING_HUB_STATES = [
  'queued',
  'parsing',
  'querying',
  'searching',
  'scoring',
  'analyzing',
  'researching',
];

const JOBSEARCH_TRANSIENT_KEYS = [
  'queuedModuleRun',
  'scrapeWarnings',
  'pendingJobs',
  'pendingTargetRole',
  'errorMessage',
  'isRateLimit',
  // In-flight marker for achievement-ledger mining (resume-achievement-mining
  // design §3.6) — a millisecond timestamp the renderer sets before a mining
  // generate and clears in a finally, guarding against two cards racing to
  // mine the same hub. It is run state, not the mined result: unlike
  // data.achievements (which must persist — that's the whole point of
  // hub-caching, so it is deliberately NOT listed here), surviving a crash
  // with this marker still set would wedge the hub into permanently skipping
  // its own mine, since a stale marker reads as "someone else is mining."
  'achievementsMining',
  // Preflight drop lock, set the instant a career-file drop is accepted and
  // BEFORE parsing has produced a profile. It exists to reject a second drop
  // during that window, which is a within-session concern only.
  //
  // It has to be stripped here because saving mid-parse already rewrites
  // hubState to 'empty' (TRANSIENT_PROCESSING_HUB_STATES, applied a few lines
  // down in sanitizeNodesForSave). Keeping the lock while discarding the state
  // that justified it reloads a hub that refuses new drops, reports "Career
  // files retained" when nothing was retained, and hides its own Re-run button
  // because no resumeProfile ever landed — no route forward but deleting the
  // module. A hub that genuinely finished parsing stays locked on its
  // resumeProfile/careerData/filePaths, which hubHasAcceptedInitialDrop checks
  // independently, so nothing that should stay locked is unlocked by this.
  'inputLocked',
];

const JOBSEARCH_SOURCES_READY_TRANSIENT_KEYS = [
  'errorMessage',
  'isRateLimit',
  // Same marker, same reason as JOBSEARCH_TRANSIENT_KEYS above — 'sources-ready'
  // is a real hubState a hub can sit in while a Generate-triggered mine (set on
  // the ORIGIN hub via JobCardNode's updateGlobal, not on the mining card
  // itself) is in flight on some other card. Omitting it here left this branch
  // saving the raw millisecond marker whenever a save landed on a paused hub —
  // exactly the "wedge into permanently skipping its own mine" failure mode
  // this key exists to prevent, just reachable via the other hubState branch.
  'achievementsMining',
];

export const SELLHUB_TRANSIENT_KEYS = [
  'queuedModuleRun',
  'platformFitPending',
];

export function getJobSearchTransientKeysForSave(hubState) {
  return hubState === 'sources-ready'
    ? JOBSEARCH_SOURCES_READY_TRANSIENT_KEYS
    : JOBSEARCH_TRANSIENT_KEYS;
}
