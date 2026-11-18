import path from 'path';
import { logger } from '../../logger.js';
import { getCurrentIpcRequestContext } from '../ipcUtils.js';

// Cross-module mutable state of the Jobs IPC handlers. Every value that two or
// more modules under electron/ipc/jobs/ touch lives here and is mutated in
// place (fields of an exported object), never reassigned across modules.

// The egress IP at which LinkedIn last hit its guest ceiling. A same-IP retry
// immediately after a wall is wasteful, but a guest ceiling can cool while the
// user is deciding what to do. Keep its timestamp with the IP so the normal
// Solve flow eventually permits a conservative same-IP retry instead of
// contradicting the cooldown advice in its own diagnostics.
export const linkedinCeiling = { ip: null, at: 0 };
export const LINKEDIN_SAME_IP_RETRY_COOLDOWN_MS = 60_000;

export function linkedInSameIpRetryDecision(lastIp, lastCeilingAt, currentIp, now = Date.now()) {
  if (!lastIp || !currentIp || currentIp !== lastIp) return { skip: false, retryAfterMs: 0 };
  const elapsedMs = Math.max(0, now - (Number(lastCeilingAt) || 0));
  const retryAfterMs = Math.max(0, LINKEDIN_SAME_IP_RETRY_COOLDOWN_MS - elapsedMs);
  return { skip: retryAfterMs > 0, retryAfterMs };
}

export function rememberLinkedInCeiling(ip) {
  linkedinCeiling.ip = ip || null;
  linkedinCeiling.at = linkedinCeiling.ip ? Date.now() : 0;
}

export function clearLinkedInCeiling() {
  linkedinCeiling.ip = null;
  linkedinCeiling.at = 0;
}

export function createJobsTelemetry() {
  return {
  // The hub node that produced this run. Stamped by every stage handler so the
  // bug report can flag when the funnel belongs to a node that ISN'T in the
  // canvas the report was generated from — this object is a main-process
  // singleton shared by every open window/canvas, so without it a job search in
  // one canvas leaks into another canvas's report.
  nodeId:    null,
  // The Job Board that most recently bucketed/displayed this run. Bucketing is
  // a board-owned IPC call now, so its nodeId is NOT the source jobhub id above.
  // Keep the two identities separate or a successful Combine rewrites the
  // whole search/scoring funnel's attribution to the board that displayed it.
  boardNodeId: null,
  search:    null, // { ts, queries, raw, windowEligible?, ageDropped, deduped, roleDropped, historyDropped, kept }
  resolves:  {},   // { [sourceId]: { ts, extracted, ageDropped, historyDropped, kept } }
                   // keyed so a multi-source recovery (e.g. Indeed then LinkedIn)
                   // keeps every resolve; re-resolving a source replaces its
                   // entry. Reset when a fresh search stamps so it's scoped to it.
  // The last observed Indeed scrape session preflight: landed URL, whether the
  // PPID session cookie was present, and the cookie names actually seen.
  // Answers "was the browser that scraped even logged in?" — no log line
  // survived long enough to show that (the challenge early-return happens
  // before the session-check log line runs; see indeedBrowser.js). Populated
  // from the extractor's sessionDiagnostics at every Indeed call site.
  // { ts, landedUrl, preflightStatus, preflightReason, hasPPID, cookieNames,
  //   executablePath, userDataDir, host }
  indeedSession: null,
  // Every Continue / Log in / Solve resume attempt per source, newest last,
  // capped at 12 — so a bug report can show that the user clicked Continue
  // three times and each attempt died the same way, instead of only the
  // latest one. Reset when a fresh search stamps, same as `resolves` above.
  // { [sourceId]: [{ t, mode, outcome, detail }] }
  resumeAttempts: {},
  scoring:   null, // { ts, runId, input, selectedForScoring, scored, placeholders, ungroundedScores, batches, failedBatches, unscored }
  // Last immutable approved-career-snapshot lookup decision. A bad record
  // must never discard an otherwise valid new compile.
  // Hashes are deliberately shortened before telemetry leaves this module.
  // { ts, nodeId, fileCount, fingerprint, outcome, error? }
  careerSnapshotCache: null,
  // Live score-batch activity. Unlike final `scoring`, this is present while a
  // streaming call is in flight so Active IPC diagnostics distinguish ongoing
  // model work from a silent/hung task.
  scoringHeartbeat: null, // { ts, active, phase, scored, total, batch, batchTotal, attemptSize }
  // Compensation research had ZERO bug-report presence before this: a failed
  // cohort surfaced only as a logger.warn line, visible only if it happened to
  // still be inside the main-process ring buffer when the report was built.
  // Answers: how many jobs were eligible for the competitive-pay check, how
  // many cohorts that fragmented into, what it cost (researched/assessed/cache
  // hits), and why it failed. Reset at search start alongside `resolves` above;
  // populated at the end of researchCompensationAssessments.
  // { ts, scoredInput, eligible, preResearchCandidates, skippedBelowFit,
  //   skippedNoExperience, skippedNoExperienceBand,
  //   missingOffer, recommendedNoOffer, skippedNoCurrency, skippedNoLocation,
  //   locationLookup: { postings, jobs, handoffs, cacheHit, overflowPostings, noIdentityJobs,
  //     resolved, foundUnresolved, rejected, notFound, failed, interrupted,
  //     rejectionReasons: { ENUM_CODE: n }, error }  // no URLs/titles/companies
  //   roleBandLookups, roleBandResearches, roleBandCacheHits, roleBandFailures,
  //   roleBandFailureJobs, roleBandInterruptedJobs, marketCandidates,
  //   cohorts, researched, failedCohorts, marketCohortFailures,
  //   assessed, minFitScore, cacheHits,
  //   failures: [{ cohort, reason }],
  //   roleBandFailureDetails: [{ role, reason }] }  // detail lists capped at 5
  compensation: null,
  boardResearch: null,
  bucketing: null, // { ts, input, categories, placed, missing, duplicated, model, strategy, blocked, capability, errorCode, error } — failure details distinguish an explicit capability denial from a provider error; neither produces a new board
  // Per-source job-source-progress event trail for the current search, captured
  // in the main process so it survives the source-card nodes being deleted (the
  // renderer Event History shows WHEN a card was removed, but not the status/
  // warning sequence that drove it). Answers "why did a blocked source's resolve
  // card disappear before the user could act?" — e.g. did it ever emit a clean
  // 'done' that auto-dismissed it. { [sourceId]: [{ t, status, code, severity }] }
  sourceEvents:     {},
  sourceEventsT0:   0, // search-start epoch; event `t` is relative ms from here
  // Cross-run, hub-local source schedule and throttle trail. The current
  // `sourceEvents` ring intentionally resets for every fresh search so it
  // cannot blur a live run with an older one, but that used to erase the only
  // evidence that a source had just been delayed/throttled when a retry began.
  // Keep the last three run summaries per source: enough to diagnose a repeat
  // without letting a long-lived canvas grow unbounded. Each summary is
  // stamped only from node/run-scoped progress events and is therefore safe to
  // return through the report's sender/window + current-hub ownership gate.
  // { [sourceId]: [{ runId, announcedAt, dispatchedAt, terminalAt, lastAt,
  //                  announcedStatus, terminalStatus, warning: { code, severity } | null,
  //                  resolvePassCount, resolvePasses,
  //                  resumeAttemptCount, resumeAttempts }] }
  // `resolvePasses` is a tiny, redacted per-Solve trail for description
  // recovery. It is deliberately owned by this source/run receipt instead of
  // the single current `resolves` entry, which is ambiguous when a report has
  // more than one current Job Search hub.
  // `resumeAttempts` is the same idea for Continue/Log in/Solve clicks, and
  // exists for a stronger reason: the live `resumeAttempts` map below is wiped
  // by this hub's next search AND is unreadable at all on a multi-hub canvas,
  // so the clicks that a user reports as "nothing happened" had no durable
  // record anywhere.
  sourceRunHistory: {},
  // Live search-jobs heartbeat. Unlike `search` (written only at the successful
  // end), this survives while the IPC task is awaiting sources/enrichment and
  // lets FULL/JOBS reports name the current stage and pending source(s).
  pipeline:         null, // { phase, startedAt, ts, active, pendingSources, lastSource }
  // LinkedIn enrichment pass trail: the initial search's enrichment pass plus
  // every Solve re-fetch, newest-last, capped. `usedAuthenticated` says a
  // verified profile session was tried; `authenticatedFallback` says that path
  // lacked a rendered JD and continued as guest. Egress IP is still only one
  // observable condition among possible guest-limit keys, so never treat a
  // change as causal proof. { ts, kind, ip, ipOk, walled, usedAuthenticated,
  // authenticatedFallback, skippedSameIp, enriched, stillEmpty, contextRotations }
  linkedinEnrich:   [],
  // Result of the automated cooldown probe (JOB_SEARCH_PROBE_COOLDOWN): the first
  // idle wait that cleared the guest wall, or exhausted. { running, attempts,
  // foundMs, waitsMs, ts }
  linkedinCooldown: null,
  // The seen-history CSV is the durable "do not re-show" record. Search-stage
  // rows are deliberately deferred: a review gate, scoring failure, cancel, or
  // crash must not suppress jobs the user never received. A Board display
  // stages the exact scored rows; deletion of the source Search or its next
  // scrape finalizes them. { preScoring?: { ... }, boardDisplay?: { ... } }
    history: null,
  };
}

// These channels belong to Boards (and individual compensation cards), rather
// than source Searches. Node-addressed requests have a separate sender-local
// registry; old callers without an owner retain their ambient behavior.
export const LEGACY_JOBS_TELEMETRY_CHANNELS = new Set([
  'append-jobs-history',
  'research-job-compensation',
  'bucket-jobs',
  'settle-board-research',
]);
// One exported object, never replaced: reset reassigns its fields, so every
// importer always reads the current maps. The request pins (boardByRequest,
// boardCanvasScope) are deliberately left out of the reset below.
// Request pins outlive a test reset, but their registry does not. An in-flight
// old request may finish its orphan record without republishing it after reset.
export const jobsTelemetryRegistry = {
  bySender: new WeakMap(),
  latestBySender: new WeakMap(),
  legacyByRequest: new WeakMap(),
  boardBySender: new WeakMap(),
  boardByRequest: new WeakMap(),
  boardCanvasScope: new WeakMap(),
  latest: createJobsTelemetry(),
};
export const JOB_BOARD_TELEMETRY_CAP = 32;

export function boardTelemetryCanvasScope(value) {
  return typeof value === 'string' && value.trim() ? path.resolve(value).normalize('NFC') : null;
}

export function boardJobsTelemetry(context, sender, nodeId) {
  let telemetry = jobsTelemetryRegistry.boardByRequest.get(context);
  if (telemetry) return telemetry;
  let byBoard = jobsTelemetryRegistry.boardBySender.get(sender);
  if (!byBoard) {
    byBoard = new Map();
    jobsTelemetryRegistry.boardBySender.set(sender, byBoard);
  }
  const canvasScope = boardTelemetryCanvasScope(sender.__canvasPath);
  const ownerKey = JSON.stringify([canvasScope, nodeId]);
  telemetry = byBoard.get(ownerKey);
  // Each bucket call starts a new latest attempt. A predecessor's pinned
  // callbacks can finish only its old record, never the replacement's stages.
  if (!telemetry || context.channel === 'bucket-jobs') {
    // The research stage runs just before taxonomy within the same Combine.
    const boardResearch = telemetry?.boardResearch;
    telemetry = createJobsTelemetry();
    if (boardResearch) telemetry.boardResearch = boardResearch;
    telemetry.boardNodeId = nodeId;
    telemetry.windowId = sender.id ?? null;
    jobsTelemetryRegistry.boardCanvasScope.set(telemetry, canvasScope);
    byBoard.delete(ownerKey);
    byBoard.set(ownerKey, telemetry);
    while (byBoard.size > JOB_BOARD_TELEMETRY_CAP) byBoard.delete(byBoard.keys().next().value);
  }
  jobsTelemetryRegistry.boardByRequest.set(context, telemetry);
  return telemetry;
}

export function getScopedJobsTelemetry() {
  const context = getCurrentIpcRequestContext();
  const sender = context?.sender;
  const nodeId = typeof context?.nodeId === 'string' && context.nodeId.trim()
    ? context.nodeId.trim()
    : null;

  if (LEGACY_JOBS_TELEMETRY_CHANNELS.has(context?.channel)) {
    if (sender && nodeId) return boardJobsTelemetry(context, sender, nodeId);
    if (!context || typeof context !== 'object') return jobsTelemetryRegistry.latest;
    let telemetry = jobsTelemetryRegistry.legacyByRequest.get(context);
    if (!telemetry) {
      // A board/history request has no source-hub id, but it still belongs to
      // its invoking window. Pin it to that window's latest source telemetry
      // rather than whichever other window most recently completed a search.
      telemetry = sender ? jobsTelemetryRegistry.latestBySender.get(sender) : null;
      if (!telemetry && sender) {
        telemetry = createJobsTelemetry();
        jobsTelemetryRegistry.latestBySender.set(sender, telemetry);
      }
      telemetry ||= jobsTelemetryRegistry.latest;
      jobsTelemetryRegistry.legacyByRequest.set(context, telemetry);
    }
    return telemetry;
  }

  if (!sender) return jobsTelemetryRegistry.latest;
  if (!nodeId) {
    let telemetry = jobsTelemetryRegistry.latestBySender.get(sender);
    if (!telemetry) {
      telemetry = createJobsTelemetry();
      jobsTelemetryRegistry.latestBySender.set(sender, telemetry);
    }
    return telemetry;
  }

  let byNode = jobsTelemetryRegistry.bySender.get(sender);
  if (!byNode) {
    byNode = new Map();
    jobsTelemetryRegistry.bySender.set(sender, byNode);
  }

  let telemetry = byNode.get(nodeId);
  if (!telemetry) {
    telemetry = createJobsTelemetry();
    byNode.set(nodeId, telemetry);
  }
  jobsTelemetryRegistry.latest = telemetry;
  jobsTelemetryRegistry.latestBySender.set(sender, telemetry);
  return telemetry;
}

export const jobsTelemetry = new Proxy({}, {
  get(_target, property) {
    return Reflect.get(getScopedJobsTelemetry(), property);
  },
  set(_target, property, value) {
    return Reflect.set(getScopedJobsTelemetry(), property, value);
  },
  has(_target, property) {
    return Reflect.has(getScopedJobsTelemetry(), property);
  },
  deleteProperty(_target, property) {
    return Reflect.deleteProperty(getScopedJobsTelemetry(), property);
  },
  ownKeys() {
    return Reflect.ownKeys(getScopedJobsTelemetry());
  },
  getOwnPropertyDescriptor(_target, property) {
    const descriptor = Object.getOwnPropertyDescriptor(getScopedJobsTelemetry(), property);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
});

export function __resetJobsTelemetryForTests() {
  jobsTelemetryRegistry.bySender = new WeakMap();
  jobsTelemetryRegistry.latestBySender = new WeakMap();
  jobsTelemetryRegistry.legacyByRequest = new WeakMap();
  jobsTelemetryRegistry.boardBySender = new WeakMap();
  jobsTelemetryRegistry.latest = createJobsTelemetry();
}

// When a native Indeed login last completed successfully IN THIS PROCESS.
// Only a login this code actually watched finish counts — deliberately not the
// accounts.js disk cache, whose stale connected:true is the failure mode the
// whole native-login path exists to recover from. Used solely to stop a second
// queued "Log in" click from opening a redundant window; see its one reader.
export const indeedLoginStamp = { confirmedAt: 0 };
export const RECENT_INDEED_LOGIN_MS = 60_000;

/**
 * Forget the stamp above the moment this process learns the Indeed session it
 * recorded is gone.
 *
 * The stamp suppresses a redundant second login window, and that suppression is
 * only correct while the login it recorded still describes the shared profile.
 * Once the session is deliberately invalidated — Settings -> Reset Indeed
 * session, the all-profile clear, or a scrape that came back needs-login — it
 * describes a profile that no longer exists. Leaving it set made the next
 * "Log in" click inside RECENT_INDEED_LOGIN_MS open no window at all while
 * recording 'logged-in' in both the live trail and the durable receipt: from the
 * user's side the button did nothing, the resume scrape then ran against the
 * freshly wiped profile and returned needs-login, and the diagnostics beside it
 * asserted a login that had just been erased.
 */
export function forgetIndeedLoginConfirmation(reason) {
  if (indeedLoginStamp.confirmedAt === 0) return;
  indeedLoginStamp.confirmedAt = 0;
  logger.info(`[Jobs] Cleared the recent-Indeed-login dedupe stamp: ${reason}`);
}
