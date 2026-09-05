export const TRANSIENT_PROCESSING_HUB_STATES = [
  'queued',
  'parsing',
  'interpreting-preferences',
  'querying',
  'evaluating-preferences',
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
  // These freeze the active run's Job Preferences while scraping. Recovery
  // reads the manifest instead; retaining them after an interrupted hub is
  // reset to empty risks applying an old person's plan to the next run.
  'activeJobPreferences',
  // The interpreted half of that same frozen pair. Stripping only the TEXT left
  // a reloaded hub holding the previous run's PLAN with no text to check it
  // against, and the post-run readers (late-USAJobs refresh, done-state append,
  // resume scoring) take them as a pair — `data.activeJobPreferences ??
  // data.jobPreferences` fell through to whatever is currently in the textarea
  // while `data.jobPreferencePlan` still supplied the OLD interpretation, so new
  // listings were screened under a plan the visible text no longer describes.
  // Dropping both is safe: evaluateJobPreferences re-derives a plan from raw
  // text, and runPipeline always re-interprets at the start of a fresh run.
  'jobPreferencePlan',
  'jobPreferencesInterpretation',
  'pendingJobPreferences',
  'pendingJobPreferencesInterpretation',
  'pendingJobPreferencePlan',
  // `sources-ready` deliberately keeps its pending career data so it can
  // resume after a restart. In every other state this is stale queue state and
  // often a second large copy of careerData, so strip it with the run buffer.
  'pendingCareerData',
  'errorMessage',
  'isRateLimit',
  // A healthy history-suppressed re-run explanation belongs only to the
  // active session; reopening must not surface stale run context.
  'rerunOutcome',
  'rerunNotice',
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
  'rerunOutcome',
  'rerunNotice',
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

// A hub that FINISHED owns its frozen run values the same way a paused
// 'sources-ready' hub does: the late-source append and re-analysis paths read
// `activeJobPreferences` + `jobPreferencePlan` together as "the generation these
// results came from". Only an INTERRUPTED run (a state that is itself rewritten
// to 'empty' on save) has to shed them, which is what the strip was written for.
const JOBSEARCH_DONE_TRANSIENT_KEYS = JOBSEARCH_TRANSIENT_KEYS.filter(key => (
  key !== 'activeJobPreferences' && key !== 'jobPreferencePlan' && key !== 'jobPreferencesInterpretation'
));

export function getJobSearchTransientKeysForSave(hubState) {
  if (hubState === 'sources-ready') return JOBSEARCH_SOURCES_READY_TRANSIENT_KEYS;
  return TRANSIENT_PROCESSING_HUB_STATES.includes(hubState)
    ? JOBSEARCH_TRANSIENT_KEYS
    : JOBSEARCH_DONE_TRANSIENT_KEYS;
}
