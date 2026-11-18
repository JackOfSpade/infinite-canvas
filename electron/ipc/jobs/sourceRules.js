import { logger } from '../../logger.js';
import { ZIPRECRUITER_EXTRACTOR, GLASSDOOR_EXTRACTOR, GOOGLE_JOBS_EXTRACTOR } from '../../extractors/jobs.js';
import { assessSourceHealth, sourceHealthWarning } from '../jobSourceHealth.js';
import { isRunCollectionFinishedWithSavedListings } from '../jobRunStaging.js';
import { filterJobsByPostedSince } from '../jobDateFilter.js';
import { getScopedJobSourceIds } from '../../../src/utils/jobSourceScope.js';
import { sourceJobKey, dedupJobsAcrossSources } from '../../../src/utils/jobIdentity.js';
import { officialPostingAliases, officialPostingRecordMatchesScrapedIdentity } from '../officialPostingStore.js';
import { listingStateRank, normalizeBoardClosed, normalizeListingLiveness, normalizeOfficialPosting } from '../officialPostingFields.js';

// A walker reports a walk guard when it stopped a walk for lack of real progress
// or at a safety backstop. That usually means the scraper needs a fix.
export const WALK_GUARD_WARNING_CODE = 'collection-stalled';

const WALK_GUARD_KINDS = new Set(['pager-trickle', 'page-backstop', 'job-backstop', 'reveal-stalled', 'reveal-backstop', 'detail-retry-cap']);

const WALK_GUARD_DETAIL_LIMIT = 240;

const WALK_GUARD_EVIDENCE_LIMIT = 600;

const WALK_GUARD_SUGGESTION = 'The scraper stopped this walk so it could not run forever. Results from this site are incomplete and the scraper likely needs a fix. Send a bug report.';

const walkGuardNumber = value => (value == null || value === '' || !Number.isFinite(Number(value))
  ? null
  : Math.max(0, Math.floor(Number(value))));

const walkGuardText = (value, limit) => (value == null ? '' : String(value).slice(0, limit));

export function sanitizeWalkGuards(guards, limit = 20) {
  if (!Array.isArray(guards)) return [];
  const out = [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  for (const guard of guards) {
    if (out.length >= cap) break;
    if (!guard || typeof guard !== 'object' || !WALK_GUARD_KINDS.has(guard.kind)) continue;
    out.push({
      kind: guard.kind,
      source: walkGuardText(guard.source, 120),
      query: walkGuardText(guard.query, 120),
      page: walkGuardNumber(guard.page),
      pages: walkGuardNumber(guard.pages),
      newRows: walkGuardNumber(guard.newRows),
      detail: walkGuardText(guard.detail, WALK_GUARD_DETAIL_LIMIT),
    });
  }
  return out;
}

export function walkGuardWarning(sourceId, guards) {
  const clean = sanitizeWalkGuards(guards, 20);
  if (clean.length === 0) return null;
  const seen = new Set();
  const evidence = [];
  for (const guard of clean) {
    const key = `${guard.kind}\u0000${guard.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(guard.detail || guard.kind);
  }
  return {
    code: WALK_GUARD_WARNING_CODE,
    severity: 'warn',
    shortLabel: 'Stopped early',
    evidence: evidence.join('; ').slice(0, WALK_GUARD_EVIDENCE_LIMIT),
    suggestion: WALK_GUARD_SUGGESTION,
  };
}

export const JOB_DESCRIPTION_EVIDENCE_MIN_CHARS = 400;

export function canRecoverGatheredRunDirectly(manifest, queries) {
  const sources = manifest?.sources;
  return manifest?.stage === 'gathered'
    && Array.isArray(manifest?.inputs?.queries)
    && JSON.stringify(manifest.inputs.queries) === JSON.stringify(Array.isArray(queries) ? queries : [])
    && !!sources
    && Object.keys(sources).length > 0
    && (
      isRunCollectionFinishedWithSavedListings(manifest)
      || Object.values(sources).every(source => source?.status === 'done' || source?.status === 'skipped')
    );
}

// Ordered manual-source URLs are recovery input, not report telemetry. Keep a
// small, exact allow-list taken only from this run's configured task URLs; a
// Solve may consume one entry after a restart without trusting renderer input.
const DESCRIPTION_RECOVERY_BLOCKED_URL_CAP = 24;

export function boundedRecoveryBlockedUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = typeof raw === 'string' ? raw : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
    if (result.length >= DESCRIPTION_RECOVERY_BLOCKED_URL_CAP) break;
  }
  return result;
}

export function recoveryBlockedUrlsForSource(state, sourceId) {
  return boundedRecoveryBlockedUrls(state?.[sourceId]?.blockedUrls);
}

export function consumeRecoveryBlockedUrl(state, sourceId, resolvedUrl) {
  const remaining = recoveryBlockedUrlsForSource(state, sourceId)
    .filter(url => url !== resolvedUrl);
  return {
    remaining,
    state: {
      ...(state || {}),
      [sourceId]: {
        ...(state?.[sourceId] || {}),
        blockedUrls: remaining,
      },
    },
  };
}

export function __consumeRecoveryBlockedUrlForTests(state, sourceId, resolvedUrl) {
  return consumeRecoveryBlockedUrl(state, sourceId, resolvedUrl);
}

/** Convert only navigation-issued Google task URLs into report keywords. */
export function extractExecutedGoogleQueryStrings(sourceResults = {}) {
  return (sourceResults.google?.executedQueries || [])
    .map((entry) => {
      try { return new URL(entry.url).searchParams.get('q') || ''; } catch { return ''; }
    })
    .filter(Boolean)
    .slice(0, 12);
}

/** Reconcile title drops moved before browser caps with the central funnel. */
export function reconcileTitleRelevanceFunnel(allJobsCount, finalAdmissionCount, sourceResults = {}) {
  const centralRaw = Math.max(0, Number(allJobsCount) || 0);
  const centralAdmitted = Math.max(0, Number(finalAdmissionCount) || 0);
  const finalDropped = Math.max(0, centralRaw - centralAdmitted);
  const preCapDropped = Object.values(sourceResults)
    .reduce((sum, data) => sum + Math.max(0, Number(data?.preCapRelevanceDropped) || 0), 0);
  return {
    raw: centralRaw + preCapDropped,
    relevanceDropped: preCapDropped + finalDropped,
    finalDropped,
  };
}

/**
 * Merge a title-screen response back into the full ordered pool. The screen is
 * positional: `verdictsByIndex[0]` belongs to the first unstamped input row.
 * Never join these rows through a provider job id; native ids can repeat across
 * sources (and occasionally within one source), which used to let one verdict
 * overwrite or remove an unrelated listing.
 */
export function mergeRoleScreenedJobs(jobs, roleScreen) {
  const pool = Array.isArray(jobs) ? jobs : [];
  const verdicts = roleScreen?.verdictsByIndex && typeof roleScreen.verdictsByIndex === 'object'
    ? roleScreen.verdictsByIndex
    : {};
  let freshIndex = 0;
  const kept = [];
  for (const job of pool) {
    if (job?.roleScreen) {
      kept.push(job);
      continue;
    }
    const rawVerdict = verdicts[freshIndex] || {};
    freshIndex += 1;
    const outcome = ['match', 'mismatch', 'unclear'].includes(rawVerdict.outcome)
      ? rawVerdict.outcome
      : 'unclear';
    const verdict = {
      outcome,
      reason: outcome === 'mismatch' ? String(rawVerdict.reason || '').trim().slice(0, 300) : '',
      ...(['saved', 'title', 'snippet'].includes(rawVerdict.via) ? { via: rawVerdict.via } : {}),
    };
    if (outcome !== 'mismatch') kept.push({ ...job, roleScreen: verdict });
  }
  return kept;
}

/**
 * Preserve the provider-ranked result set before dedup/history. Search
 * platforms already apply their own fuzzy matching and ranking, including
 * adjacent titles that a local text gate cannot safely reconstruct — so this
 * boundary stays a pass-through and never second-guesses provider wording.
 * Keyword-less whole-feed sources still perform their necessary client-side
 * query matching inside their extractors before reaching this boundary.
 *
 * SINGLE MODE (the deterministic pinned-title gate is gone): the AI always
 * determines the searched roles now, so there is no separate "the user pinned
 * an exact title, enforce it verbatim" instruction to apply here or anywhere
 * downstream. Role fit is instead screened per-listing by the AI role screen
 * riding inside evaluateJobPreferences' batched preference evaluation (see
 * jobPreferences.js) — a semantic judgment, not a substring match, and one
 * that fails OPEN (a job survives unless the model explicitly says
 * 'mismatch'). This function is therefore an unconditional pass-through for
 * every run.
 */
export function acceptProviderSearchResults(jobs) {
  return Array.isArray(jobs) ? [...jobs] : [];
}

// Compatibility export for recovery/test callers from older builds. The old
// name now preserves rows; it no longer applies a title gate.
export const applyFinalJobTitleRelevanceGate = acceptProviderSearchResults;

// Resolve windows can extract list cards from a page whose detail panel is
// unavailable (Glassdoor's DOM fallback deliberately emits blank snippets).
// A resolver must use the exact same admission contract as scoring: a long
// enough description and no explicit deferral marker. Otherwise a partial
// panel read can be called "recovered" here and then rejected later, leaving
// the recovery pool unchanged while retry guidance is reset indefinitely.
/**
 * Split one platform's rows into the listings whose description was read and
 * the ones that came back without one. Keys are `sourceJobKey`, the identity a
 * list card carries before its description is opened, so the next scan can
 * recognise the card without opening it.
 */
export function listingReadProgress(jobs) {
  const readKeys = [];
  const unreadListings = [];
  const seen = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const key = sourceJobKey(job);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!job?.descriptionDeferredReason && hasResolvedJobDescription(job)) readKeys.push(key);
    else if (unreadListings.length < 200) {
      unreadListings.push({
        key,
        title: String(job?.title || ''),
        company: String(job?.company || ''),
        url: String(job?.url || job?.googleCardUrl || ''),
      });
    }
  }
  return { readKeys, unreadListings };
}

export function hasResolvedJobDescription(job) {
  // Deliberately delegate instead of duplicating the condition. This helper is
  // also passed directly to Array#filter in the postprocessor-failure fallback;
  // accepting a second parameter there would accidentally receive the array
  // index as a character threshold and let short rows through.
  return filterJobsByDescriptionEvidence([job]).jobs.length === 1;
}

/**
 * Keep the specific description-recovery failure when the resolver recovered
 * list rows but no usable job descriptions. In particular, a terminal
 * Glassdoor hard block must not be rewritten as the generic "click Solve
 * again" warning: there is no interactive challenge, and immediate retries
 * only repeat the visible-window open/close loop.
 */
/**
 * Human-facing name for a source id. Shared so description-recovery messages
 * cannot hard-code one platform: the recovery path is source-generic, and a
 * Glassdoor panel-429 now reaches messages that used to be Google-only.
 */
export function resolveSourceLabel(sourceId) {
  return sourceId === 'ziprecruiter'
    ? 'ZipRecruiter'
    : sourceId === 'glassdoor'
      ? 'Glassdoor'
      : sourceId === 'indeed'
        ? 'Indeed'
        : sourceId === 'google'
          ? 'Google'
          : String(sourceId || 'This source');
}

export function buildResolvedDescriptionWarning(sourceId, rootWarning, completeRows = [], emptyRows = []) {
  if (!Array.isArray(emptyRows) || emptyRows.length === 0) return rootWarning || null;

  const sourceLabel = resolveSourceLabel(sourceId);
  const completeCount = Array.isArray(completeRows) ? completeRows.length : 0;
  const samples = emptyRows.slice(0, 3).map(job => `"${job?.title || 'Untitled'}"`).join(', ');
  const accounting = `${sourceLabel} Resolve recovered ${completeCount} description-complete listing(s), but ${emptyRows.length} still lack a full description${samples ? ` (${samples})` : ''}. Scoring is paused so list-card-only rows are not treated as fully analyzed.`;

  if (rootWarning?.code === 'description-listing-unavailable') {
    const guidance = rootWarning.recoveryGuidance || null;
    // An unavailable-list warning can coexist with cards that were found but
    // repeatedly failed detail extraction. That no-progress observation is
    // stronger than another generic "retry once" promise: expose it first so
    // the card does not keep steering the user into a known stalled loop.
    if (guidance?.stalled === true) {
      const stalledPasses = Math.max(0, Number(guidance.consecutiveNoProgressPasses) || 0);
      return {
        ...rootWarning,
        severity: 'block',
        shortLabel: 'Skip recommended',
        actionLabel: 'Retry anyway',
        evidence: `${accounting} The last ${stalledPasses} Solve passes each opened the available unresolved listing(s) and recovered no description.`,
        suggestion: `Repeating the same pass is not making progress. Skip to continue without ${emptyRows.length === 1 ? 'this listing' : 'these listings'} — they are not recorded as seen, so a later run can still collect them — or choose Retry anyway if you have since changed network/IP or waited out a source throttle.`,
      };
    }
    const skipRecommended = guidance?.recommendation === 'skip';
    const observedPasses = Math.max(0, Number(guidance?.consecutiveNoMatchPasses) || 0);
    const listingLabel = emptyRows.length === 1
      ? samples
      : `${emptyRows.length} unresolved listings`;
    const message = skipRecommended
      ? `${listingLabel} ${emptyRows.length === 1 ? 'was' : 'were'} not found in ${observedPasses} consecutive checks. Skip is recommended, or choose Check anyway to retry.`
      : `${listingLabel} ${emptyRows.length === 1 ? 'was' : 'were'} not found in the current ${sourceLabel} results. Retry once more; if ${emptyRows.length === 1 ? 'it is' : 'they are'} still missing, Skip will be recommended.`;
    return {
      ...rootWarning,
      severity: 'block',
      // The durable observation owns the recommendation. A simultaneous
      // panel-warning may have supplied its own retry copy, but preserving it
      // here would contradict the promise made after the first no-match pass.
      shortLabel: skipRecommended ? 'Skip recommended' : (rootWarning.shortLabel || 'Retry recommended'),
      // A non-interactive hard block still cannot be retried in this window;
      // retain that explicit action policy while making the Skip advice clear.
      actionLabel: skipRecommended && rootWarning.action !== 'none'
        ? 'Check anyway'
        : (rootWarning.actionLabel || 'Retry'),
      evidence: message,
      suggestion: null,
    };
  }

  // A provider pass can have two independent failures: one deferred listing is
  // absent from the fully revealed list, while another visible card returns a
  // panel warning. The panel code must remain available for diagnosis (and a
  // hard block must retain its non-interactive policy), but it must not mask
  // the separately persisted no-match recommendation. Otherwise activity on
  // another card makes the source card say Retry forever even after the exact
  // missing listing has crossed the advertised Skip threshold.
  const noMatchGuidance = rootWarning?.recoveryGuidance || null;
  if (noMatchGuidance?.recommendation === 'skip') {
    const observedPasses = Math.max(0, Number(noMatchGuidance.consecutiveNoMatchPasses) || 0);
    // `emptyRows` can also include a card that WAS found but whose panel
    // failed. The no-match streak only proves the unavailable identity set is
    // stable, so never overstate that every outstanding row disappeared.
    const unavailableSet = noMatchGuidance.unavailableCount === 1
      ? 'The same unavailable listing'
      : 'The same unavailable listing set';
    const nonInteractive = rootWarning.action === 'none';
    const recommendation = nonInteractive
      ? 'Skip is recommended if you want to continue without the unavailable listing(s); otherwise wait, then rerun after the block clears.'
      : 'Skip is recommended, or choose Check anyway to retry.';
    return {
      ...rootWarning,
      severity: 'block',
      shortLabel: 'Skip recommended',
      actionLabel: nonInteractive
        ? 'Wait, then rerun'
        : 'Check anyway',
      evidence: `${rootWarning?.evidence ? `${rootWarning.evidence} ` : ''}${unavailableSet} was not found in ${observedPasses} consecutive checks. ${recommendation}`,
      // A hard block's remediation remains relevant. Other panel warnings are
      // superseded by the no-match decision rather than promising a third
      // identical retry.
      suggestion: nonInteractive ? rootWarning.suggestion || null : null,
    };
  }

  if (rootWarning?.code === 'description-detail-hard-block' || rootWarning?.code === 'cloudflare-hard-block') {
    return {
      ...rootWarning,
      severity: 'block',
      action: 'none',
      // The card counts down `retryAfterAt` (surviving through this spread) and
      // then offers a real Retry; a hard block needs time, not a hidden action.
      shortLabel: 'Wait, then retry',
      evidence: `${rootWarning.evidence || `${sourceLabel} returned a non-interactive human-verification hard block.`} ${accounting}`,
      suggestion: `There is no interactive challenge to solve in this window. Retry unlocks after the wait, once the IP/session restriction cools down — confirm ${sourceLabel} opens normally in Chrome, then choose Retry. Skip continues without these listings.`,
    };
  }

  if (rootWarning?.code === 'description-appcast-temporary-restriction') {
    return {
      ...rootWarning,
      severity: 'block',
      shortLabel: rootWarning.shortLabel || 'Switch IP, then retry',
      actionLabel: rootWarning.actionLabel || 'Retry after IP change',
      evidence: `${rootWarning.evidence || `${sourceLabel}'s Appcast detail redirect was temporarily restricted.`} ${accounting}`,
      suggestion: `${rootWarning.suggestion || 'Wait or switch to a new working network IP, then retry this source.'} Choose Skip only if you intentionally want to continue without the incomplete listings.`,
    };
  }

  // A repeated Solve that opens the same listings and recovers nothing from any
  // of them is not a retry that needs one more go — it is a stall. Saying
  // "Click Solve again" into that state is what let a real run spend hours on
  // ~13 identical passes. State the observation and stop recommending the
  // action that has already failed that many times; Retry stays AVAILABLE
  // (a rate-limit really can clear), it just stops being the advice.
  const stallGuidance = rootWarning?.recoveryGuidance || null;
  if (stallGuidance?.stalled === true) {
    const stalledPasses = Math.max(0, Number(stallGuidance.consecutiveNoProgressPasses) || 0);
    return {
      ...rootWarning,
      code: rootWarning?.code || 'resolve-description-incomplete',
      severity: 'block',
      shortLabel: 'Skip recommended',
      actionLabel: 'Retry anyway',
      evidence: `${rootWarning?.evidence ? `${rootWarning.evidence} ` : ''}${accounting} The last ${stalledPasses} Solve passes each opened these listings and recovered no description from any of them.`,
      suggestion: `Repeating the same pass is not making progress. Skip to continue without ${emptyRows.length === 1 ? 'this listing' : 'these listings'} — they are not recorded as seen, so a later run can still collect them — or choose Retry anyway if you have since changed network/IP or waited out a source throttle.`,
    };
  }

  return {
    ...(rootWarning || {}),
    code: rootWarning?.code || 'resolve-description-incomplete',
    severity: 'block',
    evidence: `${rootWarning?.evidence ? `${rootWarning.evidence} ` : ''}${accounting}`,
    suggestion: `${rootWarning?.suggestion ? `${rootWarning.suggestion} ` : ''}Click Solve again to retry the detail pages. Choose Skip only if you intentionally want to continue without the incomplete listings.`,
  };
}

/**
 * Summarize the evidence quality the scorer actually received. A successful LLM
 * response proves that a row was scored, not that it carried a full job
 * description. Keeping this separate from placeholder/unscored counts prevents
 * diagnostics from calling empty-list-card inputs "genuinely analyzed."
 */
export function summarizeScoringInputQuality(jobs, shortThreshold = JOB_DESCRIPTION_EVIDENCE_MIN_CHARS) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const summary = { total: rows.length, deferred: 0, empty: 0, short: 0, bySource: {}, samples: [] };
  for (const job of rows) {
    const source = job?.source || '?';
    const text = String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim();
    const length = text.length;
    const deferredReason = String(job?.descriptionDeferredReason || '').trim();
    const bucket = deferredReason ? 'deferred' : length === 0 ? 'empty' : length < shortThreshold ? 'short' : null;
    if (!bucket) continue;
    summary[bucket]++;
    const src = summary.bySource[source] || (summary.bySource[source] = { deferred: 0, empty: 0, short: 0 });
    src[bucket]++;
    if (summary.samples.length < 8) {
      summary.samples.push({
        source,
        title: String(job?.title || '(untitled)').slice(0, 140),
        url: String(job?.url || '').slice(0, 500),
        length,
        deferredReason,
      });
    }
  }
  return summary;
}

export function linkedInShortDescriptionWarning(jobs) {
  const short = (Array.isArray(jobs) ? jobs : []).filter(job => {
    const text = String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim();
    return text.length > 0 && text.length < JOB_DESCRIPTION_EVIDENCE_MIN_CHARS;
  });
  if (short.length === 0) return null;
  const samples = short.slice(0, 3).map(job =>
    `"${String(job.title || '(untitled)').replace(/\s+/g, ' ').slice(0, 80)}" (${String(job.snippet || job.description || '').replace(/\s+/g, ' ').trim().length} chars)`,
  ).join('; ');
  return {
    code: 'linkedin-description-short',
    severity: 'warn',
    shortLabel: 'Short description',
    evidence: `${short.length} LinkedIn job(s) have a non-empty description below the ${JOB_DESCRIPTION_EVIDENCE_MIN_CHARS}-character evidence threshold${samples ? `: ${samples}` : ''}. They may be genuine minimal postings or listing-card excerpts; they are deferred rather than scored in this run.`,
    suggestion: 'Open the affected listing before relying on its score. A future Solve/re-run may recover more text if LinkedIn served only an excerpt.',
  };
}

/** The same health check for rows that reach a gate through Solve or a resume, not a full search. */
export function sourceHealthWarningForRows(sourceId, rows, nodeId) {
  const warning = sourceHealthWarning(sourceId, assessSourceHealth(rows));
  if (warning) logger.error(`[Jobs][${nodeId}] Scrape health failed for ${sourceId}: ${warning.evidence}`);
  return warning;
}

/**
 * Keep only listings with enough employer-supplied text to be worth ranking.
 *
 * Brief/blank listings are deliberately omitted rather than scored, displayed,
 * or passed to the Job Board's seen-history write. A half-published posting can
 * therefore surface on a later run once its employer finishes it; recording it
 * as seen now would hide that improved version for the history retention window.
 */
export function filterJobsByDescriptionEvidence(jobs, shortThreshold = JOB_DESCRIPTION_EVIDENCE_MIN_CHARS) {
  const retained = [];
  const dropped = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const text = String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim();
    if (!job?.descriptionDeferredReason && text.length >= shortThreshold) retained.push(job);
    else dropped.push(job);
  }
  return {
    jobs: retained,
    dropped,
    quality: summarizeScoringInputQuality(dropped, shortThreshold),
  };
}

// The `descriptionDeferredReason` values that mean the LISTING ITSELF is gone,
// as opposed to "this pass could not read its description". Rows saved by an
// earlier version carry them, when the detail page itself said the posting no
// longer existed; the verdict was stored as `indeed-<reason>`.
// Deliberately excluded: 'description-rate-limited',
// 'description-panel-http-error', 'description-card-unavailable' and the
// detail-block reprobe codes. Every one of those is written onto rows the
// scraper explicitly RETAINED for a later pass to recover.
// Those rows also carry a boardClosed marker now: Indeed's own "gone" page is a
// board verdict, so the listing is retired only if the official-posting resolver
// did not keep it (see retiredListingKeys).
const RETIRED_LISTING_DEFERRED_REASONS = new Set(['indeed-page-unavailable', 'indeed-job-unavailable']);

/**
 * The keys an INCREMENTAL APPEND pass may report as `removedItemKeys`.
 *
 * The renderer (src/utils/jobSourceResolveMerge.js) reads removedItemKeys as
 * "this listing is retired" and deletes those rows from pendingJobs outright.
 * Sending the entire description-evidence drop set therefore destroyed rows a
 * PREVIOUS Solve had already recovered with a full description, the moment a
 * later pass re-served the same listing with a throttled or empty detail panel.
 * A short or empty snippet means "not recovered yet" — the append pass must
 * leave those rows in place. Only an explicit retirement marker removes one.
 * The retry-descriptions branch applies this filter too, on top of the
 * unconditional `retried.unavailable` retirements it also sends — that list
 * already means exactly "retired" and carries its own key/title/url rows. Its
 * replaceMatchingItems pairing does NOT make the raw drop set safe there; see
 * the comment on that branch's return.
 */
export function retiredListingKeys(droppedJobs = [], boardClosed = null) {
  const retired = (Array.isArray(droppedJobs) ? droppedJobs : [])
    .filter(job => RETIRED_LISTING_DEFERRED_REASONS.has(String(job?.descriptionDeferredReason || '')))
    .map(sourceJobKey)
    .filter(Boolean);
  // A board-closed row is only retired if the official-posting resolver did not
  // keep it: the board saying "gone" no longer settles anything by itself. Rows the
  // resolver dropped after the evidence gate (a board-closed row that still had a
  // description) retire here too.
  if (!boardClosed) return retired;
  const kept = boardClosed.keptKeys instanceof Set ? boardClosed.keptKeys : new Set();
  const deferred = boardClosed.deferredKeys instanceof Set ? boardClosed.deferredKeys : new Set();
  return [...new Set([...retired, ...(Array.isArray(boardClosed.droppedKeys) ? boardClosed.droppedKeys : [])])]
    .filter(key => !kept.has(key) && !deferred.has(key));
}

export function overlayResolvedRecoveryRows(rows, resolvedRows) {
  const resolved = new Map((Array.isArray(resolvedRows) ? resolvedRows : [])
    .filter(job => normalizeOfficialPosting(job?.officialPosting) || normalizeListingLiveness(job?.listingLiveness))
    .map(job => [sourceJobKey(job), job]));
  const source = Array.isArray(rows) ? rows : [];
  if (!resolved.size) return source;
  let changed = false;
  const overlaid = source.map(job => {
    const prior = resolved.get(sourceJobKey(job));
    if (!prior || !officialPostingRecordMatchesScrapedIdentity(job, { aliases: officialPostingAliases(prior) })) return job;
    changed = true;
    const projected = { ...job };
    const posting = normalizeOfficialPosting(prior.officialPosting);
    if (posting) { projected.postedBy = prior.postedBy; projected.officialPosting = posting; }
    const priorState = normalizeListingLiveness(prior.listingLiveness);
    const currentState = normalizeListingLiveness(job?.listingLiveness);
    if (priorState && (!currentState || Date.parse(priorState.at) >= Date.parse(currentState.at))) {
      projected.listingLiveness = priorState;
      const closed = normalizeBoardClosed(prior.boardClosed);
      if (closed) projected.boardClosed = closed;
      else delete projected.boardClosed;
    }
    return projected;
  });
  return changed ? overlaid : source;
}

export function snapshotDescriptionRecoveryJobs(snapshot) {
  const recovery = Array.isArray(snapshot?.descriptionRecoveryJobs)
    ? snapshot.descriptionRecoveryJobs : (Array.isArray(snapshot?.jobs) ? snapshot.jobs : []);
  return overlayResolvedRecoveryRows(recovery, snapshot?.jobs);
}

export function mergeDescriptionRecoverySourceJobs(recoveryJobs, sourceId, updatedSourceJobs) {
  const updates = new Map((Array.isArray(updatedSourceJobs) ? updatedSourceJobs : [])
    .map(job => [sourceJobKey(job), job]));
  return (Array.isArray(recoveryJobs) ? recoveryJobs : []).map(job =>
    job?.source === sourceId ? (updates.get(sourceJobKey(job)) || job) : job);
}

/**
 * A resolve window often mounts only the first visible slice of a source. Merge
 * that slice into the persisted recovery universe before judging completion:
 * otherwise Google can return the same 10 already-complete rows and incorrectly
 * clear a warning while dozens of deferred rows still exist off-screen.
 */
export function reconcileResolvedDescriptionRecovery(recoveryJobs, sourceId, resolvedSourceJobs) {
  const original = Array.isArray(recoveryJobs) ? recoveryJobs : [];
  const updated = Array.isArray(resolvedSourceJobs) ? resolvedSourceJobs : [];
  const universe = original.some(job => job?.source === sourceId)
    ? mergeDescriptionRecoverySourceJobs(original, sourceId, updated)
    : updated;
  const evidence = filterJobsByDescriptionEvidence(universe);
  return {
    recoveryJobs: universe,
    completeRows: evidence.jobs.filter(job => job?.source === sourceId),
    // A board-closed row is terminal, not "not recovered yet": reopening a page
    // the board already reported gone cannot add a description, and the
    // official-posting pass (not another Solve) decides whether it stays.
    emptyRows: evidence.dropped.filter(job => job?.source === sourceId && listingStateRank(job) < 3),
  };
}

/**
 * A resolved browser row is deliberately merged over its recovery candidate so
 * stable card identity/list fields survive a partial panel payload. Do not,
 * however, carry a historical deferral marker forward once the *new* row has
 * passed the same evidence contract used by scoring. Object spread cannot
 * express that absence, and retaining the candidate marker would immediately
 * re-defer the just-recovered row during reconciliation.
 */
export function mergeResolvedDescriptionRecoveryCandidate(candidate, resolvedRow, sourceId) {
  const merged = { ...candidate, ...resolvedRow, source: sourceId };
  if (Object.hasOwn(resolvedRow || {}, 'boardClosed') || Object.hasOwn(resolvedRow || {}, 'listingLiveness')) {
    delete merged.boardClosed;
    delete merged.listingLiveness;
    if (resolvedRow?.boardClosed !== undefined) merged.boardClosed = resolvedRow.boardClosed;
    if (resolvedRow?.listingLiveness !== undefined) merged.listingLiveness = resolvedRow.listingLiveness;
  }
  if (hasResolvedJobDescription(resolvedRow)) delete merged.descriptionDeferredReason;
  return merged;
}

/**
 * Partition deferred recovery identities by whether the fully revealed provider
 * list still contains them. Absence is distinct from a detail-panel miss: there
 * is no card to click, and repeatedly opening Solve cannot recover it unless the
 * provider returns that listing again on a later pass.
 */
export function partitionResolvedDescriptionRecoveryCandidates(recoveryJobs, sourceId, providerRows) {
  const sourceRecovery = (Array.isArray(recoveryJobs) ? recoveryJobs : [])
    .filter(job => job?.source === sourceId);
  // Board-closed rows are terminal (see reconcileResolvedDescriptionRecovery).
  const deferred = filterJobsByDescriptionEvidence(sourceRecovery).dropped.filter(job => listingStateRank(job) < 3);
  const deferredKeys = new Set(deferred.map(sourceJobKey).filter(Boolean));
  if (deferredKeys.size === 0) return { candidates: [], unavailable: [] };
  const candidates = (Array.isArray(providerRows) ? providerRows : [])
    .filter(job => job?.source === sourceId && deferredKeys.has(sourceJobKey(job)));
  const providerKeys = new Set(candidates.map(sourceJobKey).filter(Boolean));
  const unavailable = deferred.filter(job => {
    const key = sourceJobKey(job);
    return key && !providerKeys.has(key);
  });
  return { candidates, unavailable };
}

/**
 * Advance the durable recommendation shown for an unresolved provider row.
 *
 * TWO separate streaks are tracked, and they must stay separate. The first,
 * `consecutiveNoMatchPasses`, counts each full-list check where the same
 * deferred identities are unavailable. It intentionally ignores attempts,
 * recoveries, and totals for OTHER rows: progress elsewhere does not make an
 * unchanged missing listing any more likely to reappear, and must not break
 * the explicit "retry once more, then Skip" promise shown for that listing.
 *
 * That deliberate narrowness left a gap with no stall signal at all: a row that
 * IS found on the list every pass and fails during detail extraction never
 * qualifies, so the recommendation stayed 'retry' forever and the source card
 * kept inviting "Click Solve again" for an operation that could not succeed.
 * A real run spent hours on ~13 identical Solve passes against one card that
 * failed the same way every time. `consecutiveNoProgressPasses` closes that
 * gap with its own streak — cards attempted, none recovered, the same residual
 * set — surfaced as `stalled` rather than as `skip` so the two causes keep
 * their distinct explanations to the user.
 */
export function nextDescriptionRecoveryGuidance(previousState, observation, skipAfter = 2) {
  const rows = Array.isArray(observation?.unavailableRows) ? observation.unavailableRows : [];
  const unavailableKeys = [...new Set(rows.map(sourceJobKey).filter(Boolean))].sort();
  const unavailableSignature = unavailableKeys.join('|');
  const emptyRows = Array.isArray(observation?.emptyRows) ? observation.emptyRows : [];
  const emptyKeys = [...new Set(emptyRows.map(sourceJobKey).filter(Boolean))].sort();
  const emptySignature = emptyKeys.join('|');
  const providerRowsLoaded = Math.max(0, Number(observation?.providerRowsLoaded) || 0);
  const attempted = Math.max(0, Number(observation?.attempted) || 0);
  const recovered = Math.max(0, Number(observation?.recovered) || 0);
  const empty = Math.max(0, Number(observation?.empty) || 0);
  const completeTotal = Math.max(0, Number(observation?.completeTotal) || 0);
  const unavailableObserved = providerRowsLoaded > 0 && unavailableKeys.length > 0;
  const sameUnavailableSet = unavailableObserved
    && previousState?.unavailableSignature === unavailableSignature;
  const consecutiveNoMatchPasses = unavailableObserved
    ? (sameUnavailableSet ? Math.max(0, Number(previousState?.consecutiveNoMatchPasses) || 0) + 1 : 1)
    : 0;
  // Cards were opened and none of them yielded a description. Recovering even
  // one row is progress and resets the streak, because the next pass then has
  // a genuinely smaller problem to solve.
  const noProgressQualifies = providerRowsLoaded > 0
    && attempted > 0
    && recovered === 0
    && emptyKeys.length > 0;
  const sameEmptyResidual = noProgressQualifies
    && previousState?.emptySignature === emptySignature
    && Number(previousState?.completeTotal) === completeTotal;
  const consecutiveNoProgressPasses = noProgressQualifies
    ? (sameEmptyResidual ? Math.max(0, Number(previousState?.consecutiveNoProgressPasses) || 0) + 1 : 1)
    : 0;
  const threshold = Math.max(2, Math.floor(Number(skipAfter) || 2));
  const state = {
    consecutiveNoMatchPasses,
    consecutiveNoProgressPasses,
    unavailableSignature,
    unavailableCount: unavailableKeys.length,
    emptySignature,
    empty,
    completeTotal,
    providerRowsLoaded,
    attempted,
    recovered,
    updatedAt: new Date().toISOString(),
  };
  return {
    state,
    guidance: {
      recommendation: consecutiveNoMatchPasses >= threshold ? 'skip' : 'retry',
      consecutiveNoMatchPasses,
      consecutiveNoProgressPasses,
      unavailableCount: unavailableKeys.length,
      stalled: consecutiveNoProgressPasses >= threshold,
      threshold,
    },
  };
}

// A visible captcha/login window owns the single Chrome userDataDir while it is
// open. LinkedIn enrichment cannot use that profile concurrently, but this is a
// temporary scheduling conflict—not a clean enrichment result or a LinkedIn
// rate-limit. Keep an actionable Solve card so the user can retry after the
// other window closes.
export function linkedInBrowserUnavailableWarning(result = {}) {
  const detail = result.profileReserved
    ? 'A visible captcha or login window is using the shared browser profile.'
    : 'The shared browser could not be started for this enrichment pass.';
  return {
    code: 'browser-profile-reserved',
    severity: 'throttle',
    shortLabel: 'Browser busy',
    evidence: `LinkedIn descriptions were not fetched: ${detail}${result.browserError ? ` (${result.browserError})` : ''}`,
    suggestion: 'Finish and close the other captcha/login window, then click Solve to retry LinkedIn enrichment.',
  };
}

// All source IDs — defines the complete set for progress tracking and reporting.
export const ALL_SOURCE_IDS = [
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice',
  'usajobs',
];

export const ACTIVE_SOURCE_IDS = getScopedJobSourceIds(ALL_SOURCE_IDS);

export const ACTIVE_SOURCE_ID_SET = new Set(ACTIVE_SOURCE_IDS);

// Exact-token restart recovery may continue every provider in a durable,
// auto-eligible interrupted run, including browser-backed sources. It still
// stops after raw collection; the mounted Job Search owns role screening and
// every later AI handoff. The exact-manifest eligibility check below prevents
// a manual/login/CAPTCHA-gated source from being revived by an IPC bypass.
export const EXACT_RESUME_PROVIDER_ONLY_SOURCE_IDS = new Set([
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice', 'usajobs',
]);

// A fresh hidden Job Board child is not an interrupted run. Preserve its
// narrower no-browser bootstrap policy; browser recovery is allowed only when
// an exact durable Job Search manifest already owns the interrupted work.
export const BACKGROUND_PROVIDER_ONLY_SOURCE_IDS = new Set([
  'linkedin', 'remoteok', 'weworkremotely', 'dice', 'usajobs',
]);

export const JOB_SOURCE_DISPLAY_NAMES = Object.freeze({
  google: 'Google Jobs',
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  remoteok: 'RemoteOK',
  weworkremotely: 'We Work Remotely',
  ziprecruiter: 'ZipRecruiter',
  glassdoor: 'Glassdoor',
  dice: 'Dice',
  usajobs: 'USAJobs',
});

/**
 * Fresh collection requires every selected browser source to be authenticated.
 * A crash-resume reuses already-settled providers, so only manifest-unfinished
 * sources can legitimately become an auth block for that continuation.
 */
export function jobSourceAuthPreflightScope(browserSourceIds, resumeScope = null) {
  const sources = Array.isArray(browserSourceIds) ? browserSourceIds : [];
  return resumeScope instanceof Set
    ? sources.filter(sourceId => resumeScope.has(sourceId))
    : sources;
}

// A Solve window has to use the same list extractor and description-evidence
// path as its ordinary browser scrape.  Omitting a browser source here makes
// authWindows treat any substantial page body as a cleared challenge and close
// immediately, without collecting a single row.  Google was omitted when the
// description-first resolver was added for Glassdoor/ZipRecruiter, which is why
// a Google Jobs Solve on an already-clean result page closed as `body-text`.
const JOB_SOURCE_RESOLVE_CONFIG = Object.freeze({
  google: Object.freeze({
    extractorJS: GOOGLE_JOBS_EXTRACTOR,
    requiresDescriptionEnrichment: true,
  }),
  ziprecruiter: Object.freeze({
    extractorJS: ZIPRECRUITER_EXTRACTOR,
    requiresDescriptionEnrichment: true,
  }),
  glassdoor: Object.freeze({
    extractorJS: GLASSDOOR_EXTRACTOR,
    requiresDescriptionEnrichment: true,
  }),
});

/**
 * Resolve-window capabilities for a browser-backed job source.  Kept pure so
 * the Google resolver wiring is regression-tested without opening Chrome.
 */
export function getJobSourceResolveConfig(sourceId) {
  return JOB_SOURCE_RESOLVE_CONFIG[String(sourceId || '').toLowerCase()] || null;
}

// Fixed run order for the BROWSER-based sources, which must run ONE-AT-A-TIME on
// the shared Chrome profile (see sharedProfileLock.js). The order is intentional,
// not configuration-derived, so it holds regardless of which subset is enabled:
// solvable-challenge / login-gated sources first (Indeed login+Cloudflare, then
// ZipRecruiter's Turnstile, then Cloudflare-heavy Glassdoor) so the user can clear
// captchas early while watching; Google last because its high-volume detail-card
// walk is most likely to encounter a late callback throttle after the other
// interactive sources have finished. The
// pure-HTTP sources (linkedin/remoteok/weworkremotely/usajobs/dice) are NOT here —
// they run fully concurrent. Indeed runs first here but lives in its own launcher
// (fetchIndeedListingsBrowser); the rest are manual-scraper sources.
export const BROWSER_SCRAPE_ORDER = ['indeed', 'ziprecruiter', 'glassdoor', 'google'];

export function getQueryProgressTotal(queries) {
  return Math.max(1, Array.isArray(queries) ? queries.filter(Boolean).length : 1);
}

export function getCompletedQueriesFromDetail(detail, total) {
  const match = String(detail || '').match(/\bq(\d+)\/(\d+)\b/i);
  if (!match) return 0;
  const currentQuery = Number.parseInt(match[1], 10);
  const detailTotal = Number.parseInt(match[2], 10);
  const effectiveTotal = Number.isFinite(detailTotal) && detailTotal > 0 ? detailTotal : total;
  return Math.max(0, Math.min(effectiveTotal, currentQuery - 1));
}

// Synthesize a visible warning from a raw scrape error so a failed source can
// render its reason + a Solve button the INSTANT it fails — not only after the
// whole run finishes. Shared by the per-task progress event and the per-source
// completion loop so a timed-out source isn't left "failed but unflagged" for
// the (now much longer, deep-paginating) duration of the run — the window in
// which its resolve card could be mistaken for an idle/clean card and dismissed.
export function synthScrapeWarning(errorMsg) {
  const msg = String(errorMsg || 'Unknown error');
  if (/SITE_CHANGED/i.test(msg)) {
    return {
      code: 'stale-selectors',
      severity: 'warn',
      evidence: msg.slice(0, 240),
      suggestion: 'Extractor returned 0 results — the site HTML may have changed. Update the scraper code in electron/extractors/jobs.js, rebuild, and retry.',
    };
  }
  const isTimeout = /timed?\s*out|timeout/i.test(msg);
  // Widen when the browser pool folded a `[timeout-state …]` diag into the
  // message (finalUrl/bodyLen/title/bodyHead) — see enrichTimeoutError; that
  // snippet distinguishes page-never-loaded from a slow/tarpitting site and
  // would otherwise be truncated away by the tight default cap.
  const cap = /\[timeout-state /.test(msg) ? 700 : 240;
  return {
    code: isTimeout ? 'scrape-timeout' : 'scrape-failed',
    severity: 'block',
    evidence: msg.slice(0, cap),
    suggestion: isTimeout
      ? 'Site was unreachable or too slow within the budget. Often a soft block — try a fresh stealth profile or come back later.'
      : 'Scrape failed before extracting jobs. Check logs for the full stack trace.',
  };
}

export function getEffectiveSourceWarning(warning, jobCount) {
  if (!warning) return null;
  // A timeout on one query variant after other variants already returned jobs is
  // a partial scrape miss, not a source-level block that should masquerade as
  // an unresolved captcha/login problem. Keep the evidence, but downgrade the
  // severity for terminal status + source-card presentation.
  if (jobCount > 0 && warning.code === 'scrape-timeout' && warning.severity === 'block') {
    return { ...warning, severity: 'warn' };
  }
  return warning;
}

// A blocked ledger can represent either an unattended retry (transport,
// browser scrape, or enrichment failure) or a human gate. Startup recovery may
// retry the former, but never a durably identified login/CAPTCHA/configuration
// or hard-block gate. Unknown and legacy failures are intentionally automatic:
// explicit manual evidence is the only pause authority.
export function jobSourceRecoveryDisposition(sourceId, warnings = []) {
  const list = (Array.isArray(warnings) ? warnings : [warnings]).filter(Boolean);
  if (list.length === 0) return 'automatic';
  const needsHuman = list.some((warning) => {
    const code = String(warning?.code || '').trim().toLowerCase();
    const mode = String(warning?.resumeState?.mode || '').trim().toLowerCase();
    return warning?.severity === 'paste'
      || ['login-platform', 'open-external'].includes(warning?.action)
      || ['native-login', 'native-challenge'].includes(mode)
      || /(?:captcha|challenge|login|sign-in|auth|credentials?|config(?:uration)?-missing|cloudflare|hard-block)/i.test(code);
  });
  return needsHuman ? 'manual' : 'automatic';
}

const RECEIPT_COLLECTION_CAP_TYPES = new Set([
  'per-platform', 'jobs-per-platform', 'pages-per-platform',
  'auto-jobs-per-platform', 'auto-pages-per-platform', 'source-internal',
]);

// Merge only the compact, receipt-safe cap envelope. Both manual browser
// results and HTTP fan-out results pass through this before telemetry/staging;
// keeping the seam shared prevents one path from dropping Auto cap provenance.
export function mergeJobSourceCollectionCap(sourceResult, candidate) {
  if (!sourceResult || typeof sourceResult !== 'object'
      || !candidate || typeof candidate !== 'object'
      || !RECEIPT_COLLECTION_CAP_TYPES.has(candidate.type)
      || !Number.isSafeInteger(candidate.limit) || candidate.limit <= 0) return false;
  const cap = { type: candidate.type, limit: candidate.limit };
  if (!sourceResult.cap) sourceResult.cap = cap;
  if (!Array.isArray(sourceResult.caps)) sourceResult.caps = [];
  if (!sourceResult.caps.some(existing => existing?.type === cap.type && existing?.limit === cap.limit)) {
    sourceResult.caps.push(cap);
  }
  return true;
}

// Glassdoor's in-browser location resolver mutates task.url immediately before
// navigation. Keep the pre-search source URL indexes synchronized with that
// actual task URL before we emit a Solve target or persist it for telemetry.
// Exported as a small pure seam for the regression test below.
export function refreshManualSourceUrlIndex(tasks, sourceId, sourceFirstUrl, taskUrlById, resultId = null) {
  const liveSourceTasks = (Array.isArray(tasks) ? tasks : []).filter(task => task?.sourceId === sourceId);
  for (const task of liveSourceTasks) taskUrlById[task.id] = task.url;
  const liveFirstUrl = liveSourceTasks[0]?.url || (resultId ? taskUrlById[resultId] : null) || sourceFirstUrl[sourceId] || null;
  if (liveFirstUrl) sourceFirstUrl[sourceId] = liveFirstUrl;
  return liveFirstUrl;
}

// A manual source can wall after q2/q3, while a detail-enrichment block can
// first arm on q1 and remain latched as later queries execute. Start recovery
// from the exact first blocked query when supplied (otherwise the last actual
// navigation), and carry Glassdoor's resolved locId/locT scope forward.
export function orderedBlockedManualSourceUrls(tasks, sourceId, executedQueries = [], firstBlockedQuery = null, firstBlockedQueryIndex = null) {
  const sourceTasks = (Array.isArray(tasks) ? tasks : []).filter(task => task?.sourceId === sourceId);
  const executed = Array.isArray(executedQueries) ? executedQueries : [];
  const last = executed.at(-1);
  const firstMatch = firstBlockedQuery && sourceTasks.findIndex(task => task?.query === firstBlockedQuery);
  const index = Number.isInteger(firstBlockedQueryIndex) && firstBlockedQueryIndex >= 0 && firstBlockedQueryIndex < sourceTasks.length
    ? firstBlockedQueryIndex
    : Number.isInteger(firstMatch) && firstMatch >= 0 ? firstMatch : Math.max(0, sourceTasks.findIndex(task =>
    (last?.query && task?.query === last.query) || (last?.url && task?.url === last.url),
  ));
  const indexedTask = sourceTasks[index];
  // The explicit scraper index is authoritative even when generated query text
  // is blank or duplicated. Resolve its ACTUAL navigated URL by task URL first,
  // then query text; falling back to the last issued query is reserved for
  // legacy/manual results that carry no first-block identity at all.
  const indexedExecuted = Number.isInteger(firstBlockedQueryIndex)
    ? executed.find(entry => (indexedTask?.url && entry?.url === indexedTask.url)
      || (indexedTask?.query && entry?.query === indexedTask.query))
    : null;
  const firstExecuted = indexedExecuted || (firstBlockedQuery
    ? executed.find(entry => entry?.query === firstBlockedQuery)
    : last);
  const currentUrl = typeof firstExecuted?.url === 'string' && firstExecuted.url ? firstExecuted.url : sourceTasks[index]?.url;
  const queued = sourceTasks.slice(index + 1).map(task => task.url);
  if (sourceId === 'glassdoor' && currentUrl) {
    try {
      const current = new URL(currentUrl);
      const locId = current.searchParams.get('locId');
      const locT = current.searchParams.get('locT');
      if (locId || locT) {
        for (let i = 0; i < queued.length; i++) {
          const planned = new URL(queued[i]);
          if (locId) planned.searchParams.set('locId', locId);
          if (locT) planned.searchParams.set('locT', locT);
          queued[i] = planned.toString();
        }
      }
    } catch { /* malformed task URLs are ignored by the bounded queue */ }
  }
  return boundedRecoveryBlockedUrls([currentUrl, ...queued]);
}

export function dedupByTitleCompany(arr, options) {
  // Location-aware: title+company alone would silently collapse legitimately
  // distinct same-title/company reqs in different cities (see
  // dedupJobsAcrossSources's doc comment in jobIdentity.js).
  return dedupJobsAcrossSources(arr, options);
}

/**
 * Enforce the exact inclusive posting boundary before first-wins identity
 * deduplication. If an out-of-window mirror precedes an in-window copy, doing
 * these steps in the opposite order drops the valid copy as a duplicate and
 * then drops the retained old row by date, losing the posting entirely.
 */
export function filterAndDedupJobsByPostedSince(jobs, postedSince, {
  now = new Date(),
  onDuplicate,
} = {}) {
  const candidates = Array.isArray(jobs) ? jobs : [];
  const windowEligible = filterJobsByPostedSince(candidates, postedSince, now);
  return {
    windowEligible,
    deduped: dedupByTitleCompany(windowEligible, { onDuplicate }),
    ageDropped: candidates.length - windowEligible.length,
  };
}

/**
 * Apply the Jobs-per-platform allowance at the one boundary where it has its
 * advertised meaning: after the exact date window, and after duplicate cards
 * from the *same* platform have collapsed, but before different platforms are
 * compared with one another.  In particular, an old Google card, or a repeat
 * of one Glassdoor card from another generated query, must not consume one of
 * Google's/Glassdoor's slots and crowd out a later valid listing.
 *
 * This intentionally does not perform cross-platform title/company de-duping:
 * that happens immediately afterwards in the regular funnel, where the app
 * can retain its established first-wins provenance.  A platform's own quota is
 * independent of another platform returning a copy of the same vacancy.
 */
export function capPlatformJobsAfterWindow(jobs, postedSince, jobsPerPlatform, {
  now = new Date(),
} = {}) {
  const candidates = Array.isArray(jobs) ? jobs : [];
  // `postedSince` is either the run's single inclusive boundary (the historic
  // behaviour, byte-identical output) or a resolver so each platform applies its
  // OWN boundary. The resolver path filters per source group with the same
  // helper, then re-projects onto the original candidate order so downstream
  // first-wins provenance and per-source stats are unchanged.
  let windowEligible;
  if (typeof postedSince === 'function') {
    const bySource = new Map();
    for (const job of candidates) {
      const sourceId = String(job?.source || '?');
      const group = bySource.get(sourceId) || [];
      group.push(job);
      bySource.set(sourceId, group);
    }
    const eligible = new Set();
    for (const [sourceId, group] of bySource) {
      for (const job of filterJobsByPostedSince(group, postedSince(sourceId), now)) eligible.add(job);
    }
    windowEligible = candidates.filter(job => eligible.has(job));
  } else {
    windowEligible = filterJobsByPostedSince(candidates, postedSince, now);
  }
  const limit = Number.isFinite(Number(jobsPerPlatform)) && Number(jobsPerPlatform) > 0
    ? Math.floor(Number(jobsPerPlatform))
    : Infinity;
  const seenBySource = new Map();
  const acceptedBySource = new Map();
  const sourceStats = {};
  const accepted = [];

  const statsFor = (sourceId) => sourceStats[sourceId] || (sourceStats[sourceId] = {
    candidates: 0,
    windowEligible: 0,
    ageDropped: 0,
    duplicateDropped: 0,
    capDropped: 0,
    accepted: 0,
  });
  for (const job of candidates) {
    statsFor(String(job?.source || '?')).candidates++;
  }

  for (const job of windowEligible) {
    const sourceId = String(job?.source || '?');
    const stats = statsFor(sourceId);
    stats.windowEligible++;
    const seen = seenBySource.get(sourceId) || new Set();
    seenBySource.set(sourceId, seen);
    // Prefix the key defensively: sourceJobKey is deliberately source-aware,
    // but this also keeps a malformed/empty job from colliding across sources.
    const key = `${sourceId}|${sourceJobKey(job)}`;
    if (seen.has(key)) {
      stats.duplicateDropped++;
      continue;
    }
    seen.add(key);
    const acceptedForSource = acceptedBySource.get(sourceId) || 0;
    if (acceptedForSource >= limit) {
      stats.capDropped++;
      continue;
    }
    acceptedBySource.set(sourceId, acceptedForSource + 1);
    stats.accepted++;
    accepted.push(job);
  }
  for (const stats of Object.values(sourceStats)) {
    stats.ageDropped = Math.max(0, stats.candidates - stats.windowEligible);
  }

  return {
    jobs: accepted,
    windowEligible,
    ageDropped: candidates.length - windowEligible.length,
    sourceStats,
  };
}

export function boundedDedupProvenance(entries) {
  const MAX = 20;
  const out = [];
  const counts = {};
  for (const entry of entries) {
    const reason = entry?.reason || 'unknown';
    counts[reason] = (counts[reason] || 0) + 1;
    if (out.length >= MAX) continue;
    const brief = (job) => ({
      source: String(job?.source || '?').slice(0, 40),
      title: String(job?.title || '').slice(0, 120),
      company: String(job?.company || '').slice(0, 120),
      location: String(job?.location || '').slice(0, 120),
      url: String(job?.url || '').slice(0, 240),
      nativeId: String(job?.jobkey || job?.jobKey || job?.jobId || job?.id || '').slice(0, 120),
    });
    out.push({
      reason,
      ...(entry?.stage ? { stage: String(entry.stage).slice(0, 60) } : {}),
      kept: brief(entry.kept),
      dropped: brief(entry.dropped),
    });
  }
  return { total: entries.length, counts, entries: out, omitted: Math.max(0, entries.length - out.length) };
}

/**
 * Pick the top `n` jobs FAIRLY across sources (round-robin), preserving each
 * source's gathered order within its turn. Caps how many jobs reach the
 * quota-bound LLM scorer when a widened gather over-fills the budget, so we
 * score "the best slice across all sources" instead of letting whichever source
 * returned most monopolize the scoring budget. Returns all jobs unchanged when
 * there are <= n — which is the CURRENT state, since JOB_SCORE_CAP is Infinity.
 *
 * DO NOT read "gathered order" as "relevance order". Measured per platform:
 * LinkedIn and Google hold ~100% on-target at every depth, Glassdoor decays
 * (and then partially recovers) with depth, USAJobs has no usable relevance
 * ordering at all, and ZipRecruiter is INVERTED — its page 1 was its worst page
 * (35% on-target) rising to ~100% by page 25. So cutting a source at the head
 * keeps its worst rows on at least one platform. If a finite scoring budget is
 * ever reintroduced (see resultCaps.js), sample each source with a STRIDE
 * across its gathered rows rather than slicing the head.
 */
export function selectTopAcrossSources(jobs, n) {
  const arr = Array.isArray(jobs) ? jobs : [];
  if (n <= 0) return [];
  if (arr.length <= n) return arr;
  const groups = new Map();
  for (const j of arr) {
    const k = j?.source || 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  // Deterministic source order (larger groups first, then name) so the cut
  // doesn't depend on source-arrival order; gather order is kept within a group.
  const sources = [...groups.keys()].sort((a, b) => {
    const d = groups.get(b).length - groups.get(a).length;
    return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
  });
  const picked = [];
  const cursor = new Map(sources.map(s => [s, 0]));
  let advanced = true;
  while (picked.length < n && advanced) {
    advanced = false;
    for (const s of sources) {
      if (picked.length >= n) break;
      const g = groups.get(s);
      const i = cursor.get(s);
      if (i < g.length) { picked.push(g[i]); cursor.set(s, i + 1); advanced = true; }
    }
  }
  return picked;
}
