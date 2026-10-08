import electronPkg from 'electron';
const { dialog, app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import { handleSafe, snapshotActiveNodeTasks } from './ipcUtils.js';
import { getSellMonitorPlatforms, getJobLoginPlatforms, getSharedProfileReservationInfo, getStealthBrowserInfo, getBrowserProfileDiagnostics } from './stealthBrowser.js';
import { getManualScraperTelemetry } from './browser/manualScraper.js';
import { getLaunchCollisions } from './browserLaunchTelemetry.js';
import { getStatusCacheSync, getVerifyTimingSummary } from './accounts.js';
import { getRecentLogs } from '../logger.js';
import { getJobsTelemetry } from './jobs.js';
import { getMarketplaceTelemetry } from './marketplace.js';
import { getStatusCheckQueueDepth } from './statusCheckLock.js';
import { getSharedProfileLockSnapshot } from './sharedProfileLock.js';
import { getBudgetSnapshot } from './scrapeBudget.js';
import { getRateLimiterSnapshot } from './rateLimiter.js';
import { getKnownTaskIds, taskModelRoutingSnapshot } from './llm.js';
import { getNonApiAiHandoffLifecycle } from './nonApiAi.js';
import { CONSTANTS as HANDOFF_BRIDGE_CONSTANTS } from './handoffBridge/constants.js';
import { closeReportDiagnostic, redactReportLogSecrets, redactReportPath, redactReportLocalPathsInText, redactReportOpaqueIds, redactReportUrl, redactReportUrlsInText, redactReportEventHistoryLine, renderSessionRows, renderSessionTraceBlocks } from './bugReport/helpers.js';
import { buildMainProcessLogsMarkdown, buildReverseChronologicalLogBlock, EVENT_HISTORY_HEADING, enforceClipboardMarkdownCap } from './bugReport/clipboardCap.js';
import { buildFilterSummaryMarkdown, codeIncludesFull } from './bugReport/filterSummary.js';
import { codeIncludesApplicationOutput } from './bugReport/applicationOutput.js';
import { buildPasteHandoffDiagnosticsMarkdown } from './pasteHandoffDiagnostics.js';
import { buildPasteRejectionTraceMarkdown } from './bugReport/pasteRejectionTraceRollup.js';
import { buildWindowSizeLine, buildPointerProbeMarkdown } from './bugReport/pointerProbeMarkdown.js';
import { writeSavedBugReport, buildClipboardPointer } from './bugReport/reportFile.js';
import { resolveNodePresence } from '../../src/utils/nodePresence.js';
import { canAttemptJobSourceResolve, isJobSourceWarningGating } from '../../src/utils/jobSourceWarningPolicy.js';
import { findJobSearchBoardActiveRecoveryOwner } from '../../src/utils/jobBoardSearchSelection.js';
import { jobSearchNextAnchor, normalizeJobSearchInitialLookbackDays, resolveJobSearchDateWindow } from '../../src/utils/jobSearchDateWindow.js';
import { isGoogleJobsInternalUrl, normalizeJobListingExternalUrl } from '../../src/utils/jobListingUrl.js';
import { buildApplicationOutputReportSnapshot, buildJobBoardDiagnostics, buildJobCompletionAssessment, buildJobLinkSnapshot, buildJobRecoveryOfferSnapshot, buildJobRecoverySnapshot, buildJobsConfigSnapshot, buildJobsPipelineSnapshot, buildNonApiAiHandoffLifecycleMarkdown } from './bugReport/jobsSnapshot.js';
import { buildMarketplacePipelineSnapshot } from './bugReport/marketplaceSnapshot.js';
import { buildMarketplaceModuleRollup } from './bugReport/marketplaceModuleRollup.js';
import { buildSellHubPriceDropRollup } from './bugReport/sellHubPriceDropRollup.js';
import { buildSellHubResolveRollup } from '../../src/utils/sellHubResolveSnapshot.js';
import { getMissingPreviewRelinkDiagnostics } from './missingPreviewRelink.js';
import { getAuthWindowDiagnostics, NATIVE_LOGIN_PLATFORMS, PLATFORM_AUTH_COOKIES } from './browser/authWindows.js';
import { NATIVE_READ_PLATFORMS } from './browser/nativeChromeReader.js';
import {
  getJobSearchTransientKeysForSave,
  TRANSIENT_PROCESSING_HUB_STATES,
} from '../../src/utils/persistenceTransientState.js';
import { getHubDropLockReason, hubHasAcceptedInitialDrop } from '../../src/utils/hubDropEligibility.js';
import { completionTimestampIso } from '../../src/utils/completionTimestamp.js';
import { isBackgroundE2E } from '../utils/backgroundE2e.js';
import { getBridgeChatCopyDiagnostic, getBridgeQueueDiagnostic, getClientAuthDiagnostic, getFailedStartDiagnostic, getMcpRateLimitDiagnostic, getOAuthRejectionDiagnostic, getSourceRejectionDiagnostic } from './handoffBridge/telemetry.js';
import { getHandoffBridgeBootstrapDiagnostic } from './handoffBridge/index.js';
import { validateIssueReportDescription } from '../../src/utils/issueReportDescription.js';

// Captured at module load: the moment this code first ran in the main process.
// Used to detect when a user edits a source file but forgets to restart
// Electron — the renderer hot-reloads via Vite but the main-process modules
// keep running the old code, producing the maddening "I changed it, why isn't
// it doing the new thing?" failure mode.
const PROCESS_START_MS = Date.now();

function truncateDiagnosticText(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function reportCorrelationDigest(value, fallback = 'not recorded') {
  if (typeof value !== 'string' || !value) return fallback;
  return `#${crypto.createHash('sha256').update(value).digest('hex').slice(0, 10)}`;
}

// Keep Node Diagnostics aligned with JobCardNode's Open Listing action. The
// report needs only the effective route class, never the raw Google identity
// URL (whose query/fragment can contain opaque provider tokens).
function effectiveJobCardLinkState(data) {
  try {
    const raw = data?.url || data?.googleCardUrl;
    const effective = normalizeJobListingExternalUrl(data);
    if (!effective) return 'missing';
    return isGoogleJobsInternalUrl(raw) ? 'Google fallback' : 'direct';
  } catch {
    return 'missing';
  }
}

// These values contain user-authored preference text or research evidence.
// The diagnostic only needs to identify a stale persisted field, not its value.
const PRIVATE_JOB_PREFERENCE_TRANSIENT_KEYS = new Set([
  'activeJobPreferences', 'pendingJobPreferences', 'jobPreferencePlan',
  'pendingJobPreferencePlan', 'jobPreferencesInterpretation',
  'pendingJobPreferencesInterpretation', 'preferenceEvaluation',
  'preferenceCandidatePool',
]);

// This section only has to prove a transient key SURVIVED the save; the value
// is never the evidence. Echoing it by default was a leak waiting on the right
// hubState: `pendingCareerData` holds the user's raw career documents, so a
// leaked-state report on a non-`sources-ready` hub would have exported the
// first 60 characters of their résumé — name, and often email — into an
// artifact whose whole contract is that career data never leaves the machine.
// Inverted to an allowlist so a transient key added later cannot leak by
// default: only these short, non-document status strings are quoted.
const ECHOABLE_TRANSIENT_STRING_KEYS = new Set([
  'errorMessage', 'rerunOutcome', 'rerunNotice', 'pendingTargetRole',
]);

// Native Chrome challenge telemetry is intentionally metadata-only. In
// particular, Cloudflare challenge URLs can carry short-lived query tokens, so
// reports name the origin/path and never copy a query string from the native
// tab observer. Keep this formatter pure: the auth-window history is a small
// session ring and a report may be generated long after the main-log ring has
// discarded the decisive child-exit/poll sequence.
function redactNativeChallengeUrl(value) {
  return redactReportUrl(value).replace(/`/g, "'").slice(0, 180);
}

const NATIVE_INITIAL_SIGNALS = new Set(['caller-observed', 'url-or-title']);
const NATIVE_CLASSIFICATIONS = new Set(['hard-block', 'pending', 'cleared', 'unknown']);
const NATIVE_TERMINAL_SOURCES = new Set(['child-exit-after-clean', 'child-exit', 'app-close', 'abort', 'hard-block', 'stalled', 'poll-clear', 'timeout']);
const NATIVE_POST_CLOSE_OUTCOMES = new Set(['clean-tab-observed', 'profile-checkpoint-only', 'no-clearance-evidence', 'verify-error']);
const NATIVE_EXIT_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']);
const AUTH_RESULTS = new Set(['launching', 'open', 'auto-detected', 'closed', 'timeout', 'launch-error', 'app-window-destroyed', 'aborted', 'navigated', 'navigation-error', 'cleared', 'hard-block']);
const AUTH_CLOSE_DISPOSITIONS = new Set(['graceful-exit', 'sigterm-exit', 'sigkill-fallback', 'user-close-after-clean-observation']);
function nativeChallengeEnum(value, allowed) {
  return allowed.has(String(value || '')) ? String(value) : closeReportDiagnostic(value, '');
}
function authCloseDisposition(value, fallback = '—') {
  return AUTH_CLOSE_DISPOSITIONS.has(value) ? value : value ? 'recorded' : fallback;
}

/**
 * Bounded native-Indeed lifecycle evidence for the auth history row.
 *
 * `nativeChallenge` is recorded by authWindows when a non-CDP Chrome handoff
 * ends. It answers the otherwise ambiguous result="closed": did the child
 * exit before any tab could be observed, was the final tab still challenged,
 * or did an affirmative post-close check prove clearance? This is deliberately
 * not a cookie/body dump and all URLs have their query strings removed.
 */
export function buildNativeChallengeHistoryEvidence(attempt = {}) {
  const native = attempt?.nativeChallenge;
  if (!native || typeof native !== 'object') return '';
  const bits = [];
  if (typeof native.initialChallengeObserved === 'boolean') {
    bits.push(`initial challenge=${native.initialChallengeObserved ? 'yes' : 'no'}`);
  }
  const initialSignal = nativeChallengeEnum(native.initialSignal, NATIVE_INITIAL_SIGNALS);
  if (initialSignal) bits.push(`signal=${initialSignal}`);
  if (Number.isFinite(native.pollCount)) bits.push(`polls=${Math.max(0, Math.round(native.pollCount))}`);
  if (Number.isFinite(native.pollErrorCount) && native.pollErrorCount > 0) {
    bits.push(`poll errors=${Math.max(0, Math.round(native.pollErrorCount))}`);
  }
  // `polls=40; last=unknown` cannot separate "the observer watched a real
  // challenge page forty times and it never cleared" from "the observer never
  // had a tab to watch" — Chrome's Apple-event permission denied, or no
  // indeed.com tab ever in the inventory. Both render identically, and that
  // ambiguity is the entire reason this evidence exists, so print the two facts
  // authWindows now records. Absent on a record that predates the fields: print
  // nothing rather than a `no`, because "not recorded" is not an observation of
  // absence.
  if (typeof native.sawFirstPartyTab === 'boolean') {
    bits.push(`first-party tab seen=${native.sawFirstPartyTab ? 'yes' : 'no'}`);
  }
  // 200 is the producer's own cap on this field (authWindows slices it there
  // after collapsing whitespace), so rendering at the same width means this
  // renderer can never add a second, unmarked cut on top of the record's: what
  // prints here is exactly what the record retains.
  const firstPollError = closeReportDiagnostic(native.firstPollError, '');
  if (firstPollError) bits.push(`first poll error=${firstPollError}`);
  const classification = nativeChallengeEnum(native.lastClassification, NATIVE_CLASSIFICATIONS);
  if (classification) bits.push(`last=${classification}`);
  const tabUrl = redactNativeChallengeUrl(native.lastTabUrl);
  const tabTitle = closeReportDiagnostic(native.lastTabTitle, '');
  if (tabUrl || tabTitle) bits.push(`tab=${tabUrl || '—'}${tabTitle ? ` (${tabTitle})` : ''}`);
  const terminalSource = nativeChallengeEnum(native.terminalSource, NATIVE_TERMINAL_SOURCES);
  if (terminalSource) bits.push(`terminal=${terminalSource}`);
  if (native.exitCode != null || native.exitSignal) {
    bits.push(`child exit=${native.exitCode ?? '—'}${native.exitSignal ? `/${nativeChallengeEnum(native.exitSignal, NATIVE_EXIT_SIGNALS)}` : ''}`);
  }
  const verify = native.postCloseVerify && typeof native.postCloseVerify === 'object'
    ? native.postCloseVerify
    : null;
  if (verify) {
    const outcome = nativeChallengeEnum(verify.outcome, NATIVE_POST_CLOSE_OUTCOMES) || 'unknown';
    const reason = closeReportDiagnostic(verify.reason, '');
    const status = Number.isFinite(verify.status) ? ` HTTP ${Math.round(verify.status)}` : '';
    const finalUrl = redactNativeChallengeUrl(verify.finalUrl || verify.url);
    bits.push(`post-close=${outcome}${status}${reason ? ` (${reason})` : ''}${finalUrl ? ` → ${finalUrl}` : ''}`);
  }
  return bits.length ? ` · native: ${bits.join('; ')}` : '';
}

// authWindows.js already bounds the completed-window ring (its AUTH_HISTORY_CAP
// keeps the newest 16 completed auth windows). A SECOND, smaller cap inside a
// renderer therefore buys no size safety — it only decides WHICH of the <=16
// retained records a report is allowed to show, and that is exactly what cost
// the Indeed native-handoff incident its evidence: the ring held 15 records, so
// nothing had been evicted upstream, yet a blind newest-12 slice pushed all
// three `indeed-native-challenge` rows out behind 12 routine `captcha:` rows —
// emptying the ONLY render site of buildNativeChallengeHistoryEvidence at
// filter code FULL, the most verbose setting there is.
//
// The selection is widened to the whole retained ring rather than reserving a
// lane for "interesting" records: it costs at most four extra lines, there is
// no selection rule that can itself pick the wrong records, and strict
// newest-first ordering — which every row's "Xs ago" reading depends on —
// survives by construction instead of by a merge that has to re-sort a union.
// This mirrors the non-exported AUTH_HISTORY_CAP; scripts/tests/job-diagnostics.js
// pins the two together so this cannot silently drift back into re-capping the
// ring below what the ring retains.
const AUTH_HISTORY_RING_CAP = 16;

/**
 * Newest-first selection over an auth-window history, with COMPUTED counts.
 *
 * Callers must not assume how many rows they got: the truncation marker below
 * may only state numbers that were actually measured here, and `retained` is
 * the length of the list as handed in — never a constant. PURE for tests.
 */
export function selectAuthHistoryForReport(history, limit = AUTH_HISTORY_RING_CAP) {
  const retainedRows = (Array.isArray(history) ? history : []).filter(Boolean);
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : retainedRows.length;
  const rows = retainedRows.slice(-cap).reverse();
  return {
    rows,
    shown: rows.length,
    retained: retainedRows.length,
    dropped: Math.max(0, retainedRows.length - rows.length),
  };
}

/**
 * Truncation marker for a rendered auth-history list.
 *
 * Emitted ONLY when rows were actually dropped, and worded so that nothing in
 * it can be falsified: both counts come from selectAuthHistoryForReport's
 * measurement of this very render, and the ring bound is the one this process
 * applies upstream. A complete list prints nothing — a marker on a list that
 * shows everything it holds would read as evidence of a loss that never
 * happened, which is the same failure in the other direction as the prose this
 * replaced ("Every completed login/captcha window") claiming completeness on a
 * list that was silently cut.
 */
export function formatAuthHistoryTruncationNote(selection, label = 'record(s)') {
  if (!selection || !(selection.dropped > 0)) return '';
  return `\n_(Truncated: showing the ${selection.shown} newest of ${selection.retained} ${label} this process still retains; ${selection.dropped} older retained record(s) are not shown here. The session ring keeps at most ${AUTH_HISTORY_RING_CAP} completed auth windows, so anything older than that was already discarded upstream and is not counted in either number.)_\n`;
}

/**
 * "### Completed auth-browser close lifecycle" — the close/checkpoint table.
 *
 * Exported and pure so a test can drive it with a fixture ring: the live
 * auth-window ring has no seam a report-level test can seed, which is why the
 * column contract below (and the mislabelled pre-close column it replaces)
 * went unguarded.
 */
export function buildAuthLifecycleTableMarkdown(history) {
  // The lifecycle only needs to establish whether each launch had a configured
  // executable/profile; private path components do not aid that diagnosis.
  const execLabel = (value) => redactReportPath(value, '—');
  const profileLabel = (value) => redactReportPath(value, '—');
  const retainedRecords = (Array.isArray(history) ? history : []).filter(Boolean);
  const isLifecycleMode = (item) => item?.mode === 'puppeteer-visible' || item?.mode === 'native-chrome';
  const selection = selectAuthHistoryForReport(retainedRecords.filter(isLifecycleMode));
  // This table renders TWO of the ring's modes, so an empty body is not evidence
  // that no auth window completed: a session whose only visible windows were
  // `captcha-resolve` windows retains those records and still empties this
  // table. Saying "no completed auth window this process" there asserts an
  // absence the report did not observe, on the exact table a reader consults to
  // decide whether a window ever opened. Count what the filter actually excluded
  // and name the modes it saw, so the empty state describes the filter rather
  // than the ring.
  const excludedRecords = retainedRecords.filter(item => !isLifecycleMode(item));
  const excludedModes = Array.from(new Set(excludedRecords.map(item => (
    item?.mode ? String(item.mode).slice(0, 40) : 'no mode recorded'
  )))).slice(0, 6);
  const lifecycleRows = selection.rows.map(item => {
    const cookies = (Array.isArray(item.authCookiesBeforeClose) ? item.authCookiesBeforeClose : [])
      .map(cookie => `${cookie.name || '?'}:${cookie.persistent ? 'persistent' : 'session'}${cookie.expiresAt ? ` exp=${new Date(cookie.expiresAt * 1000).toISOString()}` : ''}`)
      .join(', ') || 'none captured';
    const loginDetected = item.loginDetected == null
      ? (item.mode === 'native-chrome' && String(item.platformId || '').endsWith('-native-challenge')
          ? `n/a (challenge ${item.result || 'completed'})`
          : 'not recorded')
      : (item.loginDetected ? 'yes' : 'no');
    // cookieFlushMs alone cannot say WHEN it was measured, and the old column
    // header ("Pre-close wait ms") asserted a phase for every producer: on the
    // child-exit path the number is a POST-close observation of the profile's
    // cookie store, i.e. Chrome was already gone when it was taken. Print the
    // stamped phase beside the number and, when no phase is stamped (records
    // written before the producers stamped one), say that rather than name a
    // phase this record never carried.
    const flushMs = Number.isFinite(item.cookieFlushMs) ? item.cookieFlushMs : null;
    const flushPhase = item.cookieFlushPhase ? String(item.cookieFlushPhase) : null;
    const flushCell = `${flushMs ?? '—'} (${flushPhase ? `phase ${flushPhase}` : 'phase not recorded'})`;
    return `| \`${item.platformId || '?'}\` | ${item.mode || '—'} | ${loginDetected} | ${flushCell} | ${item.cookieStoreCommitted == null ? 'n/a' : (item.cookieStoreCommitted ? 'yes' : 'NO')} | ${authCloseDisposition(item.closeDisposition)} | ${item.processExitObserved == null ? '—' : (item.processExitObserved ? 'yes' : 'NO')} | \`${execLabel(item.executable)}\` | \`${profileLabel(item.profileDir)}\` | ${cookies} |`;
  }).join('\n');
  // A Markdown table cell cannot contain a literal `|`, so the mode list is
  // comma-joined and this sentence carries none.
  const emptyLifecycleCell = retainedRecords.length === 0
    ? "this process's auth-window ring retains no completed auth window at all"
    : `no retained record has mode \`puppeteer-visible\` or \`native-chrome\`, the two modes this table renders; the ${excludedRecords.length} other retained record(s) it holds (mode: ${excludedModes.join(', ')}) are excluded by that filter — they are listed under "Recent login and captcha attempts (this session)" in Auth Window Diagnostics whenever that section is part of the report`;
  return `### Completed auth-browser close lifecycle (newest first)
> The completed auth windows this process still retains **whose mode is
> \`puppeteer-visible\` or \`native-chrome\`**, newest first. Other retained
> modes (e.g. \`captcha-resolve\`) are not rows here.
> **Cookie flush wait** is the measured wait around the profile cookie-store
> check plus the phase its producer stamped: \`pre-close-fixed\` and
> \`pre-close-checkpoint\` were measured while the window was still open;
> \`post-close-observe\` was measured after the child process had already
> exited, so it is not a wait taken before closing. \`phase not recorded\`
> means this record carries no stamped phase.

| Platform | Mode | Login detected | Cookie flush wait ms (phase) | Store checkpointed | Close disposition | Process exit observed | Executable | Profile | Auth cookie metadata before close |
|---|---|---:|---|---|---|---:|---|---|---|
${lifecycleRows || `| — | — | — | — | — | — | — | — | — | (${emptyLifecycleCell}) |`}${formatAuthHistoryTruncationNote(selection, 'completed auth-window record(s)')}`;
}

/**
 * "### Native Chrome challenge handoffs" — ALWAYS rendered.
 *
 * buildNativeChallengeHistoryEvidence had exactly one render site: inside the
 * capped "Recent login and captcha attempts" list, itself inside a block that
 * only renders when an auth window or a launch collision exists. Its output was
 * therefore all-or-nothing, and in the Indeed incident all three
 * `indeed-native-challenge` records fell out of that list, leaving a FULL
 * report with no trace of why three real user verifications were never observed
 * as cleared. This section reads the same ring with the same predicate as that
 * call site, renders unconditionally, and has an explicit empty state, so the
 * evidence can no longer be evicted by unrelated captcha traffic.
 *
 * Bounded and privacy-safe by construction: the ring holds at most
 * AUTH_HISTORY_RING_CAP records, redactNativeChallengeUrl strips query strings
 * (Cloudflare challenge URLs carry short-lived tokens), and no cookie value is
 * read here.
 */
export function buildNativeChallengeSessionMarkdown(history) {
  const selection = selectAuthHistoryForReport(
    (Array.isArray(history) ? history : []).filter(item => item?.mode === 'native-chrome'
      && String(item?.platformId || '').endsWith('-native-challenge')),
  );
  const lines = selection.rows.map(item => {
    const finishedAt = item.finishedAt ? new Date(item.finishedAt) : null;
    const finishedMs = finishedAt && !Number.isNaN(finishedAt.getTime()) ? finishedAt.getTime() : null;
    const finishedIso = finishedMs == null ? 'not recorded' : new Date(finishedMs).toISOString();
    const age = finishedMs == null ? 'age not recorded' : `${Math.max(0, Math.round((Date.now() - finishedMs) / 1000))}s ago`;
    const open = Number.isFinite(item.openMs) ? `${(item.openMs / 1000).toFixed(1)}s` : 'not recorded';
    const committed = item.cookieStoreCommitted == null ? 'not observed' : (item.cookieStoreCommitted ? 'yes' : 'NO');
    const native = item.nativeChallenge && typeof item.nativeChallenge === 'object' ? item.nativeChallenge : null;
    const exitObserved = !!native && (native.exitCode != null || !!native.exitSignal);
    // A bare `—` here reads as "we have no idea how this window ended", which is
    // wrong on the path that matters most: when the child process exit is the
    // terminal observation there IS no app-initiated close to stamp. Report both
    // observations side by side and let the reader draw the conclusion.
    const closeDisposition = item.closeDisposition
      ? `\`${authCloseDisposition(item.closeDisposition, 'recorded')}\``
      : exitObserved
        ? `none stamped on this record; the child process exit WAS observed (exit code ${native.exitCode ?? '—'}${native.exitSignal ? `/${nativeChallengeEnum(native.exitSignal, NATIVE_EXIT_SIGNALS)}` : ''}${native.terminalSource ? `, terminal source ${nativeChallengeEnum(native.terminalSource, NATIVE_TERMINAL_SOURCES)}` : ''})`
        : 'none stamped on this record, and no child process exit was observed on it either';
    const evidence = buildNativeChallengeHistoryEvidence(item)
      || ' · native: no bounded handoff evidence is retained on this record';
    return `- \`${item.platformId || '?'}\` — finished ${finishedIso} (${age}) · result **${AUTH_RESULTS.has(item.result) ? item.result : item.result ? 'recorded' : 'not recorded'}** · open ${open} · cookie store checkpointed ${committed} · close disposition: ${closeDisposition}${evidence}`;
  });
  const body = lines.length > 0
    ? lines.join('\n')
    : "_No native challenge handoff record is retained in this process's auth-window ring. That describes what the ring currently holds; it is not an observation that no native challenge handoff occurred — the ring keeps at most "
      + `${AUTH_HISTORY_RING_CAP} completed auth windows and starts empty at every app start._`;
  return `### Native Chrome challenge handoffs (newest first)
> Always rendered, independently of the Auth Window Diagnostics attempt list
> (which is itself conditional and capped), so whatever bounded evidence a
> native handoff record retained reaches the report instead of being evicted by
> unrelated captcha traffic. What a record retains varies, and each bit below is
> printed only when that record carries it: the poll counters, whether a
> first-party tab was ever seen (\`first-party tab seen=no\` means no tab the
> observer could read as this handoff's own appeared in any inventory read — it
> does not say why, and a denied Apple-event permission and a tab that never
> opened look identical here; it is, however, not the same observation as
> watching a challenge page that never cleared), the first tab-read error, the
> last classification, the child exit, and any post-close verification. A record that
> carries none of them says so rather than rendering as an empty trace.
> \`result\` is what the app
> OBSERVED, not what the user did: \`closed\` means no affirmative clearance
> observation was recorded before the window went away, which is not the same as
> the verification having failed. Metadata only — URL query strings are stripped
> and no cookie value is read.

${body}${formatAuthHistoryTruncationNote(selection, 'native challenge handoff record(s)')}
`;
}

/**
 * Renders getStealthBrowserInfo().activity — what the shared singleton is
 * DOING, not just whether it's alive. This is the difference between "our own
 * idle browser held the profile lock" and "something else did" (see the
 * profile-lock incident this was added for: a post-login cookie check woke
 * the singleton, which then sat holding the shared userDataDir with nothing
 * open on it for the rest of the session). `livePageCount === null` means the
 * activity cache has no honest observation for the CURRENT browser generation
 * — report that as "not observed", never guess it as idle.
 */
function formatStealthBrowserActivity(activity) {
  if (!activity || activity.livePageCount == null) return 'not observed';
  const ageSec = Number.isFinite(activity.observedAt)
    ? Math.max(0, Math.round((Date.now() - activity.observedAt) / 1000))
    : null;
  const ageBit = ageSec == null ? '' : ` (observed ${ageSec}s ago)`;
  if (activity.livePageCount === 0) return `idle — 0 live pages${ageBit}`;
  const urls = Array.isArray(activity.livePageUrls)
    ? activity.livePageUrls.map(u => redactReportUrl(u).replace(/[`|]/g, "'")).join(', ')
    : '';
  return `${activity.livePageCount} live page(s)${ageBit}${urls ? `: ${urls}` : ''}`;
}

// A report is collected precisely when app state may be malformed. Keep one
// broken diagnostic section from suppressing the rest, but make that omission
// explicit (and bounded) so it cannot be mistaken for an observed empty state.
function diagnosticRenderFailureMarkdown(section, err) {
  const detail = closeReportDiagnostic(err?.message || err, 'recorded');
  return `\n## ${section}\n_(section failed to render; diagnostic: \`${detail}\`)_\n`;
}

/** Render one startup-verification outcome without mistaking cached state for proof. */
export function formatLoginVerificationTimingResult(duration = {}) {
  const state = duration.connected ? 'connected' : 'not connected';
  const detail = closeReportDiagnostic(duration.reason || duration.skipReason || duration.error, '');
  const withReason = (label) => detail ? `${label} — ${detail}` : label;

  switch (duration.outcome) {
    case 'verified':
      // A fresh `connected` needs no explanation; a fresh NOT-connected is the row
      // the reader has to act on, and its reason names the check that rejected it.
      return duration.connected ? 'verified connected' : withReason('verified not connected');
    case 'retained-prior':
      return withReason(`retained prior: ${state}${duration.inconclusive ? ' (inconclusive verify)' : ''}`);
    case 'skipped-native':
      return withReason(`skipped native read (prior: ${state})`);
    case 'skipped-login-flow':
      return withReason(`skipped during login flow (prior: ${state})`);
    case 'error':
      return `error: ${detail || 'recorded'}`;
    default:
      // Older running processes may have duration records from before `outcome`
      // was introduced. Keep their prior report shape rather than treating them
      // as an unverified failure.
      if (duration.skipped) return withReason('skipped');
      if (duration.error) return `error: ${closeReportDiagnostic(duration.error, 'recorded')}`;
      return duration.connected ? 'connected' : 'not connected';
  }
}

export function buildLoginVerificationTimingMarkdown(run) {
  if (!run || !Array.isArray(run.durations) || run.durations.length === 0) return '';
  const durations = run.durations;
  const sumMs = durations.reduce((a, d) => a + (d.ms || 0), 0);
  const slowest = durations[0]; // durations are pre-sorted slowest-first
  // Auth-cookie presence rides in the Result cell rather than a column of its own:
  // it is recorded only for the platforms that have a known auth cookie AND read
  // logged-out, so a dedicated column would be empty for most rows.
  const cookieSuffix = (d) => (typeof d.authCookiePresent === 'boolean'
    ? (d.authCookiePresent ? ' · auth cookie present' : ' · auth cookie ABSENT')
    : '');
  const rows = durations.map(d =>
    `| \`${d.platformId}\` | ${d.ms} | ${formatLoginVerificationTimingResult(d)}${cookieSuffix(d)} |`,
  ).join('\n');
  const savedMs = Math.max(0, sumMs - run.totalMs);
  // `platformCount` historically meant every platform considered by the
  // startup pass, including CDP-walled native-read platforms. Count outcomes
  // from the timing rows so the report never calls a skipped native read a
  // fresh verification. Old running builds have no `outcome`; retain a useful
  // best-effort classification from their existing skipped/error fields.
  const classify = (duration) => {
    switch (duration?.outcome) {
      case 'skipped-native': return 'skipped-native';
      case 'skipped-login-flow': return 'skipped-login-flow';
      case 'retained-prior': return 'retained-prior';
      case 'error': return 'error';
      case 'verified': return 'verified';
      default:
        if (duration?.skipped) return 'skipped-legacy';
        if (duration?.error) return 'error';
        return 'verified';
    }
  };
  const outcomes = durations.map(classify);
  const count = (kind) => outcomes.filter(outcome => outcome === kind).length;
  const considered = durations.length;
  const summaryCount = Number(run.platformCount);
  const countMismatch = Number.isFinite(summaryCount) && summaryCount !== considered
    ? ` (timing rows: ${considered}; run summary: ${summaryCount})`
    : '';
  const verified = count('verified');
  const retained = count('retained-prior');
  const errors = count('error');
  const freshAttempts = verified + retained + errors;
  const skippedNative = count('skipped-native');
  const skippedLoginFlow = count('skipped-login-flow');
  const skippedLegacy = count('skipped-legacy');
  const freshOutcomeParts = [
    `${verified} fresh verdict${verified === 1 ? '' : 's'}`,
    retained ? `${retained} retained prior after inconclusive verify` : null,
    errors ? `${errors} error${errors === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const skippedOutcomeParts = [
    skippedNative ? `${skippedNative} native-state read${skippedNative === 1 ? '' : 's'}` : null,
    skippedLoginFlow ? `${skippedLoginFlow} login-flow skip${skippedLoginFlow === 1 ? '' : 's'}` : null,
    skippedLegacy ? `${skippedLegacy} legacy generic skip${skippedLegacy === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return `
## Login Verification Timing
> Per-platform startup verify durations (\`verifyAllPlatforms\`). Each platform is
> considered at startup; each fresh verifier attempt is a full page navigation in
> the shared stealth browser, while native-state and login-flow skips do not
> navigate. Fresh attempts run through a bounded concurrency pool (size
> ${run.concurrency}) — so wall time is well below the sum of per-platform times.
> Results distinguish a fresh verifier verdict from a prior cached state retained
> after an inconclusive verify.

- Run started: \`${new Date(run.startedAt).toISOString()}\`
- Platforms considered: ${considered}${countMismatch}
- Fresh verifier attempts: ${freshAttempts} — ${freshOutcomeParts.join('; ') || 'no outcome recorded'}
- Skipped without a verifier navigation: ${skippedNative + skippedLoginFlow + skippedLegacy}${skippedOutcomeParts.length ? ` — ${skippedOutcomeParts.join('; ')}` : ''}
- Concurrency pool: ${run.concurrency}
- **Wall-clock total: ${run.totalMs}ms** (sum of per-platform: ${sumMs}ms — concurrency saved ~${savedMs}ms)
- Slowest: \`${slowest.platformId}\` at ${slowest.ms}ms

| Platform ID | Verify ms | Result |
|---|---|---|
${rows}
`;
}


/**
 * Returns `{ src, srcDirFound, bundle, bundleDirFound }` describing the newest
 * main-process code file the running build depends on. Comparing `src`/`bundle`
 * to PROCESS_START_MS tells us whether any code changed since the process
 * booted — the stale-build signal we want.
 *
 * It scans BOTH the source tree (`electron/`) and the bundle (`dist-electron/`),
 * under whichever of app.getAppPath()/process.cwd() they live:
 *   • `electron/` source catches "edited a file but didn't rebuild" (dev).
 *   • `dist-electron/` bundle is the artifact actually running — and in a
 *     PACKAGED app the `electron/` source isn't shipped at all (only the bundle
 *     is inside app.asar). The bundle is .cjs/.mjs, not .js, so the old
 *     `.js`-only filter missed it even when the dir was present.
 *
 * The two trees are returned SEPARATELY (not merged into one max, as this used
 * to do) because a packaged app can only ever see `dist-electron/` — `electron/`
 * genuinely does not exist on disk there. A merged number silently degraded to
 * "whatever the bundle says" in that case while the report kept printing a
 * source-freshness verdict it had no basis for. `srcDirFound`/`bundleDirFound`
 * let the caller tell "this tree was scanned and is empty/unchanged" apart from
 * "this tree was never found at all" — the difference between an observation
 * and its absence, which the verdict text must not blur.
 */
function getNewestMainProcessMtimes() {
  const CODE_EXT = /\.(c|m)?js$/; // .js, .cjs, .mjs
  const roots = [];
  try { if (app?.getAppPath) roots.push(app.getAppPath()); } catch { /* ignore */ }
  try { roots.push(process.cwd()); } catch { /* ignore */ }

  // Scans every `<root>/<subdir>` tree and reports both the newest matching
  // mtime AND whether the top-level `<root>/<subdir>` directory itself was
  // ever readable (as opposed to a nested dir found mid-walk) — that's the
  // "was this tree even here to look at" signal callers need.
  const scanSubdir = (subdir) => {
    let newest = 0;
    let dirFound = false;
    const seen = new Set();
    const walk = (dir, isCandidateRoot) => {
      const resolved = path.resolve(dir);
      if (seen.has(resolved)) return;
      seen.add(resolved);

      let entries = [];
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
        if (isCandidateRoot) dirFound = true;
      } catch { return; }
      for (const entry of entries) {
        // Defensive: these dirs shouldn't contain node_modules, but never recurse
        // into it (or dotfiles) if a candidate root ever broadens.
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(resolved, entry.name);
        if (entry.isDirectory()) { walk(fullPath, false); continue; }
        if (!entry.isFile() || !CODE_EXT.test(entry.name)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > newest) newest = stat.mtimeMs;
        } catch { /* skip */ }
      }
    };

    for (const root of roots) {
      if (!root) continue;
      walk(path.join(root, subdir), true);
    }
    return { newest: newest || null, dirFound };
  };

  const src = scanSubdir('electron');
  const bundle = scanSubdir('dist-electron');
  return {
    src: src.newest,
    srcDirFound: src.dirFound,
    bundle: bundle.newest,
    bundleDirFound: bundle.dirFound,
  };
}

/**
 * Renderer (React/Vite) freshness. getNewestMainProcessMtimes above scans
 * only electron/ + dist-electron/ — but the renderer (`src/`) is where the
 * Job Search Module pipeline, the AI-scoring/test-mode gate, and most UI logic live. When
 * the app loads the BUILT bundle (main.js does loadFile('../dist/index.html')
 * whenever there's no Vite dev server), an edit to `src/` that was never
 * re-bundled means the running UI is STALE even though the main process is
 * current — the "fixed the code but it still does the old thing" trap that the
 * main-process-only check silently passed (reporting "✅ up to date").
 *
 * Returns the newest mtime under `src/` (source) and under `dist/` (the built
 * renderer bundle the app actually loads), or null for whichever can't be read.
 */
function getNewestRendererMtimes() {
  const roots = [];
  try { if (app?.getAppPath) roots.push(app.getAppPath()); } catch { /* ignore */ }
  try { roots.push(process.cwd()); } catch { /* ignore */ }

  const newestUnder = (subdir, extTest) => {
    let newest = 0;
    const seen = new Set();
    const walk = (dir) => {
      const resolved = path.resolve(dir);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      let entries = [];
      try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(resolved, entry.name);
        if (entry.isDirectory()) { walk(fullPath); continue; }
        if (!entry.isFile() || !extTest.test(entry.name)) continue;
        try { const stat = fs.statSync(fullPath); if (stat.mtimeMs > newest) newest = stat.mtimeMs; }
        catch { /* skip */ }
      }
    };
    for (const root of roots) if (root) walk(path.join(root, subdir));
    return newest || null;
  };

  return {
    src: newestUnder('src', /\.(jsx?|tsx?|css|html)$/),  // renderer sources
    bundle: newestUnder('dist', /./),                    // any file — a rebuild touches them all
  };
}

/**
 * Captures the local non-api-ai registry that owns every task lifecycle.
 * Requests normally surface in the copy/paste dock; an eligible task can also
 * be released from a selected hub to the locally hosted MCP bridge. That is a
 * delivery route into the same registry, not a provider/API/model selection.
 * The actual pass/fail evidence for a specific handoff lives in the lifecycle
 * and bridge sections below.
 */
function buildAIConfigSnapshot() {
  let knownTaskIds = [];
  try { knownTaskIds = [...getKnownTaskIds()].sort(); } catch { /* keep the rest of the report */ }
  let routing = null;
  try { routing = taskModelRoutingSnapshot(); } catch { /* keep the rest of the report */ }
  return {
    transport: routing?.transport || 'non-api-ai',
    knownTaskIds,
    knownTaskCount: knownTaskIds.length,
  };
}

/**
 * Renders the live tuning state of the scrape pipeline — the answer to "why did
 * this source time out / get blocked / run so slowly?" reports.
 *
 * Two halves with different lifetimes:
 *   - Rate limiter (rateLimiter.js): IN-MEMORY, resets each run. A domain's
 *     `tighten` (≥1) multiplies its seed cooldown after throttle/block signals
 *     and decays on success; global pressure shrinks pool concurrency. We list
 *     only domains that actually hit a throttle/block/error this session.
 *   - Learned budgets (scrapeBudget.js): PERSISTED across runs. Per-source EMA
 *     of time-to-ready, used to size each source's working timeout (never above
 *     its seed). Present even with no scraping this session.
 *
 * Returns '' when there's nothing to show, so the section self-omits.
 */
function buildScraperAdaptationSnapshot() {
  let rl = null, budgets = null;
  try { rl = getRateLimiterSnapshot(); } catch { /* non-fatal */ }
  try { budgets = getBudgetSnapshot(); } catch { /* non-fatal */ }

  const rlLines = [];
  if (rl && rl.domains && Object.keys(rl.domains).length > 0) {
    // Only domains that meaningfully tightened or saw a non-ok outcome — an
    // all-clean domain at tighten=1 is just noise here.
    const hot = Object.entries(rl.domains)
      .filter(([, d]) => d.tighten > 1.05 || (Array.isArray(d.recent) && d.recent.some(o => o !== 'ok')))
      .sort((a, b) => b[1].tighten - a[1].tighten);
    rlLines.push(`- Effective concurrency: ${rl.effectiveConcurrency} · global pressure: ${rl.pressure}`);
    if (hot.length === 0) {
      rlLines.push('- (no domain hit a throttle/block/error this session)');
    } else {
      for (const [domain, d] of hot) {
        const recent = Array.isArray(d.recent) && d.recent.length ? ` (recent: ${d.recent.join(', ')})` : '';
        rlLines.push(`- \`${domain}\`: tighten ${d.tighten}×${recent}`);
      }
    }
  }

  const budgetLines = [];
  // These stats have EXACTLY ONE writer: browserPool.js's scrapeMultiple
  // (recordReady/recordBodySize), whose only caller is marketplace.js. The job
  // browser scraper (manualScraper.js) imports neither browserPool nor
  // scrapeBudget, so any job-source key here is a fossil left by the retired
  // scrapeMultiple job path and describes NOTHING about how a job scrape ran
  // today. Rendered undated and unattributed, "glassdoor-0: ema 9950ms" reads as
  // live tuning state and invites sizing a "should have finished by now"
  // judgement against a number that has not been written in months.
  const JOB_SOURCE_KEY = /^(glassdoor|google|indeed|ziprecruiter|linkedin|dice|usajobs|remoteok|weworkremotely|wellfound)(-\d+)?$/;
  let staleJobKeys = 0;
  if (budgets && Object.keys(budgets).length > 0) {
    for (const [key, s] of Object.entries(budgets).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!s || (!(s.samples > 0) && !(s.bodySamples > 0))) continue;
      const parts = [];
      if (s.samples > 0) {
        const note = s.samples >= 5 ? '' : ' (seed)';
        parts.push(`ema ${s.ema}ms /${s.samples}${note}`);
      }
      // Learned body-size baseline — the suspicious-empty soft-block threshold
      // is judged against this instead of a flat byte count.
      if (s.bodySamples > 0) {
        parts.push(`body ~${Math.round(s.bodyEma / 1000)}KB /${s.bodySamples}`);
      }
      const written = Math.max(Number(s.updated) || 0, Number(s.bodyUpdated) || 0);
      if (written > 0) {
        const ageH = (Date.now() - written) / 3_600_000;
        parts.push(ageH < 1 ? `written ${Math.max(0, Math.round(ageH * 60))}m ago` : ageH < 48 ? `written ${ageH.toFixed(1)}h ago` : `written ${Math.round(ageH / 24)}d ago`);
      } else {
        parts.push('write time not recorded');
      }
      const isJobKey = JOB_SOURCE_KEY.test(key);
      if (isJobKey) staleJobKeys++;
      budgetLines.push(`- \`${key}\`: ${parts.join(', ')}${isJobKey ? ' — ⚠️ **not written by the job scraper**' : ''}`);
    }
  }
  if (staleJobKeys > 0) {
    budgetLines.push(`- ⚠️ ${staleJobKeys} key(s) above name a JOB source but this store is written only by \`browserPool.scrapeMultiple\` (marketplace comp scrapes). \`manualScraper.js\` imports neither \`browserPool\` nor \`scrapeBudget\`, so these are fossils of a retired job path — do NOT read them as this run's per-page cost or use them to judge whether a job scrape is overdue.`);
  }

  if (rlLines.length === 0 && budgetLines.length === 0) return '';

  return `
## Scraper Adaptation
> Live tuning for the scrape pipeline. **Rate limiter** state is in-memory
> (resets each run); **learned budgets** persist across runs. Together they
> answer "why was this source slow / blocked / timed out?" — a high \`tighten\`
> or shrunken concurrency means anti-bot signals were observed; a learned
> budget far below a source's seed means it normally settles fast. The body
> baseline is the source's typical good-response size — soft blocks are flagged
> when a response is anomalously small relative to it.
> **Scope:** learned budgets are written ONLY by the marketplace comp-scrape
> driver (browserPool.scrapeMultiple). The job browser scraper does not feed
> or read them, so a job-source key here is stale by construction and each row
> now carries its write age.

### Rate limiter (this session)
${rlLines.length ? rlLines.join('\n') : '- (shared scraper rate limiter idle; LinkedIn guest-enrichment limits are reported separately in Job Search Pipeline)'}

### Learned scrape budgets (persisted)
${budgetLines.length ? budgetLines.join('\n') : '- (no source has a recorded sample yet — all using seed timeouts)'}
`;
}

/**
 * Reads the auto-loaded workspace file from disk and reports whether any hub
 * node carries transient state that should have been stripped before save.
 *
 * This is the load-bearing fact for "stale banner survives restart" reports:
 * the rest of the report shows the *in-memory* node data, which legitimately
 * holds the error during a live session — that is NOT the bug. Only a transient
 * field baked into the on-disk file proves a true persistence bug (vs. volatile
 * state that the next save will clean). Without this section the two are
 * indistinguishable without manually opening the JSON file.
 */
function buildPersistedWorkspaceSnapshot(frontEndState) {
  const filePath = frontEndState?.currentFile || frontEndState?.settings?.lastOpenedWorkspace || null;
  if (!filePath) {
    return `
## Persisted Workspace Snapshot
- No auto-loaded workspace (currentFile / lastOpenedWorkspace unset) — nothing persists across restart.
`;
  }

  let raw, mtime;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    mtime = fs.statSync(filePath).mtime.toISOString();
  } catch {
    return `
## Persisted Workspace Snapshot
- File: \`${redactReportPath(filePath)}\`
- ⚠️ Could not read workspace file on disk.
`;
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    return `
## Persisted Workspace Snapshot
- File: \`${redactReportPath(filePath)}\` (mtime ${mtime})
- ⚠️ Workspace file is not valid JSON.
`;
  }

  // Check if sidecar exists
  const sidecarPath = filePath.endsWith('.json') ? filePath.slice(0, -5) + '.progress.json' : filePath + '.progress.json';
  let sidecarExists = false;
  try {
    sidecarExists = fs.existsSync(sidecarPath);
  } catch { /* ignore */ }

  // Walk all nodes (recursing into group sub-canvases) looking for hubs that
  // carry transient fields. Each offender is a node whose stale state will be
  // replayed on the next auto-load.
  const offenders = [];
  if (parsed?.transientProgress) {
    offenders.push('  - `canvas`: Contains embedded `transientProgress` state on disk (should have been stripped/deleted immediately on load)');
  }
  let hubCount = 0;
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n?.type === 'jobhub' || n?.type === 'sellhub') {
        hubCount++;
        const d = n.data || {};
        const hits = [];
        if (TRANSIENT_PROCESSING_HUB_STATES.includes(d.hubState)) hits.push(`hubState=${d.hubState}`);
        if (n.type === 'jobhub') {
          // Data-driven over the authoritative key list: a future transient key
          // added to JOBSEARCH_TRANSIENT_KEYS is flagged automatically. (A previous
          // hardcoded if-chain would silently skip any unrecognized key, defeating
          // this section's purpose — it would falsely read "✅ Clean".)
          for (const key of getJobSearchTransientKeysForSave(d.hubState)) {
            const v = d[key];
            if (PRIVATE_JOB_PREFERENCE_TRANSIENT_KEYS.has(key)) {
              if (Array.isArray(v)) { if (v.length) hits.push(`${key}=${v.length} private item(s)`); }
              else if (v) hits.push(`${key}=set (private)`);
            }
            else if (Array.isArray(v)) { if (v.length) hits.push(`${key}=${v.length}`); }
            else if (v === true) hits.push(`${key}=true`);
            else if (typeof v === 'string') {
              hits.push(ECHOABLE_TRANSIENT_STRING_KEYS.has(key)
                ? `${key}="${truncateDiagnosticText(redactReportUrlsInText(v), 60)}"`
                : `${key}=set (${v.length} chars, value withheld)`);
            }
            else if (v) hits.push(`${key}=set`);
          }
        }
        if (n.type === 'sellhub' && d.platformFitPending) hits.push('platformFitPending=true');
        if (hits.length) offenders.push(`  - \`${reportCorrelationDigest(n.id)}\` (${n.type}): ${hits.join(', ')}`);
      }
      if (n?.type === 'group' && n.data?.canvasData?.nodes) walk(n.data.canvasData.nodes);
    }
  };
  walk(parsed?.nodes);

  const verdict = offenders.length
    ? `⚠️ **${offenders.length} item(s) carry transient state on disk** — these replay on every auto-load (true persistence bug):\n${offenders.join('\n')}`
    : '✅ Clean — no transient hub state (errorMessage / isRateLimit / scrapeWarnings / pendingJobs / mid-run hubState) or embedded progress is persisted.';

  return `
## Persisted Workspace Snapshot
> What is ACTUALLY on disk in the auto-loaded workspace, vs. the in-memory
> node data shown elsewhere. The in-memory copy legitimately holds error/
> pending state during a live session; only a field found HERE proves a
> bug where stale state survives a restart.

- File: \`${redactReportPath(filePath)}\` (mtime ${mtime})
- Embedded progress state on disk: \`${parsed?.transientProgress ? 'Yes' : 'No'}\`
- Legacy progress sidecar: \`${sidecarExists ? 'Present (will restore on load)' : 'None'}\`
- Persisted hub nodes scanned: ${hubCount}
- ${verdict}
`;
}

// ── Shared markdown generation ────────────────────────────────────────────────
// Used by both the "save to file" and "copy to clipboard" handlers so the
// report content is identical regardless of how the user chooses to export it.
// Both now generate the FULL uncapped report: "copy to clipboard" writes it to
// an app-managed file (see bugReport/reportFile.js) and returns a short path
// pointer for the clipboard instead of the report text itself, so an AI reads
// the file from disk in segments rather than receiving one giant paste.
//
// CLIPBOARD_BUG_REPORT_MAX_CHARS is no longer the normal clipboard path's cap —
// it is now ONLY the write-FAILURE fallback. If writeSavedBugReport throws
// (disk full, permissions, userData unwritable, ...) the user must never be
// left with nothing to paste, so the handler falls back to the old capped-
// inline behavior: a canvas-scale report handed to a clipboard/chat consumer
// that truncates blindly front-to-back would otherwise cut mid-section
// through the curated base and discard the entire (highest-value, most-
// recent) logs + event history that render after it. "Save to file" never
// applies this cap; it is the promised complete artifact.
const CLIPBOARD_BUG_REPORT_MAX_CHARS = 50_000;

// buildNodeDiagnosticsMarkdown samples routine job rows whenever a cap is in
// force, and emits this marker when it actually dropped any. It is the only
// evidence that reduction happened, because that sampling never sets the
// truncated/hardTruncated flags.
const ROUTINE_ROW_OMISSION_RE = /row\(s\) omitted to preserve the clipboard budget/;

function buildMissingPreviewRelinkMarkdown() {
  const snapshot = getMissingPreviewRelinkDiagnostics();
  const attempts = Array.isArray(snapshot?.attempts) ? snapshot.attempts : [];
  if (attempts.length === 0) return '';

  const cell = (value) => String(value ?? '—').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
  const rows = attempts.slice(-15).reverse().map((attempt) => {
    const ageSeconds = Number.isFinite(attempt.ts)
      ? `${Math.max(0, Math.round((Date.now() - attempt.ts) / 1000))}s ago`
      : '—';
    return (
      `| ${ageSeconds} | ${cell(attempt.status)} | ${cell(attempt.rootSource)} ` +
      `| \`${cell(attempt.searchRoot)}\` | \`${cell(attempt.missingPath)}\` ` +
      `| ${attempt.resolvedPath ? `\`${cell(attempt.resolvedPath)}\`` : '—'} ` +
      `| ${attempt.matches ?? 0} | ${attempt.entriesScanned ?? 0} |`
    );
  }).join('\n');

  return `
## Missing Preview Relink Diagnostics
> Every broken image preview search is bounded to one current hierarchy and
> walks downward only. \`root source\` shows whether that hierarchy was supplied
> by workspace loading, remembered while the image existed, or conservatively
> inferred from the original image parent. No search climbs above \`search root\`.

- Remembered image-path hierarchies: ${snapshot.rememberedPathCount ?? 0}
- Attempts retained: ${attempts.length} (showing newest ${Math.min(15, attempts.length)})

| When | Result | Root source | Search root | Missing path | Resolved path | Matches | Entries scanned |
|---|---|---|---|---|---|---|---|
${rows}
`;
}

function localCalendarDateLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'invalid';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildNodeDiagnosticsMarkdown(nodeInternals, nodeComponentStates, nodes, edges, options, sectionOmitted) {
  const compStateById = {};
  (nodeComponentStates || []).forEach(s => { compStateById[s.id] = s; });

  // Index full nodes by id so we can pull `data` for the preview column —
  // nodeInternals is intentionally stripped of `data` to keep its shape small.
  const nodeDataById = {};
  (nodes || []).forEach(n => { nodeDataById[n.id] = n.data || {}; });
  const sourceCardsByHub = {};
  (nodes || []).forEach(n => {
    if (n?.type !== 'jobsourcecard') return;
    const hubId = n?.data?.hubId;
    if (!hubId) return;
    (sourceCardsByHub[hubId] ||= []).push(n);
  });

  let nodeDiagMarkdown = '';
  if (sectionOmitted('nodeInternals')) {
    // XNODES / LEAN / MARKET / JOBS / AUTH drop the heavy per-node payload. Render
    // an explicit marker (like Nodes/Edges/Drawings above) so the absence reads as
    // "omitted by filter code", not "no nodes".
    nodeDiagMarkdown = '\n## Node Diagnostics\n*(omitted by filter code — per-node positions/sizes/component state)*\n';
  } else if (nodeInternals && nodeInternals.length > 0) {
    // Cap the routine nodes a hub spawns into its results cascade (jobcard +
    // jobgroup) so a large board doesn't blow the clipboard char budget — at
    // ~150-200 chars/row, a 739-card cascade is >150KB and forces the far more
    // valuable main-process logs + pipeline funnel + event history (which render
    // AFTER this table) to be dropped entirely. Crucially, a cascade spawns
    // COLLAPSED, so every card/group is `hidden` by default — that is the normal
    // tree state, NOT an anomaly, so `hidden` must NOT exempt a node from the cap
    // (the old predicate did, which is why all 739 rendered). The score/url and
    // band/salary/role breakdown are summarized in the Job Search Pipeline /
    // Taxonomy sections; only a genuine anomaly (selected/editing/resizing/
    // edge-cursor/error or an expanded hiring-fit disclosure) forces a row to
    // always show.
    // Only clipboard output needs sampling; Save to file is the promised full
    // artifact and must retain every routine row as well as every anomaly.
    const ROUTINE_JOBCARD_CAP = options?.maxChars ? 15 : Infinity;
    const ROUTINE_JOBGROUP_CAP = options?.maxChars ? 25 : Infinity; // keep enough to convey the taxonomy shape
    const hasAnomaly = (n) => {
      const cs = compStateById[n.id] || {};
      return !!(n.selected || cs.isEditing || cs.isResizing || cs.hasEdgeCursor
        || cs.reasoningExpanded || cs.scoreAuditExpanded || cs.compensationExpanded
        || nodeDataById[n.id]?.errorMessage);
    };
    let cardShown = 0, cardOmitted = 0, groupShown = 0, groupOmitted = 0;
    const nodesToRender = [];
    for (const n of nodeInternals) {
      if (n.type === 'jobcard' && !hasAnomaly(n)) {
        if (cardShown >= ROUTINE_JOBCARD_CAP) { cardOmitted++; continue; }
        cardShown++;
      } else if (n.type === 'jobgroup' && !hasAnomaly(n)) {
        if (groupShown >= ROUTINE_JOBGROUP_CAP) { groupOmitted++; continue; }
        groupShown++;
      }
      nodesToRender.push(n);
    }
    // width (prop) / height (prop) / style.width / style.height are ReactFlow's
    // explicit-size fields. The large majority of this app's node types are
    // content/CSS-sized and measured into node.measured by ResizeObserver — they
    // never touch these fields, so on most canvases all four columns render "—"
    // in every row, structurally, pushing the genuinely useful measured/
    // currentSize columns off the table's readable width for no diagnostic
    // return. But two node types DO set them explicitly, and the banner's stated
    // job (spot a prop-vs-measured divergence) is real for both: CanvasNode
    // writes width/height/style on every resize-drag frame and on the resize-
    // drop correction (useDragCorrections.js explicitly withholds `measured`
    // there — "it races with RF's ResizeObserver and causes size to compound
    // between sessions" — this table's whole reason to exist), and DocumentNode
    // writes them on expand/collapse for video/image/markdown/text documents.
    // So render the four columns only when at least one node in THIS report
    // actually carries one of them — the diagnostic survives for the node types
    // that use it, without four dead columns on every canvas that has none.
    const hasExplicitSize = nodesToRender.some(n =>
      n.width_prop != null || n.height_prop != null || n.style_width != null || n.style_height != null
    );
    const rows = nodesToRender.map(n => {
      const cs = compStateById[n.id] || {};
      const flags = [
        n.hidden ? 'hidden' : null,
        cs.isEditing ? 'editing' : null,
        cs.isResizing ? 'resizing' : null,
        cs.hasEdgeCursor ? 'edgeCursor' : null,
        cs.reasoningExpanded ? 'reasoningExpanded' : null,
        cs.scoreAuditExpanded ? 'scoreAuditExpanded' : null,
        cs.compensationExpanded ? 'compensationExpanded' : null,
        n.selected ? 'selected' : null,
      ].filter(Boolean).join(', ') || '—';
      // Hub-aware preview: include hubState plus whichever payload keys this
      // node carries. `nodeInternals` is intentionally stripped of `data`, so
      // pull from `nodeDataById` (built above from the full `nodes` array).
      const d = nodeDataById[n.id] || {};
      const previewParts = [];
      if (d.hubState) previewParts.push(`hubState: ${d.hubState}`);
      // `gatheredCount` is the total number of listings the sources returned;
      // `scrapedCount` is the smaller post-filter/post-recovery set that was
      // eligible to enter collection/scoring. Calling the latter "scraped" on
      // its own made a healthy 31 → 5 → 3 run look as though only three
      // listings had been fetched. Keep the compact Node Diagnostics preview
      // truthful without changing the persisted legacy field names.
      if (typeof d.scrapedCount === 'number') {
        const gatheredCount = typeof d.gatheredCount === 'number' ? d.gatheredCount : null;
        previewParts.push(gatheredCount != null && gatheredCount !== d.scrapedCount
          ? `scraped: ${gatheredCount} → kept: ${d.scrapedCount}`
          : `kept: ${d.scrapedCount}`);
      }
      if (typeof d.resultCount === 'number' && d.hubState === 'done') previewParts.push(`results: ${d.resultCount}`);
      // A Job Search Module stores its results in data.scoredJobs (renderer
      // strips the heavy array to a count). `∅ none stored` on a done hub with
      // results>0 means a legacy pre-split canvas that hasn't been migrated — a
      // Job Board would read zero from it. Only meaningful for `jobhub`: a
      // `jobboard` legitimately never stores scoredJobs (it reads them from
      // connected hubs at Combine and spawns the cascade), so its results count
      // (shown above) is the signal there — flagging ∅ on a board is noise.
      if (n.type === 'jobhub') {
        const dropLock = getHubDropLockReason({ type: 'jobhub', data: d });
        previewParts.push(`careerIdentity: ${hubHasAcceptedInitialDrop({ type: 'jobhub', data: d }) ? 'present' : 'none'}`);
        previewParts.push(`dropLock: ${dropLock || 'none'}`);
        // Surface completion history without exposing career-file or job
        // payload. Clearing career identity retains these timestamps as module
        // history, and replacement searches continue from that history.
        if (d.lastCompletedRunAt != null) {
          const completionIso = completionTimestampIso(d.lastCompletedRunAt);
          previewParts.push(completionIso
            ? `lastCompletedRunAt: ${completionIso}`
            : 'lastCompletedRunAt: invalid');
        }
        if (d.lastSearchCoverageStartedAt != null) {
          const coverageIso = completionTimestampIso(d.lastSearchCoverageStartedAt);
          previewParts.push(coverageIso
            ? `lastSearchCoverageStartedAt: ${coverageIso}`
            : 'lastSearchCoverageStartedAt: invalid');
        }
        // Re-scan availability used to be impossible to establish from a FULL
        // report: a connected Board suppressed the button, yet the report only
        // showed terminal hub state. Record both the exact UI ownership gate
        // and the automatically-derived inclusive date boundary. A plain idle
        // Board connection is deliberately NOT a blocker; only an active,
        // durable Board recovery still owns this action.
        const recoveryOwner = (() => {
          try { return findJobSearchBoardActiveRecoveryOwner(n.id, nodes, edges); }
          catch { return null; }
        })();
        const cleanupPending = !!d.terminalFinalizationRecovery
          || !!d.manualAiResume?.retirementPending
          || (Array.isArray(d.manualAiCleanupReceipts) && d.manualAiCleanupReceipts.length > 0);
        const rescanReadiness = d.hubState !== 'done'
          ? `unavailable (hubState=${d.hubState || 'unknown'})`
          : recoveryOwner
            ? 'blocked (active Job Board recovery owns this Search)'
            : d.locked || d.queuedModuleRun || cleanupPending
              ? 'blocked (Search is busy or completing saved cleanup)'
              : 'available on Job Search card';
        const nextAnchor = jobSearchNextAnchor(d, n.id);
        const initialLookbackDays = normalizeJobSearchInitialLookbackDays(
          d.initialLookbackDays ?? d.maxAgeDays,
        );
        const nextWindow = resolveJobSearchDateWindow(nextAnchor.timestamp, new Date(), initialLookbackDays);
        previewParts.push(
          `re-scan: ${rescanReadiness}`
          + `; next window: ${localCalendarDateLabel(nextWindow.startDate)} through now (inclusive)`
          + `; anchor: ${nextAnchor.source}`
          + `${nextAnchor.timestamp == null ? `; initial lookback: ${initialLookbackDays}d` : ''}`
          + `${nextWindow.capped ? `/${nextWindow.capReason || 'safety-cap'}` : ''}`,
        );
        const persistedWindowStart = completionTimestampIso(d.searchWindow?.startTimestamp);
        if (persistedWindowStart) {
          previewParts.push(
            `run window: ${localCalendarDateLabel(d.searchWindow.startTimestamp)} inclusive`
            + `; provider horizon: ${Number.isSafeInteger(d.searchWindow.providerLookbackDays)
              && d.searchWindow.providerLookbackDays > 0
              ? `${d.searchWindow.providerLookbackDays}d`
              : 'not retained'}`,
          );
        }
        const pendingCompletionIso = completionTimestampIso(
          d.pendingCollectionCompletion?.collectionCompletedAt,
        );
        if (pendingCompletionIso) {
          const pendingCoverageIso = completionTimestampIso(
            d.pendingCollectionCompletion?.collectionStartedAt,
          );
          previewParts.push(
            `collection anchor pending terminal success: ${pendingCompletionIso}`
            + `${pendingCoverageIso ? `; coverage started=${pendingCoverageIso}` : ''}`
            + `; run=${d.pendingCollectionCompletion?.runId
              ? reportCorrelationDigest(d.pendingCollectionCompletion.runId)
              : 'unknown'}`,
          );
        }
        // A locked hub refuses its own Cancel/Reset. Without this field a
        // report cannot separate "the user pressed Cancel and the hub declined"
        // from "the user never pressed it" — the two look identical from the
        // task registry, which shows a live task either way.
        if (d.locked) previewParts.push('locked: true (Cancel/Reset refused while locked)');
        if (Array.isArray(d.enabledSourceIds)) {
          previewParts.push(`enabledSourceIds: ${d.enabledSourceIds.length ? d.enabledSourceIds.map(sourceId => String(sourceId)).join(',') : '∅ none'}`);
        } else {
          previewParts.push('enabledSourceIds: default (all known platforms)');
        }
        const sc = typeof d.scoredJobsCount === 'number'
          ? d.scoredJobsCount
          : (Array.isArray(d.scoredJobs) ? d.scoredJobs.length : null);
        previewParts.push(`scoredJobs: ${sc == null ? '∅ none stored' : sc}`);
      }
      // A Job Board's defining op is the merge+dedup of its connected modules,
      // which runs renderer-side and is otherwise invisible (only the post-dedup
      // count reaches main via bucketJobs). `mergeStats` makes "merged the wrong
      // count / kept the wrong copy" diagnosable: per-module inputs → unique.
      if (n.type === 'jobboard' && d.mergeStats && typeof d.mergeStats === 'object') {
        const ms = d.mergeStats;
        const breakdown = Array.isArray(ms.perModule) && ms.perModule.length
          ? `${ms.perModule.map(p => p.count).join('+')}=${ms.totalIncoming}`
          : `${ms.totalIncoming ?? '?'}`;
        previewParts.push(
          `merge: ${ms.modules ?? '?'} mod · ${breakdown} → ${ms.unique ?? '?'} unique ` +
          `(${ms.duplicatesRemoved ?? '?'} dup, ${ms.collisionUpgrades ?? 0} score-upgrade)`
        );
      }
      // Board cascades are deliberately hidden instead of discarded when their
      // connected search inputs change. Show the stale marker, its persisted
      // explanation, and the compact signature baseline so FULL reports can
      // distinguish an intentional hidden prior result from a ghost board.
      if (n.type === 'jobboard') {
        previewParts.push(`stale: ${d.stale ? 'true' : 'false'}`);
        // The renderer normally stores a count-only stale reason. Do not
        // export arbitrary persisted text here: imported/malformed Board data
        // could otherwise carry a query, URL token, or custom opaque id.
        const staleReason = typeof d.staleReason === 'string'
          && /^(?:connections changed|(?:\d+ (?:disconnected|added|updated|updating))(?: · \d+ (?:disconnected|added|updated|updating))*)$/.test(d.staleReason)
          ? d.staleReason
          : null;
        if (staleReason) previewParts.push(`staleReason: ${staleReason}`);
        else if (d.staleReason) previewParts.push('staleReason: recorded (details withheld)');
        // A combine signature embeds source hub ids and fingerprints. It is
        // useful as a presence fact here, but the raw serialized value belongs
        // nowhere in Node Diagnostics; the dedicated Board section correlates
        // it using redacted identities instead.
        if (d.combineSignature != null) previewParts.push('combineSignature: present (opaque source provenance)');
      }
      if (d.errorMessage) previewParts.push(`err: ${truncateDiagnosticText(d.errorMessage, 60)}`);
      if (d.isRateLimit) previewParts.push(`rateLimit: true`);
      // Warnings: show total + block-severity + DISTINCT source breakdown. The
      // hub renders one card per source but stores one warning per blocked
      // query, so the raw warning count can exceed the number of visible cards
      // (e.g. `2 (2 block / 1 src: indeed×2)` — the "says 2 blocked but I see 1"
      // report). Surfacing src-count here makes that mismatch obvious without
      // expanding the full JSON and counting sourceIds by hand.
      if (Array.isArray(d.scrapeWarnings) && d.scrapeWarnings.length) {
        const blocks = d.scrapeWarnings.filter(w => w?.severity === 'block');
        const bySource = {};
        for (const w of blocks) { const s = w?.sourceId || '?'; bySource[s] = (bySource[s] || 0) + 1; }
        const srcIds = Object.keys(bySource);
        const breakdown = srcIds.map(s => bySource[s] > 1 ? `${s}×${bySource[s]}` : s).join(',');
        previewParts.push(`warnings: ${d.scrapeWarnings.length} (${blocks.length} block / ${srcIds.length} src${breakdown ? `: ${breakdown}` : ''})`);
      }
      // sellhub explicitly nulls imagePaths (vs. never setting it) when a
      // cancel/dismiss clears dropped photos — same ambiguity as jobhub's
      // scoredJobs above. Without this, `null` and "field never touched"
      // both render as an absent line, so a wiped item hub is
      // indistinguishable from one that never had photos.
      if (n.type === 'sellhub') {
        if (Array.isArray(d.imagePaths)) previewParts.push(`imagePaths: ${d.imagePaths.length}`);
        else if (d.imagePaths === null) previewParts.push(`imagePaths: ∅ cleared`);
      } else if (Array.isArray(d.imagePaths)) {
        previewParts.push(`imagePaths: ${d.imagePaths.length}`);
      }
      if (Array.isArray(d.images)) previewParts.push(`images: ${d.images.length}`);
      if (d.file) previewParts.push(`file: ${d.file.name || d.file}`);
      if (d.filePath) previewParts.push(`filePath: ${redactReportPath(d.filePath)}`);
      if (d.resumeProfile) previewParts.push('resumeProfile: ✓');
      if (n.type === 'jobcard') previewParts.push(`link: ${effectiveJobCardLinkState(d)}`);
      // Stated explicitly even when empty: a cleared pointer (a discard) must
      // read as "none" rather than as a field that was never collected. The
      // correlation value is one-way so an opaque job id never reaches a report.
      if (n.type === 'jobcard') {
        const bundle = d.localApplication;
        const status = typeof bundle?.status === 'string' && /^[a-z][a-z-]{0,31}$/.test(bundle.status) ? bundle.status : null;
        previewParts.push(bundle?.id
          ? `appBundle: ${status || 'unknown'} (${reportCorrelationDigest(bundle.id)})`
          : 'appBundle: none');
      }
      if (typeof d.matchScore === 'number') previewParts.push(`score: ${d.matchScore}`);
      // Link state above is enough to diagnose whether a card can be opened.
      // Even query-free URL paths can embed employer names, role titles, or
      // opaque listing identifiers, so no public URL is exported here.
      if (d.product?.brand) previewParts.push(`brand: ${d.product.brand}`);
      // ── Price-drop reminder plan (sellhub) ──────────────────────────────
      // The plan is configured on the hub and broadcast to its marketplace
      // cards, yet none of it was visible in a FULL report before. Surfacing it
      // makes "Apply to all didn't propagate to item X", "this item was excluded
      // but still got overwritten", and "the suggested drop / cadence is wrong"
      // diagnosable from Node Diagnostics alone — the plan math is renderer-side
      // and otherwise leaves no trace in the logs or event timeline.
      if (n.type === 'sellhub') {
        const weeks = Number(d.priceDropReminderWeeks) || 0;
        const planBits = [];
        if (weeks > 0) planBits.push(`every ${weeks}wk`);
        if (d.priceDropMustSellDate) planBits.push(`sell-by ${d.priceDropMustSellDate}`);
        if (d.priceDropTargetPrice != null) planBits.push(`target $${d.priceDropTargetPrice}`);
        if (d.priceDropStartingTier) planBits.push(`tier ${d.priceDropStartingTier}`);
        if (d.priceDropPlanStartingPrice != null) planBits.push(`start $${d.priceDropPlanStartingPrice}`);
        if (planBits.length > 0) previewParts.push(`priceDrop: ${planBits.join(', ')}`);
        // The per-card opt-out from another item's "Apply to all". A card the
        // user swears they updated that stayed stale is almost always this flag.
        if (d.priceDropApplyAllExcluded) previewParts.push('applyAll: EXCLUDED');
      }
      // Marketplace-card surface: status + statusMessage are the most common
      // signal for "why does this card say X?" reports. statusMessage is
      // truncated since the raw text (e.g. an AI error or a multi-URL
      // aggregated reason) can be long. lastChecked is normalized to "Ns ago"
      // so a stale status is obvious without timezone math.
      // jobgroup — the results-tree levels (likelihood band → salary range →
      // role; legacy: category / bucket / branch). Keep the tree's kind, count,
      // and expanded state, but never its role/salary/category label: those values
      // are derived from the current job listings and do not belong in automatic
      // diagnostics. Likelihood is a fixed display-band vocabulary, not listing
      // content, so it is safe to retain as a structural grouping fact.
      if (d.kind && ['likelihood', 'salary', 'role', 'category', 'bucket', 'branch'].includes(d.kind)) {
        previewParts.push(d.kind === 'likelihood'
          ? `likelihood: ${d.label || '?'}`
          : `${d.kind}: label withheld`);
        if (typeof d.count === 'number') previewParts.push(`count: ${d.count}`);
        previewParts.push(`expanded: ${d.expanded ? 'true' : 'false'}`);
        if (Array.isArray(d.childIds)) previewParts.push(`children: ${d.childIds.length}`);
      }
      // Transient source-progress cards (job + marketplace). Surface the source
      // and its persisted progress status. Only flag a card as lingering once
      // every sibling source card for the same hub is already in a clean
      // terminal state; until then, Job Search Module intentionally keeps clean cards
      // visible so the source-count set stays intact while other sources are
      // still searching or blocked.
      if (d.sourceId && d.persistedProgress) {
        const p = d.persistedProgress;
        const isCleanTerminal = (p.status === 'skipped' || p.status === 'done') && !p.warning;
        const siblingCards = sourceCardsByHub[d.hubId] || [];
        const allSiblingCardsCleanTerminal = siblingCards.length > 0 && siblingCards.every(card => {
          const siblingProgress = card?.data?.persistedProgress;
          if (!siblingProgress) return false;
          return (siblingProgress.status === 'done' || siblingProgress.status === 'skipped') &&
            !siblingProgress.warning;
        });
        // Only flag as lingering if the auto-dismiss grace window (10s) has
        // clearly elapsed. Cards that completed within the last ~15s are still
        // in the grace period — flagging them is a false positive. doneAt is
        // stamped by JobSourceCardNode on the first terminal state write.
        const DISMISS_GRACE_MS = 15_000; // 10s grace + 5s buffer for render lag
        const gracePeriodElapsed = !p.doneAt || (Date.now() - p.doneAt) > DISMISS_GRACE_MS;
        const lingering = isCleanTerminal && allSiblingCardsCleanTerminal && gracePeriodElapsed;
        previewParts.push(
          `source: ${d.sourceId}, progress: ${p.status || '?'}${p.warning?.code ? ` (${p.warning.code})` : ''}` +
          (lingering ? ' ⚠️ should have auto-dismissed (lingering card)' : ''),
        );
      }
      if (d.platformId) previewParts.push(`platform: ${d.platformId}`);
      if (d.status) previewParts.push(`status: ${d.status}`);
      if (d.statusMessage) previewParts.push(`statusMsg: ${truncateDiagnosticText(d.statusMessage, 100)}`);
      if (d.listingUrl) {
        try {
          const u = new URL(d.listingUrl);
          // host + path so the listing's SHAPE is visible: a /share/<hash> URL
          // yields an identity anchor that never appears on the seller dashboard
          // (the reason a share-linked card can read "unknown"), vs a
          // /marketplace/item/<id> URL whose id the dashboard can locate.
          previewParts.push(`listing: ${(u.host + u.pathname).slice(0, 64)}`);
        } catch { previewParts.push(`listingUrl: ${String(d.listingUrl).slice(0, 50)}`); }
      }
      if (d.lastChecked) {
        const ageS = Math.round((Date.now() - new Date(d.lastChecked).getTime()) / 1000);
        if (Number.isFinite(ageS)) previewParts.push(`checked: ${ageS}s ago`);
      }
      if (Array.isArray(d.attention) && d.attention.length > 0) {
        const high = d.attention.filter(a => a?.urgency === 'high').length;
        previewParts.push(`attention: ${d.attention.length} (${high} high)`);
      }
      // Per-URL status-check trace — LEGACY data from the per-card check the
      // Marketplace Status Module replaced (no longer written, but old saved
      // canvases can still carry it). Each URL's verdict + whether the identity
      // anchor matched there: a deleted listing reads `listing=ended` (its page
      // 4xx'd); a share-linked card reads `platform watch=unknown·no-match`.
      if (d.lastCheckTrace && Array.isArray(d.lastCheckTrace.sources) && d.lastCheckTrace.sources.length > 0) {
        const t = d.lastCheckTrace;
        const formatted = t.sources.map(s => {
          const m = s.matched === true ? '·matched' : s.matched === false ? '·no-match' : '';
          // `reason` was captured for error verdicts only — the WHY behind a bare
          // `listing=error` (fetch timeout vs anti-bot drop vs AI failure), so a
          // systematic source failure stays diagnosable on those legacy traces.
          const why = s.reason ? ` (${s.reason})` : '';
          return `${s.label || '?'}=${s.status || '?'}${m}${why}`;
        });
        // Collapse consecutive identical entries (e.g. a card with 5 platform-
        // watch URLs that all no-match) → `platform watch=unknown·no-match ×5`.
        const collapsed = [];
        for (const f of formatted) {
          const last = collapsed[collapsed.length - 1];
          if (last && last.text === f) last.count++;
          else collapsed.push({ text: f, count: 1 });
        }
        const srcStr = collapsed.map(c => c.count > 1 ? `${c.text} ×${c.count}` : c.text).join(', ');
        previewParts.push(`checkTrace[id=${t.identifier || '—'}]: ${srcStr}`);
      }
      if (Array.isArray(d.watchUrls) && d.watchUrls.length > 0) {
        previewParts.push(`watchUrls: ${d.watchUrls.length}`);
      }
      // ── Price-drop reminder state (marketplacecard) ─────────────────────
      // Only emitted once a reminder is actually live (due) or acknowledged, so
      // the already-heavy marketplacecard rows stay lean on canvases with no
      // active plan. createdAt is the shared cadence anchor (the oldest card
      // starts the schedule), so it's included here for context when relevant —
      // it explains "the reminder fired on the wrong day".
      if (n.type === 'marketplacecard' && (d.priceDropReminderDue || d.lastPriceDropAt)) {
        const dropBits = [];
        if (d.priceDropReminderDue) dropBits.push('DUE');
        if (d.createdAt) {
          const ageDays = Math.round((Date.now() - new Date(d.createdAt).getTime()) / 86_400_000);
          if (Number.isFinite(ageDays)) dropBits.push(`created ${ageDays}d ago`);
        }
        if (d.lastPriceDropAt) {
          const ackDays = Math.round((Date.now() - new Date(d.lastPriceDropAt).getTime()) / 86_400_000);
          if (Number.isFinite(ackDays)) dropBits.push(`ack ${ackDays}d ago`);
        }
        if (dropBits.length > 0) previewParts.push(`priceDrop: ${dropBits.join(', ')}`);
      }
      // Per-source ring progress lives in component state, not node data.
      // Compact it as `comp: ebay-sold=done/12,poshmark=searching/0,...` so a
      // "stale ring after re-research" report is diagnosable at a glance.
      const ringProgress = cs.compProgress || cs.sourceProgress;
      if (ringProgress && typeof ringProgress === 'object') {
        const entries = Object.entries(ringProgress);
        if (entries.length > 0) {
          const tag = cs.compProgress ? 'comp' : 'src';
          // Append `[warning-code]` when a source carries a warning so the
          // bug report shows WHY a source ended up skipped/error/empty
          // without requiring the full scrapeWarnings array to be cross-
          // referenced. Format: `linkedin=done/0[http-403]`.
          //
          // When the warning exists but `url` is missing, append `,no-url`.
          // A warning without url means the source card's Solve button
          // can't render — almost always the result of an event-ordering
          // bug like the mid-scrape vs post-completion event split.
          previewParts.push(`${tag}: ` + entries.map(([k, v]) => {
            const base = `${k}=${v?.status || '?'}/${v?.count ?? '?'}`;
            if (!v?.warning?.code) return base;
            const urlTag = v?.url ? '' : ',no-url';
            return `${base}[${v.warning.code}${urlTag}]`;
          }).join(','));
        }
      }
      // SellHub may have captcha-resolves queued or actively being applied.
      // Surfacing the count and phase turns "I solved all the cards but it
      // still says N left" reports into a one-glance diagnosis.
      if (cs.queuedResolvesCount > 0) {
        previewParts.push(`resolve work: ${cs.queuedResolvesCount}${cs.isApplyingResolves ? ' (applying)' : ' (queued)'}`);
      }
      const dataPreview = previewParts.join(', ');

      // Present only when the report has at least one node carrying an explicit
      // prop/style size — see hasExplicitSize above. Keeping this as a single
      // block (rather than four independent `hasExplicitSize ? … : ''` cells)
      // makes it impossible for the row's column count to drift from the
      // header's if only some of the four were toggled by mistake.
      const sizePropCells = hasExplicitSize
        ? `| ${n.width_prop ?? '—'} ` +
          `| ${n.height_prop ?? '—'} ` +
          `| ${n.style_width ?? '—'} ` +
          `| ${n.style_height ?? '—'} `
        : '';

      return (
        `| \`${reportCorrelationDigest(n.id)}\` ` +
        `| ${n.type} ` +
        `| ${n.selected ? '✅' : '—'} ` +
        `| (${n.position?.x?.toFixed(0)}, ${n.position?.y?.toFixed(0)}) ` +
        `| ${n.fontSize ?? '—'}/${n.fontFamily ?? '—'} ` +
        `| ${n.textColor ?? '—'} ` +
        `| ${n.backgroundColor ?? '—'} ` +
        sizePropCells +
        `| ${n.measured_width ?? '—'} ` +
        `| ${n.measured_height ?? '—'} ` +
        `| ${cs.size ?? '—'} ` +
        `| ${flags} ` +
        `| ${dataPreview || '—'} |`
      );
    }).join('\n');
    // Header/separator are built from the same hasExplicitSize toggle so they
    // can never drift out of sync with the row cells above.
    const sizePropHeaderCols = hasExplicitSize ? ' width (prop) | height (prop) | style.width | style.height |' : '';
    const sizePropSepCols = hasExplicitSize ? '---|---|---|---|' : '';
    nodeDiagMarkdown = `
## Node Diagnostics
> **Size columns**: ${hasExplicitSize
        ? 'width (prop)/height (prop)/style.width/style.height are shown because at least one node below sets them explicitly (a mid-resize CanvasNode, or an expanded DocumentNode) — a divergence from measured.width/height there is the signature of a ResizeObserver/setNodes race (see useDragCorrections.js\'s "do NOT set measured" comment). Every other node type is content/CSS-sized and never touches these fields.'
        : 'width (prop)/height (prop)/style.width/style.height are omitted — no node below sets an explicit ReactFlow size right now (only a mid-resize CanvasNode or an expanded DocumentNode ever do). measured.width/height are what every node actually renders at, via ResizeObserver.'}
> **Component state**: React state at the moment the report was generated.

| ID | Type | Selected | Position | Font | T-Color | B-Color |${sizePropHeaderCols} measured.width | measured.height | currentSize | state flags | data preview |
|---|---|---|---|---|---|---|${sizePropSepCols}---|---|---|---|---|
${rows}
${(cardOmitted > 0 || groupOmitted > 0) ? `\n_+ ${[cardOmitted > 0 ? `${cardOmitted} routine jobcard` : null, groupOmitted > 0 ? `${groupOmitted} routine jobgroup` : null].filter(Boolean).join(' and ')} row(s) omitted to preserve the clipboard budget — collapsed-cascade nodes (hidden by default) with no anomaly. The hubs, board (merge stats), and a sample are shown; the full score/taxonomy breakdown is in the Job Search Pipeline section. Anomalous nodes (selected/editing/resizing/error) are always shown._\n` : ''}`;
  }
  return nodeDiagMarkdown + buildJobSourceWarningReconciliationMarkdown(nodes, sourceCardsByHub);
}

/**
 * Observation-only reconciliation of what each Job Search hub COUNTS as blocked
 * against what its source cards actually show.
 *
 * A "N sources blocked, but every card is done/solved/skipped" report cannot be
 * diagnosed without both halves side by side: the hub prints a count derived
 * from distinct gating sourceIds in `data.scrapeWarnings`, while the cards hold
 * their own independent copy of their warning. Previously the hub's warning list
 * was nowhere in the report and had to be inferred by differencing the event log
 * across hours. States observations only — it asserts no cause.
 */
function buildJobSourceWarningReconciliationMarkdown(nodes, sourceCardsByHub) {
  const hubs = (nodes || []).filter(n => n?.type === 'jobhub');
  if (hubs.length === 0) return '';
  const lines = hubs.map((hub) => {
    const warnings = Array.isArray(hub.data?.scrapeWarnings) ? hub.data.scrapeWarnings : [];
    const gating = warnings.filter(isJobSourceWarningGating);
    const distinctGating = new Set(gating.map(w => w?.sourceId).filter(Boolean));
    const cards = sourceCardsByHub[hub.id] || [];
    const cardRows = cards.map((card) => {
      const d = card.data || {};
      const p = d.persistedProgress || {};
      return `    - card \`${d.sourceId || '?'}\` · status ${p.status || 'none'}`
        + ` · warning ${p.warning?.code || 'none'}${p.warning?.severity ? `/${p.warning.severity}` : ''}`;
    });
    const warningRows = warnings.map(w => (
      `    - warning \`${w?.sourceId || '?'}\` · ${w?.code || '?'} · ${w?.severity || '?'}`
      + ` · gating ${isJobSourceWarningGating(w) ? 'yes' : 'no'}`
      + ` · solvable ${canAttemptJobSourceResolve(w) ? 'yes' : 'no'}`
    ));
    // The number the paused-state UI actually prints.
    return [
      `- Hub \`${reportCorrelationDigest(hub.id)}\` · hubState \`${hub.data?.hubState || 'unknown'}\``
        + ` · retained warnings ${warnings.length} · gating ${gating.length}`
        + ` · **distinct gating sources ${distinctGating.size}** (this is the number the paused UI prints)`
        + ` · source cards on canvas ${cards.length}`,
      ...warningRows,
      ...cardRows,
    ].join('\n');
  });
  return `
## Job Source Warning Reconciliation
> Observation-only. The paused Job Search UI prints the count of DISTINCT gating
> \`sourceId\`s in the hub's \`scrapeWarnings\`; each source card separately holds its
> own copy of its warning. A report of "N sources blocked but every card looks
> settled" is a divergence between these two lists, so both are printed here
> verbatim. No cause is asserted.

${lines.join('\n')}
`;
}

function buildMediaPlayerStateMarkdown(mediaState) {
  let mediaMarkdown = '';
  if (mediaState && mediaState.length > 0) {
    const READY_STATE = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
    const NET_STATE = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];
    const fmtRanges = (arr) => {
      if (!arr || arr.length === 0) return '(none)';
      return arr.map(([s, e]) => `${s.toFixed(2)}–${e.toFixed(2)}`).join(', ');
    };
    const rows = mediaState.map((m, i) => {
      const durStr = typeof m.duration === 'number' ? `${m.duration.toFixed(2)}s` : (m.duration || 'unknown');
      const progress = `${m.currentTime?.toFixed(2)}s / ${durStr}`;
      const errorStr = m.errorCode != null ? `code=${m.errorCode} ${m.errorMessage || ''}`.trim() : '—';
      return (
        `| ${i + 1} ` +
        `| ${m.tag} ` +
        `| ${m.paused ? 'paused' : m.ended ? 'ended' : 'playing'} ` +
        `| ${progress} ` +
        `| ${READY_STATE[m.readyState] ?? m.readyState} ` +
        `| ${NET_STATE[m.networkState] ?? m.networkState} ` +
        `| ${fmtRanges(m.seekable)} ` +
        `| ${fmtRanges(m.buffered)} ` +
        `| ${errorStr} |`
      );
    }).join('\n');
    mediaMarkdown = `
## Media Player State
> Snapshot taken at report time. \`readyState\`/\`networkState\` reveal stalls and decode/network issues.
> An empty \`seekable\` range while \`buffered\` is populated means the source isn't Range-capable — timeline clicks are ignored.

| # | Tag | Status | Progress | readyState | networkState | Seekable | Buffered | Error |
|---|---|---|---|---|---|---|---|---|
${rows}
`;
  }
  return mediaMarkdown;
}

function buildImageElementStateMarkdown(imageState) {
  let imageMarkdown = '';
  if (imageState && imageState.length > 0) {
    const rows = imageState.map((img, i) => {
      const srcShort = img.src ? img.src.replace(/^local-file:\/\//, '').slice(-60) : '(none)';
      return (
        `| ${i + 1} ` +
        `| ${img.broken ? '⚠️ broken' : img.complete ? 'ok' : 'loading'} ` +
        `| ${img.naturalWidth} × ${img.naturalHeight} ` +
        `| \`...${srcShort}\` |`
      );
    }).join('\n');
    imageMarkdown = `
## Image Element State
> \`broken\` = complete with naturalWidth=0 — protocol returned 4xx/5xx or undisplayable bytes.

| # | Status | Natural Size | src (last 60 chars) |
|---|---|---|---|
${rows}
`;
  }
  return imageMarkdown;
}

function buildActiveEditableMarkdown(activeEditableText) {
  let activeEditableMarkdown = '';
  if (activeEditableText) {
    const a = activeEditableText;
    activeEditableMarkdown = `
## Active Editable At Report Time
- Editing node: \`${a.editingNodeId || '(unknown)'}\`
- Diverges from saved data.text: ${a.divergent === true ? '⚠️ YES' : a.divergent === false ? 'no' : 'unknown'}
    - Live DOM text: \`${(a.liveText || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\`
    - Saved data.text: \`${(a.savedText || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\`
`;
  }
  return activeEditableMarkdown;
}

function buildLastSaveErrorMarkdown(lastSaveError) {
  let lastSaveErrorMarkdown = '';
  if (lastSaveError) {
    lastSaveErrorMarkdown = `
## Last Save Error
- Reason: \`${closeReportDiagnostic(lastSaveError.reason, 'unknown')}\`
- File: \`${redactReportPath(lastSaveError.filePath, '(no current file)')}\`
- When: ${lastSaveError.timestamp || 'unknown'}
`;
  }
  return lastSaveErrorMarkdown;
}

// A node may own several IPC controllers. Match the exact originating channel
// as well as node id, so a pending copy/paste prompt suppresses the stale-task
// warning only for the controller actually awaiting it.
export function pendingManualHandoffsForActiveTasks(tasks, lifecycles) {
  const pending = Array.isArray(lifecycles)
    ? lifecycles.filter(item => item?.nodeId && !item?.settledAt && item?.outcome === 'pending')
    : [];
  const byNode = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const details = Array.isArray(task?.taskDetails)
      ? task.taskDetails
      : (Array.isArray(task?.channels) ? task.channels.map(channel => ({ channel })) : []);
    if (details.length === 0) continue;
    const matchesByDetail = details.map(detail => pending.filter(item => (
      item.nodeId === task.nodeId
      && typeof item.channel === 'string'
      && item.channel === detail?.channel
      && (task.senderId == null || item.windowId == null || item.windowId === task.senderId)
      // Newer requests carry a renderer-created workflow id through both
      // records. Require it when the handoff has one; only legacy requests
      // without a run id may use the node/channel fallback.
      && (item.runId ? item.runId === detail?.manualAiRunId : !detail?.manualAiRunId)
    )));
    // The table is one row per node. Only suppress its hang hint when EVERY
    // active controller has an exact pending handoff; otherwise a simultaneous
    // unrelated controller could be silently masked by the manual wait.
    if (matchesByDetail.some(matches => matches.length === 0)) continue;
    const matches = [...new Map(matchesByDetail.flat().map(item => [item.requestId || `${item.nodeId}:${item.task}:${item.issuedAt}`, item])).values()];
    byNode.set(task.nodeId, matches);
  }
  return byNode;
}

function buildActiveTasksMarkdown(reportWindowId) {
  let activeTasksMarkdown = '';
    const allTasks = snapshotActiveNodeTasks() || [];
    // Task ownership is sender-scoped, so reports can now select this canvas
    // directly instead of guessing from the most recent global telemetry row.
    // Keep the all-window count to make expected activity elsewhere explicit.
    const localTasks = reportWindowId == null
      ? allTasks
      : snapshotActiveNodeTasks(reportWindowId);
    const foreignCount = allTasks.length - localTasks.length;
    let handoffLifecycles = [];
    try { handoffLifecycles = getNonApiAiHandoffLifecycle({ windowId: reportWindowId }); } catch { /* optional diagnostic */ }
    const manualHandoffsByNode = pendingManualHandoffsForActiveTasks(localTasks, handoffLifecycles);
    // Listing status checks serialize through a global FIFO lock (statusCheckLock)
    // — they do NOT register an AbortController task, so they're invisible above.
    // Surface the queue depth so "two Check-Alls feel stuck behind each other"
    // is diagnosable: depth N = 1 running + (N-1) waiting their turn.
    const statusQueueDepth = getStatusCheckQueueDepth();
    const statusQueueLine = statusQueueDepth > 0
      ? `\n- 🔄 **Listing status checks in flight: ${statusQueueDepth}** — 1 running, ${statusQueueDepth - 1} queued behind the FIFO lock (per-card "Check" + "Check All" serialize globally to avoid doubling the single-IP burst; see statusCheckLock.js). A nonzero depth while the UI looks frozen = checks awaiting their turn, NOT hung.`
      : '\n- Listing status-check queue: idle (no Check / Check All running).';
    if (localTasks.length > 0) {
      // Staleness = time since this node last showed ANY sign of life. Log lines
      // alone are not that signal: most scraper logs never interpolate a nodeId,
      // so a node grinding through a long sequential walk looks silent and gets
      // flagged as hung. Fold in the run's own progress heartbeat, and name which
      // signal the age came from so the number is never mistaken for more than it
      // measures.
      const allLogs = getRecentLogs() || [];
      const HUNG_HINT_MS = 180_000; // 3 min with no signal of any kind = suspect
      const fmtAge = (ms) => (ms == null ? '—' : `${Math.round(ms / 1000)}s`);
      const jobsTel = getJobsTelemetry();
      const mktTel = getMarketplaceTelemetry();
      const lastActivityForNode = (nodeId) => {
        const signals = [];
        let latestLog = 0;
        for (const l of allLogs) {
          if (l.ts > latestLog && typeof l.message === 'string' && l.message.includes(nodeId)) latestLog = l.ts;
        }
        if (latestLog) signals.push({ ts: latestLog, label: 'node-tagged log' });
        if (jobsTel?.nodeId === nodeId && jobsTel?.pipeline?.ts) {
          // `pipeline.ts` moves on stage transitions and on every source-progress
          // emit — NOT on a timer. Naming it a "heartbeat" invited the reading
          // that a stale value proves a stall, which is wrong for any source that
          // simply has nothing to emit between its start and its finish.
          signals.push({ ts: jobsTel.pipeline.ts, label: 'search stage/progress emit' });
        }
        // The browser scraper's activity beat is the one signal that ticks
        // continuously during a browser walk (every overlay paint: per card, per
        // page, per pagination step). Without it, a healthy multi-minute
        // Glassdoor description walk trips the hung flag every single time,
        // because its per-card loop emits telemetry only on failure.
        if (jobsTel?.nodeId === nodeId) {
          try {
            const beatTs = getManualScraperTelemetry?.()?.beat?.ts;
            if (Number.isFinite(beatTs)) signals.push({ ts: beatTs, label: 'browser scrape activity beat' });
          } catch { /* ignore */ }
        }
        if (jobsTel?.nodeId === nodeId && jobsTel?.scoringHeartbeat?.active && jobsTel.scoringHeartbeat?.ts) {
          signals.push({ ts: jobsTel.scoringHeartbeat.ts, label: 'scoring stream heartbeat' });
        }
        // Marketplace telemetry stamps `ts` per STAGE, not on the root — take
        // the newest stage that actually ran.
        if (mktTel?.nodeId === nodeId) {
          const stageTs = [mktTel.analyze?.ts, mktTel.scrape?.ts, mktTel.synthesis?.ts,
            ...Object.values(mktTel.resolves || {}).map(r => r?.ts)].filter(Number.isFinite);
          if (stageTs.length > 0) signals.push({ ts: Math.max(...stageTs), label: 'marketplace stage telemetry' });
        }
        if (signals.length === 0) return null;
        const newest = signals.reduce((a, b) => (b.ts > a.ts ? b : a));
        return { ms: Date.now() - newest.ts, label: newest.label };
      };
      const rows = localTasks
        .map(t => {
          const last = lastActivityForNode(t.nodeId);
          const matchingHandoffs = manualHandoffsByNode.get(t.nodeId) || [];
          const manualWait = matchingHandoffs.length > 0;
          // Suspect a hang when the node has shown no signal past the hint window
          // (or none at all) while a task is still registered and aging.
          // A scrape the user deliberately paused is silent BY REQUEST. Flagging
          // it "possibly hung" sends a reader hunting for a deadlock that does
          // not exist, so the pause state overrides the staleness heuristic.
          let scrapePaused = false;
          try { scrapePaused = getManualScraperTelemetry?.()?.paused === true && jobsTel?.nodeId === t.nodeId; } catch { /* ignore */ }
          const suspect = !scrapePaused && !manualWait && (last == null ? t.oldestAgeMs : last.ms) > HUNG_HINT_MS;
          const handoffTasks = [...new Set(matchingHandoffs.map(item => String(item.task || 'unknown').replace(/[|`]/g, "'")))].join(', ');
          const newestHandoffIssuedAt = matchingHandoffs.reduce((latest, item) => Math.max(latest, Number(item?.issuedAt) || 0), 0);
          const handoffAge = newestHandoffIssuedAt ? fmtAge(Math.max(0, Date.now() - newestHandoffIssuedAt)) : 'unknown age';
          const activity = last == null ? 'no node activity recorded' : `${fmtAge(last.ms)} ago (${last.label})`;
          const lastCell = manualWait
            ? `${activity} · ⏳ awaiting handoff response: ${handoffTasks} (${handoffAge})`
            : activity;
          const flag = scrapePaused ? ' ⏸️ paused by user' : suspect ? ' ⚠️ possibly hung' : '';
          const chans = t.channels?.length ? t.channels.join(', ') : '—';
          return `| \`${reportCorrelationDigest(t.nodeId)}\` | ${t.taskCount} | ${fmtAge(t.oldestAgeMs)} | ${lastCell}${flag} | ${chans} |`;
        })
        .join('\n');
      activeTasksMarkdown = `
## Active IPC Tasks
> Nodes with backend AbortControllers still registered at report time.
> A node showing tasks here while its UI looks idle means a cancel/abort
> request never reached the backend. **Oldest task age** = how long the
> longest-running task has been registered; **Last node activity** = time since
> the newest signal naming this node, with the signal that supplied it in
> parentheses (a main-process log line, or the run's own progress heartbeat —
> most scraper log lines carry no nodeId, so logs alone understate activity).
> A matching pending Non-API AI handoff on the same node and IPC channel is
> reported as **awaiting a handoff response**, not hung; see its redacted receipt
> below for delivery and Board-progress context.
> A large age + stale activity (⚠️ possibly hung, >3m of silence) is the
> signature of a stuck task — e.g. a request hanging on a network call that
> never returns.${foreignCount > 0 ? ` (${foreignCount} task(s) from other canvas windows omitted.)` : ''}

| Node ID | Tasks | Oldest task age | Last node activity | Channel(s) |
|---|---|---|---|---|
${rows}
${statusQueueLine}
`;
    } else {
      activeTasksMarkdown = `
## Active IPC Tasks
- ✅ None registered${foreignCount > 0 ? ` (${foreignCount} task(s) running in other canvas windows — expected, not shown here)` : ''}.${statusQueueLine}
`;
    }
  return activeTasksMarkdown;
}

function buildSessionPersistenceMarkdown() {
  let sessionPersistenceMarkdown = '';
    const profile = getBrowserProfileDiagnostics?.() || {};
    const cache = getStatusCacheSync?.() || {};
    const authDiag = getAuthWindowDiagnostics?.() || {};
    const fileLine = (label, entry) => entry?.exists
      ? `- ${label}: ${entry.bytes} bytes · mtime ${entry.mtime}`
      : `- ${label}: (missing)`;
    const cacheEntries = Object.entries(cache);
    const restoredIds = cacheEntries.filter(([, entry]) => entry?.restoredFromDisk).map(([id]) => id);
    const currentBrowser = profile.browser || {};
    // Auth-cookie-on-disk presence per platform with a known session cookie
    // (PLATFORM_AUTH_COOKIES). Written under `lastTrace` by writeStatusCache
    // (extras spread), not `trace` — read the wrong key here and every row
    // prints "not recorded" even when accounts.js just observed one. Two
    // producers populate it: annotateCookieSurvival on a confirmed logged-out
    // verdict, and completeLoginWindowVerification's trusted-native-login
    // survival check, which can record TRUE (a native login that positively
    // confirmed its cookie landed) as well as false/null. A platform whose
    // check never ran this process has no recorded value; one whose check ran
    // but could not read the disk stores an explicit null. Say what was
    // observed rather than guess. Cookie NAMES only.
    const authCookiePresenceLines = Object.keys(PLATFORM_AUTH_COOKIES).map(platformId => {
      const trace = cache[platformId]?.lastTrace;
      const names = (trace?.authCookieNames || PLATFORM_AUTH_COOKIES[platformId] || []).join(',');
      const presentLabel = trace?.authCookiePresent === true ? 'present'
        : trace?.authCookiePresent === false ? 'ABSENT'
          : trace?.authCookiePresent === null ? 'not observed — the on-disk read could not run'
            : 'not recorded';
      return `  - \`${platformId}\` (\`${names}\`): ${presentLabel}`;
    }).join('\n');
    const indeedPreflight = getJobsTelemetry?.()?.indeedSession;
    const indeedPpidLabel = indeedPreflight?.hasPPID === true ? 'yes'
      : indeedPreflight?.hasPPID === false ? 'no'
        : 'not recorded';
    const indeedPpidCrossReference = indeedPreflight
      ? `- Indeed PPID cross-reference: browser session preflight reported **${indeedPpidLabel}**${indeedPreflight.ts ? ` at ${new Date(indeedPreflight.ts).toISOString()}` : ''}; the on-disk survival observation above is a separate check and may be not recorded.`
      : '- Indeed PPID cross-reference: no browser session preflight was recorded this process.';
    sessionPersistenceMarkdown = `
## Session Persistence Diagnostics
> Redacted durability metadata only — cookie values are never read or exported.
> Compare the profile mtimes and close disposition with the login-attempt and
> startup-verification timestamps below. A detected cookie followed by a forced
> close or no profile checkpoint identifies a local persistence failure. A login
> window and a scrape that used different binaries or different profile
> directories cannot share a session — the Executable/Profile columns below are
> what makes that mismatch visible instead of assumed. **Store checkpointed = NO**
> on a row whose login WAS detected means Chromium never committed its batched
> cookie writes before that window closed: the session existed in the window and
> did not reach the profile. \`n/a\` is a window whose close path does not observe
> the checkpoint (the Puppeteer path flushes via \`browser.close()\`). The shared
> browser's \`activity\` is its most recent observed live-page count/URLs (never a
> live query) — \`idle — 0 live pages\` while \`running\` means it holds the shared
> profile lock but isn't doing anything, the signature of a wake-and-forget call.

- Browser profile: \`${redactReportPath(profile.userDataDir)}\`
- Current shared browser: ${currentBrowser.connected ? 'running' : 'stopped'} · generation ${currentBrowser.generation ?? '—'} · executable \`${redactReportPath(currentBrowser.executablePath, '(not launched this process)')}\` · activity: ${formatStealthBrowserActivity(currentBrowser.activity)}
${fileLine('Cookies DB', profile.cookies)}
${fileLine('Cookies journal', profile.cookiesJournal)}
${fileLine('Cookies WAL', profile.cookiesWal)}
${fileLine('Local State', profile.localState)}
${fileLine('Default/Preferences', profile.preferences)}
- In-memory session-cache entries: ${cacheEntries.length}
- Still sourced from prior-process restore: ${restoredIds.length ? restoredIds.map(id => `\`${id}\``).join(', ') : '(none — every current row is fresh or disconnected)'}
- Auth cookie present on disk, per platform with a known session cookie (recorded when a survival check ran — confirmed logged-out verify or trusted native login):
${authCookiePresenceLines}
${indeedPpidCrossReference}

${buildAuthLifecycleTableMarkdown(authDiag.history)}

${buildNativeChallengeSessionMarkdown(authDiag.history)}`;
  return sessionPersistenceMarkdown;
}

function buildMarketplaceSessionsMarkdown(sectionOmitted) {
  let marketplaceSessionsMarkdown = '';
    const platforms = getSellMonitorPlatforms() || [];
    const cache = getStatusCacheSync();

    // Per-platform verify trace surfaces target URL, final URL, HTTP status, and
    // the first chars of the response body so a "I just logged in but it says
    // false" report shows whether the platform served a soft login wall, a 4xx,
    // or genuinely no auth-redirect. Shared with the job-platform section below.
    const rows = renderSessionRows(platforms, cache);
    const traceBlocks = renderSessionTraceBlocks(platforms, cache);

    marketplaceSessionsMarkdown = `
## Marketplace Sessions
> In-memory session cache — verified fresh on every startup. An entry only
> exists after \`verifyAllPlatforms\` has reached that platform (or after a
> manual \`openLoginWindow\` flow). "No entry" means startup verify hasn't
> finished yet or the platform was skipped. \`false\` with the user reporting
> "I just logged in" points at \`verifySellMonitorLogin\` failing. The trace
> below retains route/status and closed detection facts, but never page text.

| Platform ID | Name | Cached connected | Last confirmed | Last reason |
|---|---|---|---|---|
${rows}

${sectionOmitted('sessionTraces') ? '_(per-platform verify traces omitted by filter code — XSESS)_\n' : (traceBlocks ? '### Last verify trace per platform\n\n' + traceBlocks + '\n' : '')}`;
  return marketplaceSessionsMarkdown;
}

function buildJobSessionsMarkdown(sectionOmitted) {
  let jobSessionsMarkdown = '';
    const platforms = getJobLoginPlatforms() || [];
    const cache = getStatusCacheSync();

    const rows = renderSessionRows(platforms, cache);
    const traceBlocks = renderSessionTraceBlocks(platforms, cache);

    jobSessionsMarkdown = `
## Job Platform Sessions
> In-memory session cache for job-board logins — same startup verify as
> marketplace sessions. A verify URL returning 404 means the platform
> changed its URL structure; update \`verifyUrl\` in \`JOB_LOGIN_PLATFORMS\`
> in stealthBrowser.js. "No entry" = startup verify hasn't reached this platform yet.

| Platform ID | Name | Cached connected | Last confirmed | Last reason |
|---|---|---|---|---|
${rows}

${sectionOmitted('sessionTraces') ? '_(per-platform verify traces omitted by filter code — XSESS)_\n' : (traceBlocks ? '### Last verify trace per platform\n\n' + traceBlocks + '\n' : '')}`;
  return jobSessionsMarkdown;
}

// A captcha window proves only that its challenge was cleared; it does not
// observe an authenticated session. Keep that distinction at the report
// boundary so a successful Solve never renders as a failed login.
export function formatAuthAttemptStatus(attempt) {
  const isChallenge = attempt?.mode === 'captcha-resolve'
    || (attempt?.mode === 'native-chrome'
      && String(attempt?.platformId || '').endsWith('-native-challenge'));
  if (isChallenge) {
    return attempt?.result === 'cleared'
      ? '✅ challenge cleared'
      : `challenge result=${/^(?:timeout|closed|failed|cancelled)$/i.test(String(attempt?.result || '')) ? attempt.result : closeReportDiagnostic(attempt?.result, '—')}`;
  }
  return attempt?.loginDetected
    ? `✅ detected${attempt.loginSignal === 'auth-cookie' ? ' (auth-cookie)' : attempt.loginSignal ? ' (signal recorded)' : ''}`
    : '❌ NOT detected';
}

function buildAuthWindowMarkdown() {
  let authWindowMarkdown = '';
    const diag = getAuthWindowDiagnostics?.();
    const profileReservation = getSharedProfileReservationInfo?.();
    const entries = [
      ...(Array.isArray(diag?.active) ? diag.active.map(d => ({ ...d, state: 'active' })) : []),
      diag?.last ? { ...diag.last, state: 'last' } : null,
    ].filter(Boolean);
    // Also render when launch collisions were recorded but no auth/login window
    // was ever involved: the shared-profile liveness + collision lines live in
    // this block, and gating them on an auth window meant two headless scrapes
    // colliding with each other produced a FULL report with no trace of it at
    // all — the exact evidence needed, silently absent.
    const collisionTelemetry = getLaunchCollisions?.();
    if (entries.length > 0 || profileReservation || (collisionTelemetry?.total || 0) > 0) {
      const rows = entries.map(d => {
        const age = d.updatedAt ? `${Math.round((Date.now() - new Date(d.updatedAt).getTime()) / 1000)}s ago` : '—';
        return `| ${d.state} | \`${d.platformId || '—'}\` | ${d.mode || '—'} | \`${redactReportUrl(d.currentUrl || d.loginUrl) || '—'}\` | ${d.title ? 'captured' : '—'} | ${AUTH_RESULTS.has(d.result) ? d.result : d.result ? 'recorded' : '—'} | ${age} |`;
      }).join('\n');
      const argsRows = entries
        .filter(d => Array.isArray(d.chromeArgs) && d.chromeArgs.length > 0)
        .map(d => `**${d.platformId ?? '?'} (${d.state})**: \`${redactReportLogSecrets(redactReportLocalPathsInText(redactReportUrlsInText(d.chromeArgs.join(' '))))}\``);
      const argsSection = argsRows.length > 0
        ? `\n### Chrome launch args\n${argsRows.join('\n')}\n`
        : '';
      // Resolve outcome — the "why" behind a closed/failed captcha-resolve window,
      // now persisted ON the window record (authWindows.js cleanup) instead of
      // living only in the transient main-log ring buffer. This is what was missing
      // when a SITE_CHANGED auto-close left a window stuck at result=open: the close
      // reason had to be grepped out of Recent Logs, one long-running window away
      // from scrolling out. `closed=site-changed-auto-close` ⇒ stale selectors (the
      // card should offer Retry, not Solve).
      const resolveDiagRows = entries
        .filter(d => d.closeReason || d.extractOutcome || d.siteChangedError)
        .map(d => {
          const bits = [];
          if (d.closeReason) bits.push(`closed=${closeReportDiagnostic(d.closeReason, 'recorded')}`);
          if (d.extractOutcome) bits.push(`extractor=${closeReportDiagnostic(d.extractOutcome, 'recorded')}`);
          if (typeof d.textLen === 'number') bits.push(`textLen=${d.textLen}`);
          if (d.hostMismatch) bits.push(`probe skipped=${closeReportDiagnostic(d.probeSkippedReason, 'recorded')}`);
          bits.push(`saw captcha=${d.sawChallenge ? 'yes' : 'no'} / consent=${d.sawConsent ? 'yes' : 'no'}`);
          // 1400, not 400: matches the cap in marketplace.js's classifyCompScrapeFailure —
          // 400 was clipping the diag's card0=[…] class skeleton (the new markup's
          // title/price sub-selector names) before a bug report ever showed it, even
          // under FULL. This is a bounded, per-window field (not a log ring buffer),
          // so the wider cap can't blow the report's size budget.
          if (d.siteChangedError) bits.push(`SITE_CHANGED: ${closeReportDiagnostic(d.siteChangedError, 'recorded')}`);
          return `- **${d.platformId ?? '?'} (${d.state})**: ${bits.join(' · ')}`;
        });
      const resolveDiagSection = resolveDiagRows.length > 0
        ? `\n### Resolve outcome (why the window closed / failed)\n> Persisted on the window record — survives the Recent Logs ring buffer.\n${resolveDiagRows.join('\n')}\n`
        : '';
      // Login-attempt history — every COMPLETED login window this session, with
      // whether it confirmed login. Survives the main-log ring buffer (a verbose
      // login flow scrolls the others out in seconds). This is the discriminator
      // for "I just logged into X but it says logged out": `detected` ⇒ the window
      // confirmed login (so a later logged-out state = the session didn't persist
      // or the re-verify rejected it), `not detected` ⇒ the login never completed.
      // Newest-first over the WHOLE retained ring, not a second newest-12 cut:
      // the ring is already bounded upstream, and the narrower cut is what
      // erased three `indeed-native-challenge` rows behind 12 routine `captcha:`
      // rows — at the time the only place buildNativeChallengeHistoryEvidence
      // rendered at all (it now also has an unconditional section in Session
      // Persistence Diagnostics). See AUTH_HISTORY_RING_CAP.
      const historySelection = selectAuthHistoryForReport(diag?.history);
      const historyRows = historySelection.rows
        .map(h => {
          const age = h.finishedAt ? `${Math.round((Date.now() - new Date(h.finishedAt).getTime()) / 1000)}s ago` : '—';
          const detected = formatAuthAttemptStatus(h);
          const title = h.title ? ', title=captured' : '';
          const open = Number.isFinite(h.openMs) ? ` · open ${(h.openMs / 1000).toFixed(1)}s` : '';
          const close = h.closeDisposition
            ? ` · close=${authCloseDisposition(h.closeDisposition, 'recorded')}, flush=${h.cookieFlushMs ?? 0}ms, exit=${h.processExitObserved ? 'observed' : 'NOT observed'}`
            : '';
          const cookieMeta = Array.isArray(h.authCookiesBeforeClose) && h.authCookiesBeforeClose.length > 0
            ? ` · auth cookies before close=${h.authCookiesBeforeClose.map(c => `${c.name}:${c.persistent ? 'persistent' : 'session'}`).join(',')}`
            : '';
          const isNativeChallenge = h.mode === 'native-chrome'
            && String(h.platformId || '').endsWith('-native-challenge');
          const nativeEvidence = isNativeChallenge ? buildNativeChallengeHistoryEvidence(h) : '';
          return `- \`${h.platformId || '?'}\` — ${AUTH_RESULTS.has(h.result) ? h.result : h.result ? 'recorded' : '—'}, ${detected}, ${h.mode || '—'}, ${age}${open}${close}${cookieMeta}${nativeEvidence}${title}${h.url ? ` — \`${redactReportUrl(h.url)}\`` : ''}`;
        });
      const historySection = historyRows.length > 0
        ? `\n### Recent login and captcha attempts (this session)\n> The completed login/captcha windows this process still retains, newest first. Login rows state whether the window CONFIRMED login: **detected** ⇒ a later logged-out state means the session did not persist or re-verification rejected it; **NOT detected** ⇒ login did not complete in that window. Captcha rows state challenge clearance only — clearing a challenge is not a login assertion. Native Indeed handoffs additionally retain bounded poll/child-exit/post-close-verification evidence; URL query tokens and cookie values are never reported. \`open\` is how long the window stayed open: an auto-detected window open for only a few seconds means the session was already live when the window opened; paired with an earlier same-session startup verify that said not-connected, that indicates the startup verify missed a live session rather than a fresh login.\n${historyRows.join('\n')}\n${formatAuthHistoryTruncationNote(historySelection, 'completed login/captcha window record(s)')}`
        : '';
      // Scrape/stealth browser liveness — a captcha/login window launches a
      // VISIBLE Chrome on the SAME userDataDir, so an alive scrape browser here
      // is the prime suspect for a window that won't open (profile lock). A
      // `launching`/`open` row above with this still 🟢 alive = lock conflict.
      let stealthLine = '';
      try {
        const sb = getStealthBrowserInfo?.() || {};
        const sbAge = sb.launchedAt ? `${Math.round((Date.now() - sb.launchedAt) / 1000)}s ago` : '—';
        // A job browser scrape CLOSES this singleton and launches its own Chrome
        // on the same shared userDataDir, so `connected:false` proves only that
        // the singleton is down — not that the profile is free. Saying "profile
        // lock free" on that basis was affirmatively wrong during every manual
        // scrape; report the scraper's own process instead of inferring.
        const ms = getManualScraperTelemetry?.() || {};
        const scrapeChrome = ms.browser?.running ? ms.browser : null;
        const profileLock = getSharedProfileLockSnapshot?.() || {};
        const activeProfileWorkflow = profileLock.active || null;
        const fifoNote = activeProfileWorkflow
          ? ` · app FIFO active: \`${truncateDiagnosticText(String(activeProfileWorkflow.label || 'unnamed workflow').replace(/`/g, "'"), 120)}\` for ${Number.isFinite(activeProfileWorkflow.since) ? `${Math.max(0, Math.round((Date.now() - activeProfileWorkflow.since) / 1000))}s` : 'an unknown duration'}${Number.isFinite(profileLock.queueDepth) ? ` (queue depth ${profileLock.queueDepth})` : ''}`
          : '';
        const lockNote = scrapeChrome
          ? `⚪ singleton not running — but the job scraper's OWN Chrome is 🟢 running (pid ${scrapeChrome.pid ?? '—'}, launched ${scrapeChrome.launchedAt ? `${Math.round((Date.now() - scrapeChrome.launchedAt) / 1000)}s ago` : '—'}) on the shared profile, so the profile lock is **held**${fifoNote}`
          : activeProfileWorkflow
            ? `⚪ no owned Chrome process is currently reported; app FIFO ownership is active${fifoNote}`
            : '⚪ no owned Chrome process is currently reported (profile availability not independently verified)';
        stealthLine = `\n- Scrape/stealth browser: ${sb.connected ? `🟢 alive (generation #${sb.generation}, launched ${sbAge}) — holds the shared userDataDir; a window stuck \`launching\` above points at a profile-lock conflict` : lockNote}\n`;
      } catch { /* ignore */ }
      // A visible login/captcha window may reserve the profile before Chrome is
      // launched. That reservation blocks a concurrent headless scrape even
      // while the liveness line above correctly says no scrape browser exists.
      let profileReservationLine = '';
      if (profileReservation) {
        const age = Number.isFinite(profileReservation.since)
          ? `${Math.max(0, Math.round((Date.now() - profileReservation.since) / 1000))}s ago`
          : 'at an unknown time';
        const reason = closeReportDiagnostic(profileReservation.reason, 'visible-window');
        profileReservationLine = `\n- ⚠️ Shared profile reservation: \`${reason}\` (${age}) — a headless scrape must wait until that visible browser closes.\n`;
      }
      // Shared-profile launch collisions — PERSISTED across the log ring buffer.
      // A collision = a Chrome launch that failed because another window/scrape
      // already held the shared userDataDir lock (captcha-resolve window racing a
      // headless rescrape, or two overlapping windows). These otherwise live only
      // in Recent Logs, which scrolls away in a long run. `recovered` ones retried
      // automatically (no user action); un-recovered ones surfaced an error and
      // likely forced a manual re-Solve / re-click.
      let launchCollisionLine = '';
      try {
        const lc = getLaunchCollisions?.() || { total: 0, recovered: 0, events: [] };
        if (lc.total > 0) {
          const last = lc.events[lc.events.length - 1];
          let lastBit = '';
          if (last) {
            let host = '';
            try { host = last.url ? ` ${new URL(last.url).host}` : ''; } catch { /* non-URL */ }
            const ago = last.ts ? `, ${Math.round((Date.now() - last.ts) / 1000)}s ago` : '';
            // Distinguishes "our own idle browser held it (and was asked to yield)"
            // from "something else held it and never yielded" — a visible window a
            // person left open, vs. the retained singleton. `null` (older event, or a
            // caller that never reported it) says neither, honestly, rather than
            // defaulting to one.
            const yieldBit = last.askedSingletonToYield === true
              ? ' The retained singleton was asked to yield during this attempt.'
              : last.askedSingletonToYield === false
                ? ' The retained singleton was NOT asked to yield during this attempt (already yielded, not running, or this context can\'t ask itself).'
                : '';
            lastBit = ` Last: \`${last.context}\`${host} — ${last.recovered ? `auto-recovered after ${last.attempts} attempt(s)` : `NOT recovered (${last.attempts} attempt(s))`}${ago}.${yieldBit}`;
          }
          launchCollisionLine = `\n- ⚠️ Shared-profile launch collisions: **${lc.total}** total, ${lc.recovered} auto-recovered. A Chrome launch hit the userDataDir lock held by another window/scrape (captcha-resolve window racing a headless rescrape, or overlapping windows).${lastBit} Recovered ones retried silently; un-recovered ones forced a manual re-Solve/re-click.\n`;
        }
      } catch { /* ignore */ }
      // Which platforms are SUPPOSED to use non-CDP Chrome — the decisive axis for
      // login-loop bugs. A platform that delegates to Google SSO (or hits CF
      // Turnstile) loops forever under CDP: Google bounces the OAuth flow back to
      // the platform's own login page. So a `puppeteer-visible` Mode row for a
      // platform that should be native (below) is itself the bug, not a symptom.
      // Native READ platforms ALSO require the Chrome "Allow JavaScript from Apple
      // Events" toggle (View → Developer) — when OFF, their hub reads fail with a
      // precise instruction (see Marketplace Status), though login is unaffected
      // (it reads tab URLs, not page JS).
      const nativeLoginList = Array.from(NATIVE_LOGIN_PLATFORMS).join(', ') || '(none)';
      const nativeReadList = Array.from(NATIVE_READ_PLATFORMS).join(', ') || '(none)';
      const nativePathLine = `\n- Native (non-CDP) **login** platforms (Google-SSO / Turnstile — must NOT be \`puppeteer-visible\`): \`${nativeLoginList}\`\n- Native (non-CDP) **hub-read** platforms (need the Chrome "Allow JavaScript from Apple Events" toggle ON): \`${nativeReadList}\`\n`;
      authWindowMarkdown = `
## Auth Window Diagnostics
> Snapshot of visible login/captcha windows. \`mode=native-chrome\` means the
> login was launched without Puppeteer/CDP automation so Google SSO should not
> reject it as an unsafe browser. A \`captcha-resolve\` row stuck at
> \`result=launching\` means the visible window never finished opening (hung on
> the profile lock or a macOS permission prompt) — see Recent Logs for the
> 30s launch-timeout error. A row stuck at \`result=open\` with NO matching
> "Resolve outcome" line below AND a live Active IPC Task for the same node is a
> hung resolve: the window's cleanup never resolved its promise (cross-check the
> Active IPC Tasks section).
${nativePathLine}
| State | Platform | Mode | Current/Login URL | Title | Result | Updated |
|---|---|---|---|---|---|---|
${rows}
${stealthLine}${profileReservationLine}${launchCollisionLine}${argsSection}${resolveDiagSection}${historySection}`;
    }
  return authWindowMarkdown;
}

const AIHANDOFF_MAIN_PROCESS_LOG_PATTERN = /non-api ai|non-api-ai|manual ai|manual handoff|handoff code|validation|jsonrepair/i;
const BRIDGE_MAIN_PROCESS_LOG_PATTERN = /\[HandoffBridge\]|handoff[ -]?bridge|\b(?:oauth|pairing|cloudflared|tunnel|mcp)\b/i;

function buildRecentMainProcessLogLines({ filter } = {}) {
  let mainProcessLogLines = [];
    // Keep source order chronological through all collection work; the shared
    // Markdown renderer reverses it at the last possible boundary. Sorting by
    // the logger's numeric capture timestamp also prevents asynchronous writes
    // from becoming an accidental chronology claim in the report.
    const logs = (getRecentLogs(200) || [])
      .filter(l => Number(l?.ts) >= PROCESS_START_MS)
      .filter(l => typeof filter !== 'function' || filter(l) === true)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    if (logs.length > 0) {
      mainProcessLogLines = logs.map(l => {
        const t = new Date(l.ts).toISOString(); // full ISO UTC, including date
        const lvl = l.level.toUpperCase().padEnd(5, ' ');
        // Trim each line to a reasonable max so a single fat error does not
        // dominate the captured-log section. SITE_CHANGED /
        // [diag …] lines get a wider cap: the generic 500 was cutting the
        // card0=[…] class skeleton off mid-token — the one payload that lets a
        // stale-selector fix be written without re-fetching the live page (which
        // may itself be behind anti-bot walls). These lines are rare (a handful
        // of ERROR entries, not the whole 60-line buffer), so raising just their
        // cap cannot dominate the section the way raising the default for every
        // retained line would.
        // Logger messages can contain redirect/challenge URLs with OAuth,
        // Cloudflare, or tracking tokens. The path is useful diagnostic
        // evidence; query and fragment values are not safe to export.
        const raw = redactReportOpaqueIds(redactReportLogSecrets(redactReportLocalPathsInText(redactReportUrlsInText(l.message || '')).replace(/\r?\n/g, ' ⏎ ')));
        const cap = /SITE_CHANGED|\[diag |\[timeout-state | failed: .* stack: at /i.test(raw) ? 1400 : 500;
        const msg = truncateDiagnosticText(raw, cap);
        return `[${t}] ${lvl} ${msg}`;
      });
    }
  return mainProcessLogLines;
}

function buildAIConfigurationMarkdown() {
  const aiConfig = buildAIConfigSnapshot();
  const aiConfigMarkdown = `
## AI Configuration
- The local \`${aiConfig.transport}\` registry owns every AI handoff and normally presents it in the human copy/paste dock. An eligible task from a released, selected hub may instead be served to a linked ChatGPT session through the local MCP bridge, then submitted back to that same registry.
- Neither route selects a live API provider, API key, or model. Use Handoff Bridge Diagnostics for bridge scope/discovery/selection evidence and Non-API AI Handoff Lifecycle for the individual handoff outcome.
- Known task ids (${aiConfig.knownTaskCount}): ${aiConfig.knownTaskIds.length ? aiConfig.knownTaskIds.map(id => `\`${id}\``).join(', ') : '(unresolved)'}
`;
  return aiConfigMarkdown;
}

function buildHandoffBridgeDiagnosticsMarkdown() {
  const bootstrap = getHandoffBridgeBootstrapDiagnostic();
  const diagnostic = getFailedStartDiagnostic();
  const oauthRejection = getOAuthRejectionDiagnostic();
  const sourceRejection = getSourceRejectionDiagnostic();
  const clientAuth = getClientAuthDiagnostic();
  const mcpRateLimit = getMcpRateLimitDiagnostic();
  const failedStart = diagnostic?.telemetry === true;
  const rejectedOrigin = oauthRejection?.telemetry === true;
  const rejectedSource = sourceRejection?.telemetry === true;
  const observedClientAuth = clientAuth?.telemetry === true;
  const observedMcpRateLimit = mcpRateLimit?.telemetry === true;
  const queue = getBridgeQueueDiagnostic();
  const chatCopies = getBridgeChatCopyDiagnostic();
  const bootstrapMarkdown = `
- Bridge bootstrap: config \`${bootstrap.config}\` · consent \`${bootstrap.consent}\` · configured auto-start \`${bootstrap.autoStart}\` · enabled \`${bootstrap.enabled}\` · runtime \`${bootstrap.runtime}\` · tunnel \`${bootstrap.tunnel}\`
- Setup readiness: hostname \`${bootstrap.setup.hostname}\` · binary \`${bootstrap.setup.binary}\` · credentials \`${bootstrap.setup.credentials}\` · public tunnel \`${bootstrap.setup.tunnelReachable}\`
- Startup policy: decision \`${bootstrap.startup.decision}\` · refusal \`${bootstrap.startup.refusal}\``;
  let queueMarkdown = '';
  if (queue) {
    const laneAge = seconds => seconds === null ? 'unknown' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
    const liveLanes = queue.liveLanes;
    const laneRows = queue.lanes.map(lane => `  - job \`${lane.job}\` · phase \`${lane.phase}\` · stage \`${lane.stage || 'none'}\` · reason \`${lane.reason || 'none'}\` · served to current chat \`${lane.servedToChat ? 'yes' : 'no'}\` · in this phase ${laneAge(lane.ageSeconds)}`).join('\n');
    const exactTime = value => Number.isFinite(value) ? new Date(value).toISOString() : 'not recorded';
    const pushObservation = (outcome, at, seconds) => outcome === 'none'
      ? 'no result recorded'
      : `latest \`${outcome}\` at ${exactTime(at)} (${laneAge(seconds)} ago)`;
    const pushTasks = queue.push.tasks.length
      ? queue.push.tasks.map(item => `\`${item.task}\` ${item.pending}`).join(' · ')
      : '(none observed)';
    const exclusions = Object.entries(queue.push.exclusions).filter(([, count]) => count > 0)
      .map(([reason, count]) => `\`${reason}\` ${count}`).join(' · ') || '(none observed)';
    const pushOwnership = queue.push.served === 0
      ? 'no outstanding MCP handoffs'
      : `${queue.push.served} outstanding MCP handoff${queue.push.served === 1 ? '' : 's'}`;
    const dockReason = queue.push.selectedPending === 0
      ? 'no_selected_push'
      : queue.chat.state === 'none'
        ? 'no_chat'
        : queue.push.selectedPolls === 0
          ? 'no_mcp_poll'
          : queue.push.claimed > 0
            ? 'claimed'
            : queue.push.available > 0
              ? 'awaiting_claim'
              : 'not_available';
    const activityRows = (Array.isArray(queue.activity) ? queue.activity : []).map(item => {
      const outcome = item.outcome ? ` · outcome \`${item.outcome}\`` : '';
      return `  - ${exactTime(item.at)} · \`${item.kind}\`${outcome}`;
    }).join('\n');
    // `workers` is the planned pool size, not evidence that every worker is
    // connected or currently processing. Keep those states separate so a
    // report can explain a stale-looking copy control without implying that a
    // worker stopped when the dock moved to a later batch.
    const rawWorkerPool = queue.chat.pool && typeof queue.chat.pool === 'object' ? queue.chat.pool : {};
    const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(999999, value) : 0;
    const workerStates = {
      available: 'awaiting starter copy',
      ready: 'starter copied; awaiting first call',
      working: 'processing',
      quiet: 'needs recovery',
      waiting: 'connected; awaiting work',
      idle: 'connected; idle',
    };
    const plannedWorkers = Math.min(HANDOFF_BRIDGE_CONSTANTS.MAX_LANES, boundedCount(rawWorkerPool.workers));
    const workerRoster = (Array.isArray(rawWorkerPool.roster) ? rawWorkerPool.roster : []).flatMap(worker => {
      if (!worker || typeof worker !== 'object' || !Number.isSafeInteger(worker.ordinal)
        || worker.ordinal < 1 || worker.ordinal > plannedWorkers || !Object.hasOwn(workerStates, worker.state)
        || !Number.isSafeInteger(worker.completed) || worker.completed < 0) return [];
      return [{
        ordinal: worker.ordinal, state: worker.state, completed: Math.min(999999, worker.completed),
        firstCallAt: Number.isFinite(worker.firstCallAt) ? worker.firstCallAt : null,
        lastCallAt: Number.isFinite(worker.lastCallAt) ? worker.lastCallAt : null,
        lastCallKind: ['get', 'submit'].includes(worker.lastCallKind) ? worker.lastCallKind : null,
        lastOutcome: ['served', 'waiting', 'queue_empty', 'paused', 'session_full', 'needs_user', 'retry', 'accepted', 'rejected', 'held', 'unknown_handoff', 'session_ended'].includes(worker.lastOutcome) ? worker.lastOutcome : null,
        lastOutcomeAt: Number.isFinite(worker.lastOutcomeAt) ? worker.lastOutcomeAt : null,
        quietReason: ['polling_stopped', 'answer_silent'].includes(worker.quietReason) ? worker.quietReason : null,
        restarts: boundedCount(worker.restarts),
      }];
    }).sort((left, right) => left.ordinal - right.ordinal).slice(0, HANDOFF_BRIDGE_CONSTANTS.MAX_LANES);
    const closedPoolHistory = (Array.isArray(rawWorkerPool.history) ? rawWorkerPool.history : []).slice(-3).flatMap(pool => {
      if (!pool || !['drained', 'source_ended', 'continued', 'rotated', 'link_changed', 'revoked', 'quit', 'disabled', 'other'].includes(pool.reason)
        || !Number.isFinite(pool.endedAt) || !Number.isSafeInteger(pool.workerCount) || pool.workerCount < 1 || pool.workerCount > HANDOFF_BRIDGE_CONSTANTS.MAX_LANES) return [];
      const workers = (Array.isArray(pool.workers) ? pool.workers : []).flatMap(worker => {
        if (!worker || !Number.isSafeInteger(worker.ordinal) || worker.ordinal < 1 || worker.ordinal > pool.workerCount
          || !Object.hasOwn(workerStates, worker.state) || !Number.isSafeInteger(worker.completed) || worker.completed < 0) return [];
        return [{ ordinal: worker.ordinal, state: worker.state, completed: Math.min(999999, worker.completed),
          lastCallAt: Number.isFinite(worker.lastCallAt) ? worker.lastCallAt : null,
          lastOutcome: ['served', 'waiting', 'queue_empty', 'paused', 'session_full', 'needs_user', 'retry', 'accepted', 'rejected', 'held', 'unknown_handoff', 'session_ended'].includes(worker.lastOutcome) ? worker.lastOutcome : null,
          quietReason: ['polling_stopped', 'answer_silent'].includes(worker.quietReason) ? worker.quietReason : null,
          restarts: boundedCount(worker.restarts) }];
      }).sort((left, right) => left.ordinal - right.ordinal).slice(0, HANDOFF_BRIDGE_CONSTANTS.MAX_LANES);
      return [{ endedAt: pool.endedAt, reason: pool.reason, workerCount: pool.workerCount, workers }];
    });
    const observedWorkers = workerRoster.length;
    const workerStatusCount = value => Math.min(plannedWorkers, boundedCount(value));
    const workerCounts = {
      readyToCopy: workerStatusCount(rawWorkerPool.readyToCopy),
      starterCopied: workerStatusCount(rawWorkerPool.starterCopied),
      connected: workerStatusCount(rawWorkerPool.connected),
      working: workerStatusCount(rawWorkerPool.working),
      quiet: workerStatusCount(rawWorkerPool.quiet),
      waiting: workerStatusCount(rawWorkerPool.waiting),
      idle: workerStatusCount(rawWorkerPool.idle),
      completed: boundedCount(rawWorkerPool.completed),
      unreported: workerStatusCount(rawWorkerPool.unreported),
    };
    const rawPoolPlan = rawWorkerPool.plan && typeof rawWorkerPool.plan === 'object' ? rawWorkerPool.plan : {};
    const poolPlanRecommended = Math.min(HANDOFF_BRIDGE_CONSTANTS.MAX_LANES, boundedCount(rawPoolPlan.recommended));
    const poolPlanQueued = boundedCount(rawPoolPlan.queued);
    const poolPlanMaterialized = Math.min(poolPlanQueued, boundedCount(rawPoolPlan.materialized));
    const poolPlanExpandBy = Math.min(HANDOFF_BRIDGE_CONSTANTS.MAX_LANES, boundedCount(rawPoolPlan.expandBy));
    const poolPlanReason = ['empty', 'one_work_item', 'maximum_parallelism', 'preserved_live_workers'].includes(rawPoolPlan.reason)
      ? rawPoolPlan.reason
      : 'empty';
    const poolExpansionCount = Math.min(999, boundedCount(rawPoolPlan.expansionCount));
    const poolLastExpansionAt = Number.isFinite(rawPoolPlan.lastExpansionAt) ? rawPoolPlan.lastExpansionAt : null;
    const poolLastExpansionAdded = Math.min(HANDOFF_BRIDGE_CONSTANTS.MAX_LANES, boundedCount(rawPoolPlan.lastExpansionAdded));
    const workerPoolPlan = rawWorkerPool.active !== true
      ? 'no active worker pool'
      : `current ${plannedWorkers} · recommended ${poolPlanRecommended} · materialized now ${poolPlanMaterialized} · total forecast ${poolPlanQueued} · expandable ${poolPlanExpandBy} · reason \`${poolPlanReason}\`${poolExpansionCount ? ` · automatic expansion ${poolExpansionCount} at ${exactTime(poolLastExpansionAt)} (+${poolLastExpansionAdded})` : ''}`;
    const workerLifecycle = rawWorkerPool.active !== true
      ? closedPoolHistory.length
        ? `no active pool · ${closedPoolHistory.length} recent worker pool${closedPoolHistory.length === 1 ? '' : 's'} retained below`
        : 'legacy single chat'
      : plannedWorkers === 0
        ? 'worker pool active; worker plan unavailable'
        : observedWorkers === 0
          ? `${plannedWorkers} worker chat${plannedWorkers === 1 ? '' : 's'} planned · per-worker lifecycle not yet reported`
          : [
            `${plannedWorkers} worker chat${plannedWorkers === 1 ? '' : 's'} planned`,
            `${workerCounts.connected} connected`,
            `${workerCounts.working} processing`,
            workerCounts.quiet > 0 ? `${workerCounts.quiet} ${workerCounts.quiet === 1 ? 'worker needs recovery' : 'workers need recovery'}` : null,
            `${workerCounts.completed} completed`,
            workerCounts.readyToCopy > 0 ? `${workerCounts.readyToCopy} awaiting starter copy` : null,
            workerCounts.starterCopied > 0 ? `${workerCounts.starterCopied} starter copied; awaiting first call` : null,
            workerCounts.waiting > 0 ? `${workerCounts.waiting} connected; awaiting work` : null,
            workerCounts.idle > 0 ? `${workerCounts.idle} connected; idle` : null,
            workerCounts.unreported > 0 ? `${workerCounts.unreported} worker status${workerCounts.unreported === 1 ? '' : 'es'} not reported` : null,
          ].filter(Boolean).join(' · ');
    const workerDetail = worker => [
      worker.lastCallAt === null ? null : `last call ${exactTime(worker.lastCallAt)}`,
      worker.lastCallKind ? worker.lastCallKind : null,
      worker.lastOutcome ? `result ${worker.lastOutcome}` : null,
      worker.quietReason === 'polling_stopped'
        ? 'stopped polling after a requested wait'
        : worker.quietReason === 'answer_silent'
          ? 'no MCP response since this handoff was served for at least 5 min; response may still be generating or this worker may have stopped'
          : null,
      worker.restarts > 0 ? `${worker.restarts} replacement${worker.restarts === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');
    const workerRosterRows = workerRoster.length === 0 ? '' : `\n${workerRoster.map(worker =>
      `  - worker ${worker.ordinal}: ${workerStates[worker.state]} · ${worker.completed} completed${workerDetail(worker) ? ` · ${workerDetail(worker)}` : ''}`).join('\n')}`;
    const closedPoolRows = closedPoolHistory.length === 0 ? '' : `\n- Recent closed worker pools (bounded to 3):\n${closedPoolHistory.map(pool =>
      `  - ${exactTime(pool.endedAt)} · close \`${pool.reason}\` · ${pool.workerCount} worker${pool.workerCount === 1 ? '' : 's'}${pool.workers.length ? ` · ${pool.workers.map(worker => `#${worker.ordinal} ${worker.state}/${worker.completed}${worker.lastOutcome ? `/${worker.lastOutcome}` : ''}${worker.quietReason ? `/${worker.quietReason}` : ''}${worker.restarts ? `/restarted-${worker.restarts}` : ''}`).join(', ')}` : ''}`).join('\n')}`;
    const byteBudget = `${queue.chat.bytes} bytes (diagnostic only; no bridge rollover)`;
    queueMarkdown = `
- Application lanes (as of ${new Date(queue.at).toISOString()}): bridge \`${queue.enabled ? 'enabled' : 'disabled'}\` · serving \`${queue.serving}\` · auto-release \`${queue.autoRelease ? 'on' : 'off'}\` · paused \`${queue.paused || 'no'}\` · fault \`${queue.fault || 'none'}\`
- Delivery readiness: tunnel \`${queue.readiness.tunnelReachable ? 'reachable' : 'not-reachable'}\` · ChatGPT link \`${queue.readiness.linked ? 'linked' : 'not-linked'}\` · chat \`${queue.chat.state}\` · selected-text route \`${dockReason}\` · auto-release applies to application bundles only; selecting text work does not itself start a ChatGPT MCP client.
- MCP chat calls: ${queue.chat.calls} · started ${exactTime(queue.chat.startedAt)} · first tool call ${exactTime(queue.chat.firstCallAt)} · latest ${queue.chat.lastCallKind ? `\`${queue.chat.lastCallKind}\` at ${exactTime(queue.chat.lastCallAt)}` : 'none recorded'}
- Application lanes: ready ${queue.applications.ready} · working ${queue.applications.working} · needs you ${queue.applications.needsYou} (held ${queue.applications.held}) · finished ${queue.applications.done} · live lanes ${liveLanes}/${queue.liveLaneCapacity}
- Chat delivery: \`${queue.chat.state}\` · traffic ${byteBudget} · application bundles assigned ${queue.chat.jobsAssigned} (no per-chat assignment cap)
- Worker lifecycle: ${workerLifecycle}${workerRosterRows}${closedPoolRows}
- Worker pool planner: ${workerPoolPlan}
- Push/MCP consent: scoring \`${queue.scope.scoring ? 'on' : 'off'}\` · marketplace \`${queue.scope.marketplace ? 'on' : 'off'}\` · application lanes \`${queue.scope.applications ? 'on' : 'off'}\`
- Push discovery: ${queue.push.discoveredHubs} hub${queue.push.discoveredHubs === 1 ? '' : 's'} discovered · ${queue.push.selectedHubs} selected (${queue.push.selectedDiscoveredHubs} still in the latest inventory) · ${queue.push.optedOutHubs} explicitly unselected · pending ${queue.push.discoveredPending} total / ${queue.push.selectedPending} selected / ${queue.push.unselectedPending} left in unselected hubs
- Push delivery routes: local registry has ${queue.push.selectedPending} selected pending · MCP-delivered and awaiting an answer ${pushOwnership} · active MCP claim${queue.push.claimed === 1 ? '' : 's'} ${queue.push.claimed} · selected and available for the next MCP get ${queue.push.available} · returned to local manual dock ${queue.push.held}
- Bridge submit outcomes: accepted ${queue.counts.submitAccepted} · rejected ${queue.counts.submitRejected} · duplicate ${queue.counts.submitDuplicate} · invalid ${queue.counts.submitJunk + queue.counts.submitTooLarge} · superseded/misrouted ${queue.counts.submitSuperseded + queue.counts.submitMisrouted} · held ${queue.counts.submitHeld}
- Pending push tasks: ${pushTasks}
- Push exclusions from the latest \`${queue.push.exclusionScope}\` inventory: ${exclusions}
- Push refresh evidence: all-hub discovery ${queue.push.refreshAttempts} call(s), ${queue.push.refreshFailures} failure(s), ${pushObservation(queue.push.lastRefresh, queue.push.lastRefreshAt, queue.push.lastRefreshAgeSeconds)} · selected-hub MCP polls ${queue.push.selectedPolls}, ${queue.push.selectedPollFailures} failure(s), ${pushObservation(queue.push.lastSelectedPoll, queue.push.lastSelectedPollAt, queue.push.lastSelectedPollAgeSeconds)}
- Recent bridge activity: ${activityRows ? `${queue.activity.length} event(s), oldest first (bounded to 20)\n${activityRows}` : 'none recorded'}
- Unrecognised chat keys: ${queue.keys.unrecognisedRecent} in the last ${queue.keys.unrecognisedWindowMinutes} min (last at ${queue.keys.lastUnrecognisedAt === null ? 'none recorded' : new Date(queue.keys.lastUnrecognisedAt).toISOString()})
- Ended-chat keys: ${queue.keys.ended}
- Lane lifecycle counters: release calls ${queue.counts.releaseCalls} (added nothing: ${queue.counts.releaseNoops}) · Unrelease ${queue.counts.unreleaseCalls} · lanes dropped by the app ${queue.counts.lanesDropped} (discard event ${queue.counts.droppedDiscarded} · prune event ${queue.counts.droppedPruned} · status probe found the bundle gone ${queue.counts.droppedMissing} · status probe reported it saved ${queue.counts.droppedSaved})${laneRows ? `\n${laneRows}` : '\n  - (no lanes)'}`;
  }
  let failedStartMarkdown = '';
  if (failedStart) {
    const elapsed = Number.isFinite(diagnostic.elapsedMs) ? `${diagnostic.elapsedMs} ms` : 'not recorded';
    const at = Number.isFinite(diagnostic.at) ? new Date(diagnostic.at).toISOString() : 'not recorded';
    const tunnel = diagnostic.tunnel && typeof diagnostic.tunnel === 'object' ? diagnostic.tunnel : {};
    const probe = tunnel.probe && typeof tunnel.probe === 'object' ? tunnel.probe : {};
    const readiness = tunnel.readiness && typeof tunnel.readiness === 'object' ? tunnel.readiness : {};
    failedStartMarkdown = `
- Failed start: phase \`${diagnostic.phase || 'unknown'}\` · cause \`${diagnostic.cause || 'unknown'}\`
- Tunnel: state \`${tunnel.state || 'unknown'}\` · last exit \`${tunnel.lastExit || 'none'}\`
- Configuration validation: ${readiness.configurationValidated === true ? 'passed' : 'not completed'} · environment check: ${readiness.environmentHealthy === true ? 'healthy' : 'not observed'} · local readiness: ${readiness.localReadinessPassed === true ? 'passed' : 'not confirmed'} · observed registered tunnel connections: ${Number.isFinite(readiness.registeredConnectionCount) ? Math.max(0, Math.min(8, readiness.registeredConnectionCount)) : 0}
- Public probe: state \`${probe.state || 'unknown'}\` · reason \`${probe.reason || 'unknown'}\` · consecutive failures ${Number.isFinite(probe.consecutiveFailures) ? probe.consecutiveFailures : 0}
- Recorded: ${at} · elapsed ${elapsed}`;
  }
  let oauthRejectionMarkdown = '';
  if (rejectedOrigin) {
    const last = oauthRejection.last && typeof oauthRejection.last === 'object' ? oauthRejection.last : {};
    const count = Number.isFinite(oauthRejection.count) ? Math.max(1, Math.min(999, Math.floor(oauthRejection.count))) : 1;
    const at = Number.isFinite(oauthRejection.at) ? new Date(oauthRejection.at).toISOString() : 'not recorded';
    oauthRejectionMarkdown = `
- OAuth cross-origin refusals: ${count} · last route \`${last.route || 'unknown'}\` · method \`${last.method || 'unknown'}\` · stage \`${last.stage || 'unknown'}\` · reason \`${last.reason || 'unknown'}\` · fetch site \`${last.fetchSite || 'unknown'}\` · fetch mode \`${last.fetchMode || 'unknown'}\` · fetch destination \`${last.fetchDest || 'unknown'}\` · Origin shape \`${last.originShape || 'unknown'}\` · consent action \`${last.consentAction || 'unknown'}\` · transaction \`${last.hasTxn || 'unknown'}\` · consent policy \`${last.consentPolicyVersion || 'unknown'}\` · status ${last.status === 403 ? 403 : 'unknown'} · recorded ${at}`;
  }
  let sourceRejectionMarkdown = '';
  if (rejectedSource) {
    const last = sourceRejection.last && typeof sourceRejection.last === 'object' ? sourceRejection.last : {};
    const count = Number.isFinite(sourceRejection.count) ? Math.max(1, Math.min(999, Math.floor(sourceRejection.count))) : 1;
    const at = Number.isFinite(sourceRejection.at) ? new Date(sourceRejection.at).toISOString() : 'not recorded';
    // The wire answer for these is a generic 401 invalid_token, so state the
    // real cause plainly here; otherwise this reads as an expired credential.
    sourceRejectionMarkdown = `
- Refused caller networks: ${count} · last route \`${last.route || 'unknown'}\` · policy \`${last.mode || 'unknown'}\` · caller network class \`${last.sourceClass || 'unknown'}\` · active links \`${last.links || 'unknown'}\` · answered 401 \`invalid_token\` · recorded ${at}
  - The caller was refused for its NETWORK, not its token: the request came from a network this link was not paired from and outside the pinned connector ranges. A token that is otherwise valid still gets a generic 401 here.
  - Recovery: Disconnect the existing link FIRST, then pair again. Re-pairing without disconnecting fails, because the token exchange is itself checked against the old link's pinned network.`;
  }
  let clientAuthMarkdown = '';
  if (observedClientAuth) {
    const at = Number.isFinite(clientAuth.at) ? new Date(clientAuth.at).toISOString() : 'not recorded';
    const count = Number.isFinite(clientAuth.count) ? Math.max(1, Math.min(999, Math.floor(clientAuth.count))) : 1;
    // The refresh grant is the decisive one: client authentication runs for it
    // too, so pinning on a code-exchange observation alone would kill the link
    // at the first refresh.
    const verdict = clientAuth.refreshSigned === true
      ? 'a signed refresh has been seen, so AS_AUTH_METHODS can be pinned to private_key_jwt'
      : clientAuth.method === 'assertion'
        ? 'only the authorization_code exchange has been seen signed — NOT yet enough to pin, because client authentication also runs for refresh_token'
        : 'the connector did not sign, so pinning private_key_jwt would break the link';
    clientAuthMarkdown = `
- Client authentication observed: ${count} token exchange(s) · last grant \`${clientAuth.grant || 'unknown'}\` · method \`${clientAuth.method || 'unknown'}\` · outcome \`${clientAuth.outcome || 'unknown'}\` · signed refresh seen \`${clientAuth.refreshSigned === true ? 'yes' : 'no'}\` · recorded ${at}
  - ${verdict}.`;
  }
  let mcpRateLimitMarkdown = '';
  if (observedMcpRateLimit) {
    const count = Number.isFinite(mcpRateLimit.count) ? Math.max(1, Math.min(999999, Math.floor(mcpRateLimit.count))) : 1;
    const at = Number.isFinite(mcpRateLimit.at) ? new Date(mcpRateLimit.at).toISOString() : 'not recorded';
    const retryAfterSeconds = Number.isSafeInteger(mcpRateLimit.retryAfterSeconds) && mcpRateLimit.retryAfterSeconds >= 1
      ? Math.min(3600, mcpRateLimit.retryAfterSeconds)
      : null;
    mcpRateLimitMarkdown = `
- Authenticated MCP rate limits: ${count} · latest Retry-After ${retryAfterSeconds === null ? 'not recorded' : `${retryAfterSeconds}s`} · recorded ${at}
  - Aggregate-only telemetry: no grant, session, token, caller address, request, or handoff content is retained. This receipt is retained separately from the ordinary bridge activity ring, so repeated waiting polls cannot erase it.`;
  }
  const chatCopyMarkdown = chatCopies.length === 0 ? '' : `
- Starter/Continue interactions retained: ${chatCopies.length} (newest last; closed metadata only)
${chatCopies.map(entry => {
    const at = Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : 'not recorded';
    const restart = entry.restartPath === 'ui-ack' || entry.restartPath === 'native'
      ? ` · restart acknowledgement \`${entry.restartPath}\`` : '';
    const ordinal = Number.isSafeInteger(entry.chatOrdinal) && entry.chatOrdinal >= 1 && entry.chatOrdinal <= 999
      ? ` · chat ${entry.chatOrdinal}` : '';
    return `  - ${at} · action \`${entry.action}\` · outcome \`${entry.outcome}\`${restart}${ordinal}`;
  }).join('\n')}`;
  return `
## Handoff Bridge Diagnostics
${bootstrapMarkdown}${queueMarkdown}${failedStartMarkdown}${oauthRejectionMarkdown}${sourceRejectionMarkdown}${clientAuthMarkdown}${mcpRateLimitMarkdown}${chatCopyMarkdown}
`;
}

export function generateMarkdown(payload, reportWindowId = null, options = {}) {
  const { description, nodes, edges, drawings, frontEndState, nodeInternals, nodeComponentStates, mediaState, imageState, lastSaveError, activeEditableText, sellHubResolveStates } = payload;

  // A filter code (e.g. LEAN) may have dropped whole sections before the payload
  // reached us. Track that so the summary can say "omitted by filter" rather than
  // mislabel an omitted section as empty ("Nodes: 0").
  const sectionOmitted = (name) =>
    Array.isArray(payload.filterStats?.omittedSections) &&
    payload.filterStats.omittedSections.includes(name);

  // Canvas-content guards — gate module-specific sections on whether this canvas
  // actually has nodes of that type, so sell-side sections don't bleed into a
  // job-only canvas and vice versa. Prefer the flags the renderer stamped into
  // filterStats (computed before a filter code could drop the `nodes` section);
  // fall back to scanning nodes when present (no-filter reports).
  const { hasJobNodes, hasSellNodes } = resolveNodePresence(payload);
  // FULL (or no code) must mean EVERYTHING — otherwise description-keyword-gated
  // sections silently vanish on a FULL report. "window not opening" (a captcha/
  // login window) doesn't match the auth keywords above, so without this the
  // Auth Window Diagnostics section was dropped even under FULL.
  const reportCode = String(payload.filterCode || '').trim().toUpperCase();
  const isFullReport = !reportCode || codeIncludesFull(reportCode);
  const reportCodes = new Set(reportCode.split(/[+\s,]+/).filter(Boolean));
  // Generated application prose carries direct identifiers and work history.
  // Only an explicit FULL or APPOUTPUT code consents to its export. The legacy
  // empty/default broad report intentionally remains metadata-only.
  const wantsApplicationOutput = codeIncludesApplicationOutput(reportCode);
  // AUTH implies PERSIST. "I logged in but it still says logged out" is an AUTH-
  // shaped question whose answer lives entirely in the persistence section: the
  // close-lifecycle table's Store-checkpointed / Executable / Profile columns and
  // the per-platform auth-cookie-on-disk line are what separate "the login never
  // completed" from "the login completed and never reached the profile". Gating
  // those behind a code the user has no reason to guess made an AUTH report look
  // complete while omitting the deciding evidence.
  const wantsPersistenceDiagnostics = isFullReport || reportCodes.has('PERSIST') || reportCodes.has('AUTH');
  const wantsAuthDiagnostics = wantsPersistenceDiagnostics
    || reportCodes.has('AUTH')
    || /login|log in|logged|sign.?in|auth|account|indeed|glassdoor|ziprecruiter/i.test(description || '');

  const systemInfo = {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    appVersion: app.getVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    packaged: !!app.isPackaged,
    generatedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  };


  // ── Diagnostic section: group node size fields ─────────────────────────────
  // Shows style.width / measured.width / width prop separately.
  // A mismatch here (e.g. measured growing while style stays constant) is
  // the signature of the ReactFlow ResizeObserver race condition.
  let nodeDiagMarkdown = '';
  // Wrapped: this section walks arbitrary/possibly-corrupted node `data` payloads
  // (the exact kind of state a bug report is filed about), so it must never take
  // down every other section if one node's shape throws (e.g. a non-numeric
  // position/size field hitting `.toFixed`).
  try { nodeDiagMarkdown = buildNodeDiagnosticsMarkdown(nodeInternals, nodeComponentStates, nodes, edges, options, sectionOmitted); }
  catch (err) { nodeDiagMarkdown = diagnosticRenderFailureMarkdown('Node Diagnostics', err); }

  // ── Media player state section ────────────────────────────────────────────
  let mediaMarkdown = '';
  try { mediaMarkdown = buildMediaPlayerStateMarkdown(mediaState); }
  catch (err) { mediaMarkdown = diagnosticRenderFailureMarkdown('Media Player State', err); }

  // ── Image element state section ───────────────────────────────────────────
  // Captures <img> load state at report time. `broken: true` (complete=true,
  // naturalWidth=0) means the protocol returned an error or an undisplayable
  // payload — the primary signature of HEIC / unsupported-format failures.
  let imageMarkdown = '';
  try { imageMarkdown = buildImageElementStateMarkdown(imageState); }
  catch (err) { imageMarkdown = diagnosticRenderFailureMarkdown('Image Element State', err); }

  // ── Active editable section ────────────────────────────────────────────────
  // Captures the divergence between the focused contenteditable's live DOM
  // text and the saved data.text on its node. A `divergent: true` here is the
  // signature of a "saved while editing — lost my edit" report.
  let activeEditableMarkdown = '';
  try { activeEditableMarkdown = buildActiveEditableMarkdown(activeEditableText); }
  catch (err) { activeEditableMarkdown = diagnosticRenderFailureMarkdown('Active Editable At Report Time', err); }

  // ── Last save error section ────────────────────────────────────────────────
  // Save errors used to be lost: the toast was shown, the user dismissed it,
  // and the bug report had no record of *why* the save failed. Surfacing this
  // up front means a "Save Failed" report is actionable instead of a guess.
  let lastSaveErrorMarkdown = '';
  try { lastSaveErrorMarkdown = buildLastSaveErrorMarkdown(lastSaveError); }
  catch (err) { lastSaveErrorMarkdown = diagnosticRenderFailureMarkdown('Last Save Error', err); }

  // ── Active IPC tasks ──────────────────────────────────────────────────────
  // Catches the "I clicked Cancel/X but the pipeline kept running" failure
  // mode. The renderer can mark a node visually 'done' instantly, but if the
  // backend AbortControllers weren't cancelled, the underlying tasks finish
  // and overwrite the user's reset. This snapshot makes that immediately
  // diagnosable in any report.
  let activeTasksMarkdown = '';
  try { activeTasksMarkdown = buildActiveTasksMarkdown(reportWindowId); }
  catch { /* never break the report on diagnostic failure */ }

  let handoffBridgeDiagnosticsMarkdown = '';
  if (isFullReport || reportCodes.has('BRIDGE') || reportCodes.has('BRIDGEWORKERS')) try { handoffBridgeDiagnosticsMarkdown = buildHandoffBridgeDiagnosticsMarkdown(); }
  catch { /* a diagnostic receipt must never block the report */ }

  // Same guard as every other section builder: a malformed row in the renderer
  // payload should cost this one section, not the whole report.
  let sellHubResolveMarkdown = '';
  try {
    sellHubResolveMarkdown = buildSellHubResolveRollup(sellHubResolveStates || []);
  } catch (err) { sellHubResolveMarkdown = diagnosticRenderFailureMarkdown('SellHub Source Resolve Queue', err); }

  // ── Build freshness ───────────────────────────────────────────────────────
  // Catches the "I edited a file but the running app still does the old thing"
  // failure mode. Vite hot-reloads the renderer, but Electron main-process
  // files (preload, IPC handlers, settings store) only reload on a full restart.
  // If any tracked source is newer than the process start, the running build is
  // stale — flag it loudly so the report doesn't waste time chasing a phantom.
  const { src: mainSrcMs, srcDirFound: mainSrcDirFound, bundle: mainBundleMs } = getNewestMainProcessMtimes();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const startedAt = new Date(PROCESS_START_MS).toISOString();
  // A packaged app ships only dist-electron/ inside app.asar — `electron/`
  // source genuinely isn't there, so mainSrcDirFound === false is EXPECTED
  // (not a read failure). Say so explicitly instead of a bare "(unknown)"
  // that reads like a failed lookup rather than "nothing to look at".
  const mainSrcStr = mainSrcMs
    ? new Date(mainSrcMs).toISOString()
    : (mainSrcDirFound ? '(electron/ present but no matching source files)' : '(not on disk — packaged build, electron/ source not shipped)');
  const mainBundleStr = mainBundleMs ? new Date(mainBundleMs).toISOString() : '(no dist-electron/ bundle found)';
  const mainSrcStale = !!(mainSrcMs && mainSrcMs > PROCESS_START_MS);
  const mainBundleAfterStart = !!(mainBundleMs && mainBundleMs > PROCESS_START_MS);
  let stalenessLine;
  if (mainSrcDirFound) {
    // Dev run: the electron/ source tree is actually on disk and was scanned,
    // so a verdict about SOURCE freshness is something this run can back up.
    stalenessLine = !mainSrcMs
      ? '⚠️ **Cannot determine build freshness** — electron/ was found but no source files matched inside it. If you have edited any Electron main-process files since starting the app, restart before treating this report as authoritative.'
      : mainSrcStale
        ? `⚠️ **STALE BUILD**: a tracked main-process source file was modified ${Math.round((mainSrcMs - PROCESS_START_MS) / 1000)}s after the process started. The running app is NOT executing the current source on disk — fully restart Electron (not just Vite) before treating this report as authoritative.`
        : '✅ Up to date — no tracked main-process source has been modified since the process started.';
  } else {
    // Packaged build: electron/ source is not shipped, so this run NEVER
    // looked at a single source file — only the baked-in dist-electron/
    // bundle exists to compare. State that plainly instead of asserting
    // anything about source freshness this run has no way to verify.
    stalenessLine = !mainBundleMs
      ? '⚠️ **Cannot determine build freshness** — packaged build, electron/ source not shipped, and no dist-electron/ bundle mtime could be read either.'
      : mainBundleAfterStart
        ? `⚠️ **BUNDLE NEWER THAN PROCESS START**: the packaged dist-electron/ bundle has an mtime ${Math.round((mainBundleMs - PROCESS_START_MS) / 1000)}s after the process started, which is unexpected for an installed build. (Packaged build — the electron/ dev source tree was not scanned, so a source edit could not have been detected either way; this is a bundle-vs-process-start comparison only.)`
        : 'ℹ️ Packaged build — the electron/ dev source tree was not scanned (not shipped inside app.asar), so a local source edit could not have been detected. The only known fact: the running dist-electron/ bundle predates process start.';
  }

  // Renderer freshness — the main-process check above never covers src/, but a
  // stale renderer (edited src/ that wasn't re-bundled into dist/) silently runs
  // old UI logic. With a Vite dev server, HMR keeps it current; with the built
  // bundle (loadFile dist/index.html) only a `vite build` updates it.
  const onDevServer = !!process.env.VITE_DEV_SERVER_URL;
  const { src: rSrcMs, bundle: rBundleMs } = getNewestRendererMtimes();
  // A packaged app ships only the built bundle inside app.asar — `src/` isn't on
  // disk, so a null rSrcMs there is EXPECTED (not a read failure). Label it as
  // such only when we DID find the bundle (otherwise we truly know nothing).
  const rSrcStr = rSrcMs
    ? new Date(rSrcMs).toISOString()
    : (rBundleMs ? '(not on disk — packaged build, src/ not shipped)' : '(unknown)');
  const rBundleStr = rBundleMs ? new Date(rBundleMs).toISOString() : '(no built bundle found under dist/)';
  const rendererStale = !!(rSrcMs && rBundleMs && rSrcMs > rBundleMs);
  const bundleAfterStart = !!(rBundleMs && rBundleMs > PROCESS_START_MS);
  let rendererLine;
  if (onDevServer) {
    rendererLine = 'ℹ️ Renderer served by the Vite dev server (HMR) — `src/` edits apply live; the dist/ mtime check does not apply.';
  } else if (rendererStale) {
    rendererLine = `⚠️ **STALE RENDERER**: a \`src/\` file was modified ${Math.round((rSrcMs - rBundleMs) / 1000)}s after the renderer bundle was built. The app loads \`dist/index.html\`, so the running UI does NOT include the latest src/ — run \`vite build\` and reload before trusting renderer behavior (e.g. the AI-scoring / test-mode gate).`;
  } else if (bundleAfterStart) {
    rendererLine = `⚠️ **RENDERER REBUILT MID-SESSION**: dist/ was rebuilt ${Math.round((rBundleMs - PROCESS_START_MS) / 1000)}s after launch but the window may still hold the pre-rebuild bundle — reload the window (or restart) to pick it up.`;
  } else if (rBundleMs) {
    // Bundle present, not newer than src/, and not rebuilt after launch → the
    // window loaded the current on-disk build. src/ being absent (packaged) or
    // older (dev, already rebuilt) both land here — both are fresh.
    rendererLine = rSrcMs
      ? '✅ Renderer bundle (dist/) is at least as new as src/ — running UI matches source.'
      : '✅ Renderer bundle predates process start and no newer src/ is on disk (packaged build) — running the current bundle.';
  } else {
    rendererLine = '⚠️ Cannot determine renderer freshness — no dist/ bundle mtime found.';
  }

  const buildFreshnessMarkdown = `
## Build Freshness
- Main process started: \`${startedAt}\` (uptime ${Math.round(uptimeMs / 1000)}s)
- Newest main-process source mtime (electron/): \`${mainSrcStr}\`
- Main-process bundle built (dist-electron/ — what a packaged app actually runs): \`${mainBundleStr}\`
- ${stalenessLine}
- Newest renderer source mtime (src/): \`${rSrcStr}\`
- Renderer bundle built (dist/ — what loadFile actually serves): \`${rBundleStr}\`
- ${rendererLine}
`;

  // ── Persisted workspace snapshot ──────────────────────────────────────────
  // Reads the on-disk auto-loaded workspace and flags transient hub state that
  // should have been stripped before save. The decisive signal for any "stale
  // state survives restart" report. Never break the report on diagnostic
  // failure — the helper already returns markdown for every error path.
  let persistedWorkspaceMarkdown = '';
  try { persistedWorkspaceMarkdown = buildPersistedWorkspaceSnapshot(frontEndState); }
  catch { /* never break the report on diagnostic failure */ }

  let missingPreviewRelinkMarkdown = '';
  try { missingPreviewRelinkMarkdown = buildMissingPreviewRelinkMarkdown(); }
  catch { /* never break the report on diagnostic failure */ }

  // ── Cross-restart session durability ──────────────────────────────────────
  // Values are intentionally absent: file checkpoints, cache provenance, and
  // cookie name/persistence metadata are sufficient to distinguish "detected in
  // RAM but never flushed" from "restored and later rejected by the server."
  let sessionPersistenceMarkdown = '';
  if (wantsPersistenceDiagnostics) try { sessionPersistenceMarkdown = buildSessionPersistenceMarkdown(); }
  catch (error) {
    sessionPersistenceMarkdown = diagnosticRenderFailureMarkdown('Session Persistence Diagnostics', error);
  }

  // ── Marketplace session snapshot ──────────────────────────────────────────
  // In-memory session cache (populated by verifyAllPlatforms on startup and
  // by writeStatusCache after each login flow). Truth source for the "Log in"
  // vs "Logged in · refresh" pill in Settings → Marketplace Monitors.
  let marketplaceSessionsMarkdown = '';
  if (hasSellNodes) try { marketplaceSessionsMarkdown = buildMarketplaceSessionsMarkdown(sectionOmitted); }
  catch { /* never break the report on diagnostic failure */ }

  // ── Job platform session snapshot ─────────────────────────────────────────
  // Same cache as sell-monitor; shown separately because job platforms have
  // different UI context (Settings → Job Boards). A verify URL returning 404
  // means the platform changed its URL structure — that's only visible here,
  // not in the sell-monitor section above.
  // Only include when this canvas actually has job nodes — don't bleed job
  // login state into a marketplace-only report.
  let jobSessionsMarkdown = '';
  if (hasJobNodes || wantsAuthDiagnostics || isFullReport) try { jobSessionsMarkdown = buildJobSessionsMarkdown(sectionOmitted); }
  catch { /* never break the report on diagnostic failure */ }

  // ── Login verification timing ─────────────────────────────────────────────
  // Answers "why is login verification slow?" directly, with explicit per-platform
  // verify durations + wall-clock total captured by verifyAllPlatforms. Before
  // this section the only timing signal was subtracting consecutive "Verifying X"
  // / "Startup verify X" main-process log timestamps by hand — and the concurrent
  // verify pool now interleaves those lines, so that method no longer works. This
  // is the first-class replacement: included under FULL or any auth/automation report.
  let verifyTimingMarkdown = '';
  if (isFullReport || wantsAuthDiagnostics || hasSellNodes || hasJobNodes) try {
    verifyTimingMarkdown = buildLoginVerificationTimingMarkdown(getVerifyTimingSummary?.());
  } catch { /* never break the report on diagnostic failure */ }

  // ── Active auth/login window snapshot ─────────────────────────────────────
  // Login bugs can happen with zero canvas nodes. This captures the visible
  // auth browser mode and current URL/title when the report is taken, which is
  // the decisive signal for Google's "browser or app may not be secure" block.
  let authWindowMarkdown = '';
  // Captcha-resolve windows are a marketplace concern AND a job concern, and a
  // user may describe the failure without auth vocabulary ("window not opening").
  // Include whenever there are automation nodes, or always under FULL.
  if (wantsAuthDiagnostics || isFullReport || hasSellNodes || hasJobNodes) try { authWindowMarkdown = buildAuthWindowMarkdown(); }
  catch (err) { authWindowMarkdown = diagnosticRenderFailureMarkdown('Auth Window Diagnostics', err); }

  // ── Recent main-process logs ──────────────────────────────────────────────
  // Up to 200 main-process log lines, captured by the in-memory ring buffer
  // in logger.js. Critical for diagnosing "the IPC silently failed" reports:
  // the [Accounts] / [StealthBrowser] / etc. error lines that normally only
  // hit stdout (which users never see) are surfaced here. Skip lines older
  // than this process start so we don't drag in stale logs from a previous
  // run that happened to share the ring buffer state.
  // AIHANDOFF and BRIDGE are intentionally focused lenses. Their renderer Event History is
  // already filtered by the code vocabulary; apply the equivalent predicate to
  // the otherwise-global main-process ring as well. FULL remains byte-for-byte
  // global even when combined with either code.
  const mainProcessLogFilter = !isFullReport && (reportCodes.has('AIHANDOFF') || reportCodes.has('BRIDGE') || reportCodes.has('BRIDGEWORKERS'))
    ? entry => {
      const message = String(entry?.message || '');
      return (reportCodes.has('AIHANDOFF') && AIHANDOFF_MAIN_PROCESS_LOG_PATTERN.test(message))
        || ((reportCodes.has('BRIDGE') || reportCodes.has('BRIDGEWORKERS')) && BRIDGE_MAIN_PROCESS_LOG_PATTERN.test(message));
    }
    : null;
  let mainProcessLogLines = [];
  try { mainProcessLogLines = buildRecentMainProcessLogLines({ filter: mainProcessLogFilter }); }
  catch { /* never break the report on diagnostic failure */ }
  const mainProcessLogsMarkdown = buildMainProcessLogsMarkdown(mainProcessLogLines);

  // ── AI configuration snapshot ─────────────────────────────────────────────
  // The local non-api-ai registry owns every task; its normal dock route and
  // the optional MCP bridge route are both described here. It is rendered unconditionally on every
  // report — unlike almost every other section here, it was never guarded, so
  // a throw anywhere in that chain took down the entire report instead of
  // just this section.
  let aiConfigMarkdown = '';
  try { aiConfigMarkdown = buildAIConfigurationMarkdown(); }
  catch (err) { aiConfigMarkdown = diagnosticRenderFailureMarkdown('AI Configuration', err); }

  let jobsConfigMarkdown = '';
  if (hasJobNodes) try {
    const jobsConfig = buildJobsConfigSnapshot();
    const tm = jobsConfig.testMode;
    const testModeLines = tm
      ? `\n### Job Search Test Scope\n- Enabled: ${tm.enabled ? '✅' : '❌'}\n- Scoped source: ${tm.sourceId ? `\`${tm.sourceId}\`` : '*(all sources)*'}\n- AI scoring: ${tm.skipAI ? 'skipped' : 'enabled'}\n- Collection depth: configured on each Job Search card and recorded with that run (not hidden test-mode settings).`
      : '';
    jobsConfigMarkdown = `
## Job Search API Configuration
- USAJobs API key set: ${jobsConfig.hasUsajobsKey ? '✅' : '❌'}
- USAJobs Email set: ${jobsConfig.hasUsajobsEmail ? '✅' : '❌'}
- Dice API key: ${jobsConfig.hasCapturedDiceKey ? 'captured from dice.com ✅' : 'using the built-in bootstrap default'}${testModeLines}
`;
  } catch (err) { jobsConfigMarkdown = diagnosticRenderFailureMarkdown('Job Search API Configuration', err); }

  // The node ids in THIS report's canvas — lets the pipeline snapshots flag a
  // funnel whose originating node isn't here (the main-process telemetry is
  // shared across all open windows/canvases, so it may be another canvas's run).
  // Recovery manifests identify their originating hub. Include nested canvases
  // too, so a valid hub inside a group is not falsely reported as deleted.
  const currentNodeIds = new Set();
  for (const nodeId of Array.isArray(payload?.filterStats?.currentNodeIds)
    ? payload.filterStats.currentNodeIds
    : []) {
    if (typeof nodeId === 'string' && nodeId) currentNodeIds.add(nodeId);
  }
  const collectCurrentNodeIds = (items) => {
    for (const node of Array.isArray(items) ? items : []) {
      if (node?.id) currentNodeIds.add(node.id);
      collectCurrentNodeIds(node?.data?.canvasData?.nodes);
    }
  };
  collectCurrentNodeIds(nodes);
  // Snapshot discovery is more specific than presence correlation: only a
  // Job Search hub can own an analysis bundle. Prefer the deep renderer index
  // (which survives filtered reports), then recover it from unfiltered nodes.
  const currentJobHubIds = new Set();
  for (const nodeId of Array.isArray(payload?.filterStats?.currentJobHubIds)
    ? payload.filterStats.currentJobHubIds
    : []) {
    if (typeof nodeId === 'string' && nodeId) currentJobHubIds.add(nodeId);
  }
  const collectCurrentJobHubIds = (items) => {
    for (const node of Array.isArray(items) ? items : []) {
      if (node?.type === 'jobhub' && typeof node.id === 'string' && node.id) currentJobHubIds.add(node.id);
      collectCurrentJobHubIds(node?.data?.canvasData?.nodes);
    }
  };
  collectCurrentJobHubIds(nodes);
  // Older renderer builds did not send the typed index. Retain their recovery
  // visibility when the filter says this is a job canvas; current builds always
  // supply `currentJobHubIds`, which is the ownership-safe path above.
  if (currentJobHubIds.size === 0
    && !Array.isArray(payload?.filterStats?.currentJobHubIds)
    && payload?.filterStats?.hasJobNodes) {
    for (const nodeId of currentNodeIds) currentJobHubIds.add(nodeId);
  }
  // Local AI status is persisted on job cards rather than the main-process
  // telemetry singleton. Include it in HANDOFF/FULL so a validation rejection
  // after a Local AI rewrite is not mistaken for a missed file poll.
  // Prefer the renderer's dedicated deep collection (payload.localApplications,
  // gathered via enumerateAllNodes): it covers cards in collapsed groups and
  // parent navigation levels — exactly the cards the fallback manager drives —
  // and survives filter codes that exclude the `nodes` section (HANDOFF does).
  // The top-level-nodes scan remains as a fallback for older payloads.
  const localApplications = Array.isArray(payload?.localApplications)
    ? payload.localApplications
    : (nodes || []).flatMap((node) => {
      const localApplication = node?.type === 'jobcard' ? node?.data?.localApplication : null;
      return localApplication?.id ? [{
        nodeId: node.id,
        title: node?.data?.title || '',
        company: node?.data?.company || '',
        localApplication,
      }] : [];
    });

  const canvasFilePath = frontEndState?.currentFile || frontEndState?.settings?.lastOpenedWorkspace || null;
  // XJOBAUDIT (bugReportCodes.js) is the only code that can shrink the bulky
  // per-job/per-location audit prose inside this section (taxonomy placement,
  // scoring evidence, all-source relevance, Glassdoor location cache) — FULL
  // alone cannot, because those blocks carry no other section-exclusion name.
  // 'jobAuditDetail' is not a top-level payload key (like 'sessionTraces'),
  // it exists purely as this marker.
  const omitJobAudit = sectionOmitted('jobAuditDetail');
  let jobsPipelineMarkdown = '';
  try { jobsPipelineMarkdown = buildJobsPipelineSnapshot(currentNodeIds, reportWindowId, canvasFilePath, localApplications, omitJobAudit, currentJobHubIds); }
  catch { /* never break the report on diagnostic failure */ }

  // Its own top-level section, deliberately ordered before the Job Search
  // Pipeline block so the manual-handoff issue order is easy to find.
  // Gated like every other job section rather than always-on. JOBS is included
  // because the receipt used to ride inside the Job Search Pipeline section,
  // and a JOBS report must not silently lose it in the move. TAXONOMY also
  // needs the receipt because its plan/classify steps use this manual handoff.
  let nonApiHandoffMarkdown = '';
  if (isFullReport || reportCodes.has('AIHANDOFF') || reportCodes.has('JOBHANDOFF') || reportCodes.has('JOBS') || reportCodes.has('TAXONOMY')) {
    try { nonApiHandoffMarkdown = buildNonApiAiHandoffLifecycleMarkdown(currentNodeIds, reportWindowId, nodes); }
    catch { /* never break the report on diagnostic failure */ }
  }

  // FULL already carried this section; a live deadlock still went unread from
  // it because the receipt collapsed two different stale-handoff gates into
  // one reason and reported no envelope-echo detail. That is a field-
  // granularity gap inside buildPasteHandoffDiagnosticsMarkdown, not a
  // section-availability one, so no new report code belongs here — only the
  // receipt itself needed more to say.
  let pasteHandoffMarkdown = '';
  if (isFullReport || reportCodes.has('APPLICATION') || reportCodes.has('HANDOFF')) {
    try { pasteHandoffMarkdown = buildPasteHandoffDiagnosticsMarkdown(); }
    catch { /* never break the report on diagnostic failure */ }
  }

  // The durable counterpart to the section immediately above: that section is
  // a process-local ring, wiped on restart, so a report filed after a restart
  // mid-loop showed zero receipts while each affected job's own
  // "Paste Rejections.json" sidecar still had the whole history. Same gate as
  // pasteHandoffMarkdown (its durable data answers the same APPLICATION/HANDOFF
  // question), and the same localApplications/canvasFilePath this function
  // already resolved above for "Local AI Job State" — see
  // buildPasteRejectionTraceMarkdown's own header for why no second job-
  // discovery path was built for this.
  let pasteRejectionTraceMarkdown = '';
  if (isFullReport || reportCodes.has('APPLICATION') || reportCodes.has('HANDOFF')) {
    try { pasteRejectionTraceMarkdown = buildPasteRejectionTraceMarkdown(canvasFilePath, localApplications); }
    catch { /* never break the report on diagnostic failure */ }
  }

  // FULL is the broad report selection, and APPOUTPUT is the narrow output
  // selector. Both render the already-retained, typed Local-AI projection;
  // neither accepts or dereferences a renderer path to reconstruct a document.
  let applicationOutputMarkdown = '';
  if (wantsApplicationOutput) {
    try { applicationOutputMarkdown = buildApplicationOutputReportSnapshot(currentNodeIds, reportWindowId); }
    catch { applicationOutputMarkdown = '\n## Application Output Evidence (APPOUTPUT)\n- Unavailable/removed: application output could not be safely projected. It was not audited.\n'; }
  }

  let jobLinkMarkdown = '';
  if (isFullReport || reportCodes.has('JOBLINK')) {
    try { jobLinkMarkdown = buildJobLinkSnapshot(nodes); }
    catch { jobLinkMarkdown = diagnosticRenderFailureMarkdown('Job Listing Link Diagnostics', new Error('could not inspect saved job links')); }
  }

  // In-memory job telemetry is intentionally process-local, so it is empty
  // after the restart where crash/quit recovery is being diagnosed. FULL and
  // RECOVERY therefore read only the compact sidecar/snapshot metadata here.
  // This remains useful even when the live pipeline section self-gates to ''.
  let jobRecoveryOfferMarkdown = '';
  let jobRecoveryMarkdown = '';
  if (isFullReport || reportCodes.has('RECOVERY') || reportCodes.has('JOBRESOLVE') || reportCodes.has('JOBRECOVERY')) {
    try { jobRecoveryOfferMarkdown = buildJobRecoveryOfferSnapshot(payload.jobRecoveryOfferStates); }
    catch { jobRecoveryOfferMarkdown = diagnosticRenderFailureMarkdown('Job Recovery Offer Diagnostics', new Error('could not inspect renderer recovery admission state')); }
    try { jobRecoveryMarkdown = buildJobRecoverySnapshot(canvasFilePath, currentNodeIds, currentJobHubIds, reportWindowId); }
    catch { jobRecoveryMarkdown = diagnosticRenderFailureMarkdown('Job Recovery Diagnostics', new Error('could not inspect recovery sidecars')); }
  }

  // Keep the completion verdict ahead of the long Job Search Pipeline section.
  // This compact reconciliation carries the summary counts and status facts;
  // detailed evidence remains in the pipeline immediately below.
  let jobCompletionAssessmentMarkdown = '';
  let jobBoardDiagnosticsMarkdown = '';
  if (hasJobNodes || isFullReport || reportCodes.has('JOBS') || reportCodes.has('RECOVERY')) {
    const rawJobBoardStates = Array.isArray(payload.filterStats?.jobBoardStates)
      ? payload.filterStats.jobBoardStates
      : (nodes || []).filter(node => node?.type === 'jobboard').map(node => {
          const rawClear = node.data?.clearProvenance;
          const clearProvenance = rawClear && typeof rawClear === 'object' && !Array.isArray(rawClear)
            ? {
                clearedAt: typeof rawClear.clearedAt === 'number'
                  && Number.isSafeInteger(rawClear.clearedAt)
                  && rawClear.clearedAt > 0
                  && Number.isFinite(new Date(rawClear.clearedAt).getTime())
                  ? rawClear.clearedAt
                  : null,
                priorCombineSignature: typeof rawClear.priorCombineSignature === 'string'
                  ? rawClear.priorCombineSignature.slice(0, 4_000)
                  : null,
                priorResultCount: typeof rawClear.priorResultCount === 'number' && Number.isFinite(rawClear.priorResultCount) && rawClear.priorResultCount >= 0
                  ? Math.floor(rawClear.priorResultCount)
                  : null,
                priorSourceRuns: [...new Map((Array.isArray(rawClear.priorSourceRuns) ? rawClear.priorSourceRuns : [])
                  .map((entry) => {
                    const sourceHubId = typeof entry?.sourceHubId === 'string' ? entry.sourceHubId.trim() : '';
                    const runId = typeof entry?.runId === 'string' ? entry.runId.trim() : '';
                    return /^[A-Za-z0-9_.:-]{1,180}$/.test(sourceHubId) && /^[A-Za-z0-9_.:-]{1,180}$/.test(runId)
                      ? [`${sourceHubId}\u0000${runId}`, { sourceHubId, runId }]
                      : null;
                  })
                  .filter(Boolean)).values()].slice(0, 25),
              }
            : null;
          return {
            id: node.id,
            hubState: node.data?.hubState,
            resultCount: node.data?.resultCount,
            renderedCardCount: (nodes || []).filter(candidate => candidate?.type === 'jobcard' && candidate?.data?.hubId === node.id).length,
            stale: node.data?.stale,
            staleReason: node.data?.staleReason,
            combineSignature: node.data?.combineSignature,
            mergeUnique: node.data?.mergeStats?.unique,
            clearProvenance,
          };
        });
    // filterStats can be assembled before edge state is refreshed. The live
    // canvas graph is authoritative for direct Board↔Job Search admission, so
    // retain any supplied provenance but always add current connected sources.
    // Root-level ids can be duplicated in hand-edited/imported canvas data.
    // Keep every owner so a root edge is only treated as a completion fact when
    // both endpoints resolve uniquely; Map(id -> last node) would otherwise
    // create a false Board↔Search correlation.
    const nodesById = new Map();
    for (const node of (nodes || [])) {
      if (!node?.id) continue;
      const peers = nodesById.get(node.id) || [];
      peers.push(node);
      nodesById.set(node.id, peers);
    }
    const connectedSourcesByBoard = new Map();
    // Direct Board↔Search connectivity is a cheap exact relation. Scan the
    // complete graph so a valid edge after unrelated canvas edges is never
    // silently omitted from completion correlation.
    for (const edge of (edges || [])) {
      const sourceEntries = nodesById.get(edge?.source);
      const targetEntries = nodesById.get(edge?.target);
      if (sourceEntries?.length !== 1 || targetEntries?.length !== 1) continue;
      const source = sourceEntries[0];
      const target = targetEntries[0];
      const board = source?.type === 'jobboard' ? source : target?.type === 'jobboard' ? target : null;
      const peer = board === source ? target : board === target ? source : null;
      if (!board?.id || !peer?.id || (peer.type !== 'jobhub' && peer.type !== 'jobsearch')) continue;
      if (!connectedSourcesByBoard.has(board.id)) connectedSourcesByBoard.set(board.id, []);
      connectedSourcesByBoard.get(board.id).push(peer.id);
    }
    // A renderer may omit an untouched/empty Board from its compact stats.
    // Keep that Board in the reconciliation too: a live edge to an empty Board
    // is meaningful evidence of an admitted-but-not-yet-consumed source.
    const suppliedBoardIds = new Set(rawJobBoardStates.map(board => board?.id).filter(Boolean));
    const liveOnlyBoards = (nodes || []).filter(node => node?.type === 'jobboard' && node?.id && !suppliedBoardIds.has(node.id))
      .map((node) => ({
        id: node.id,
        hubState: node.data?.hubState,
        resultCount: node.data?.resultCount,
        renderedCardCount: (nodes || []).filter(candidate => candidate?.type === 'jobcard' && candidate?.data?.hubId === node.id).length,
        stale: node.data?.stale,
        staleReason: node.data?.staleReason,
        combineSignature: node.data?.combineSignature,
        mergeUnique: node.data?.mergeStats?.unique,
        clearProvenance: node.data?.clearProvenance,
      }));
    const jobBoardStates = [...rawJobBoardStates, ...liveOnlyBoards].map((board) => {
      const id = board?.id;
      const supplied = Array.isArray(board?.connectedSourceHubIds) ? board.connectedSourceHubIds : [];
      // Current renderer snapshots mark each Board's canvas-local scope and
      // already resolved its local edges. Rejoining root-level live edges by a
      // bare id would corrupt a nested/sibling Board that reused an imported
      // id. Only legacy unscoped snapshots need this root-canvas supplement.
      const live = typeof board?.diagnosticScope === 'string'
        ? []
        : (nodesById.get(id)?.length === 1 ? (connectedSourcesByBoard.get(id) || []) : []);
      return { ...board, connectedSourceHubIds: [...new Set([...supplied, ...live])].slice(0, 25) };
    });
    try {
      jobCompletionAssessmentMarkdown = buildJobCompletionAssessment(
        canvasFilePath,
        currentNodeIds,
        jobBoardStates,
        Math.max(
          jobBoardStates.length,
          Number.isFinite(Number(payload.filterStats?.jobBoardStateCount))
            ? Math.max(0, Math.floor(Number(payload.filterStats.jobBoardStateCount)))
            : 0,
        ),
        currentJobHubIds,
        reportWindowId,
        payload.filterStats?.jobBoardStateOmissions,
      );
    }
    catch { jobCompletionAssessmentMarkdown = diagnosticRenderFailureMarkdown('Job Completion Assessment', new Error('could not reconcile job completion facts')); }
  }
  if (isFullReport || reportCodes.has('JOBBOARD')) {
    try { jobBoardDiagnosticsMarkdown = buildJobBoardDiagnostics(nodes, edges, nodeComponentStates); }
    catch { jobBoardDiagnosticsMarkdown = diagnosticRenderFailureMarkdown('Job Board Transaction & Display Diagnostics', new Error('could not inspect board transaction state')); }
  }

  let marketplacePipelineMarkdown = '';
  try { marketplacePipelineMarkdown = buildMarketplacePipelineSnapshot(currentNodeIds, reportWindowId); }
  catch { /* never break the report on diagnostic failure */ }

  // The Marketplace Status MODULE's own hub-scan results (data.platformStatus).
  // Self-gates to '' when no marketplacestatus node has results, so call it
  // unconditionally (a module can exist on a canvas with no sell-hub nodes).
  let marketplaceModuleRollupMarkdown = '';
  try { marketplaceModuleRollupMarkdown = buildMarketplaceModuleRollup(nodes); }
  catch { /* never break the report on diagnostic failure */ }

  // This canvas is known to have sell-hub nodes (filterStats flag), but the codes
  // that drop the `nodes` section take the plan state with it. Say so — an empty
  // section here would otherwise read as "no price-drop plans exist".
  let sellHubPriceDropRollupMarkdown = '';
  if (hasSellNodes) {
    if (sectionOmitted('nodes')) sellHubPriceDropRollupMarkdown = '\n## SellHub Price-Drop Plans\n*(omitted by filter code — needs the node payload)*\n';
    else try { sellHubPriceDropRollupMarkdown = buildSellHubPriceDropRollup(nodes); }
      catch { /* never break the report on diagnostic failure */ }
  }

  let scraperAdaptationMarkdown = '';
  if (hasJobNodes || hasSellNodes) try { scraperAdaptationMarkdown = buildScraperAdaptationSnapshot(); }
    catch { /* never break the report on diagnostic failure */ }

  let issueReporterDraftMarkdown = '';
  if (payload.issueReporterDraft) {
    const d = payload.issueReporterDraft;
    const draftStateLine = (status, present, length) => {
      if (status === 'unavailable') return 'Unavailable';
      if (!present) return 'None';
      const boundedLength = Number.isSafeInteger(length) && length >= 0
        ? Math.min(length, 1_000_000)
        : 0;
      return `Present (length: ${boundedLength})`;
    };
    const lsLine = draftStateLine(d.localStorageStatus, d.localStoragePresent, d.localStorageLength);
    const ssLine = draftStateLine(d.sessionStorageStatus, d.sessionStoragePresent, d.sessionStorageLength);

    issueReporterDraftMarkdown = `
## Issue Reporter Draft State
- LocalStorage legacy draft: \`${lsLine}\`
- SessionStorage draft (current session): \`${ssLine}\`
`;
  }

  // ── Viewport section ───────────────────────────────────────────────────────
  const vp = frontEndState?.viewport;
  const viewportLine = vp ? `- Viewport: zoom=${vp.zoom} x=${vp.x} y=${vp.y}` : '';
  // One block so a report without a window size keeps the exact spacing it
  // always had (an empty extra template line would add a blank row).
  const viewportBlock = [viewportLine, buildWindowSizeLine(frontEndState)].filter(Boolean).join('\n');
  const filterSummaryMarkdown = buildFilterSummaryMarkdown(payload);

  let pointerProbeMarkdown = '';
  try { pointerProbeMarkdown = buildPointerProbeMarkdown(frontEndState); }
  catch { pointerProbeMarkdown = ''; }


  let baseMarkdown = `At the end of your debug, assess whether a new bug-report filter code is needed. This occurs when even if the user used the "FULL" filter code, it would not have been enough reporting data to debug this issue smoothly. Every new diagnostic filter code must be included by FULL; a narrow code may still select just its relevant section.

# Bug Report

## Issue Description
${description}
${filterSummaryMarkdown}

## Application State Summary
- Nodes: ${sectionOmitted('nodes') ? '*(omitted by filter code)*' : (nodes ? nodes.length : 0)}
- Edges: ${sectionOmitted('edges') ? '*(omitted by filter code)*' : (edges ? edges.length : 0)}
- Drawings: ${sectionOmitted('drawings') ? '*(omitted by filter code)*' : (drawings ? drawings.length : 0)}
- Active Tool: ${frontEndState?.activeTool || 'None'}
- OS: ${systemInfo.platform} ${systemInfo.arch}
${viewportBlock}

## Runtime Identity
- App: ${systemInfo.appVersion} · ${systemInfo.packaged ? 'packaged' : 'development'}
- Runtime: Electron ${systemInfo.electronVersion || '?'} · Chromium ${systemInfo.chromiumVersion || '?'} · Node ${systemInfo.nodeVersion || '?'}
- OS release: ${systemInfo.osRelease}
- Report generated: ${systemInfo.generatedAt} · timezone ${systemInfo.timezone} · UTC offset ${systemInfo.utcOffsetMinutes >= 0 ? '+' : ''}${systemInfo.utcOffsetMinutes} min
${buildFreshnessMarkdown}${pointerProbeMarkdown}${persistedWorkspaceMarkdown}${missingPreviewRelinkMarkdown}${activeTasksMarkdown}${handoffBridgeDiagnosticsMarkdown}${sellHubResolveMarkdown}${aiConfigMarkdown}${jobsConfigMarkdown}${jobCompletionAssessmentMarkdown}${jobBoardDiagnosticsMarkdown}${nonApiHandoffMarkdown}${pasteHandoffMarkdown}${pasteRejectionTraceMarkdown}${applicationOutputMarkdown}${jobLinkMarkdown}${jobRecoveryOfferMarkdown}${jobRecoveryMarkdown}${issueReporterDraftMarkdown}${jobsPipelineMarkdown}${marketplacePipelineMarkdown}${marketplaceModuleRollupMarkdown}${sellHubPriceDropRollupMarkdown}${sessionPersistenceMarkdown}${marketplaceSessionsMarkdown}${jobSessionsMarkdown}${verifyTimingMarkdown}${authWindowMarkdown}${scraperAdaptationMarkdown}${activeEditableMarkdown}${lastSaveErrorMarkdown}${nodeDiagMarkdown}${mediaMarkdown}${imageMarkdown}
`;

  const events = payload.eventLogs || [];
  // Renderer filtering happens before this point while EventLogger's ring is
  // chronological, preserving filter context and "last N" semantics. At the
  // export boundary, legacy/mocked unmarked rows receive a labelled timestamp
  // and the shared block stamps any legacy/mocked unmarked row then renders
  // the same chronological array newest-first.
  // EventLogger lives in the renderer and can contain legacy in-memory rows
  // created before a producer learned to avoid raw query/role values. Sanitize
  // only as the report crosses its export boundary, so its on-screen/debug ring
  // stays faithful while every report delivery path shares one safe policy.
  const chronologicalEventLines = Array.isArray(events)
    ? events.map(redactReportEventHistoryLine)
    : [];
  const eventsMarkdown = buildReverseChronologicalLogBlock(chronologicalEventLines, '*(No events recorded)*', { basis: 'local' });

  const fullMarkdown = baseMarkdown + mainProcessLogsMarkdown + `\n${EVENT_HISTORY_HEADING}` + eventsMarkdown;
  // Logs and the Event History heading live outside baseMarkdown so the
  // clipboard path (enforceClipboardMarkdownCap) can trim them independently of
  // the curated static sections above.
  if (options?.maxChars) {
    return enforceClipboardMarkdownCap(baseMarkdown, chronologicalEventLines, mainProcessLogLines, options.maxChars);
  }
  return { markdown: fullMarkdown, truncated: false, trimmedEventCount: 0, trimmedLogCount: 0, hardTruncated: false };
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
export function registerBugReportHandlers() {

  // Save report to a file chosen by the user via a native save dialog.
  // Deliberately uncapped: this is the promised complete artifact, so no
  // maxChars is passed here even though the clipboard path below shares this
  // same generateMarkdown function.
  handleSafe('export-bug-report', async (event, payload) => {
    if (isBackgroundE2E()) return { success: false, canceled: true };
    const descriptionValidation = validateIssueReportDescription(payload?.description);
    if (!descriptionValidation.ok) throw new TypeError(descriptionValidation.error);
    const safePayload = { ...payload, description: descriptionValidation.value };
    const { markdown: markdownContent } = generateMarkdown(safePayload, event.sender?.id ?? null);

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save Bug Report',
      defaultPath: path.join(app.getPath('desktop'), `bug_report_${Date.now()}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (canceled || !filePath) return { success: false, canceled: true };

    await fs.promises.writeFile(filePath, markdownContent, 'utf8');
    return { filePath };
  });

  // "Copy to clipboard": generate a FULL uncapped report with the same
  // rendering policy as "Save to file" above, then write it to an app-managed
  // file instead of returning it inline. The two actions occur at different
  // times, so timestamps and live state need not be byte-identical. A canvas-scale
  // report pasted whole into a clipboard/chat consumer either gets silently
  // truncated downstream or burns most of a context window in one message;
  // a short path pointer lets an AI read the file from disk in segments
  // instead. See electron/ipc/bugReport/reportFile.js for the file lifecycle
  // (retained across app starts, then pruned by age and count retention).
  handleSafe('generate-bug-report-markdown', async (event, payload) => {
    const descriptionValidation = validateIssueReportDescription(payload?.description);
    if (!descriptionValidation.ok) throw new TypeError(descriptionValidation.error);
    const safePayload = { ...payload, description: descriptionValidation.value };
    const full = generateMarkdown(safePayload, event.sender?.id ?? null); // UNCAPPED — the file is the artifact

    // Mirror filterSummary.js's own read of these two payload fields (see
    // buildFilterSummaryMarkdown) instead of re-deriving them from inside
    // generateMarkdown, which doesn't expose its internal event-line count.
    const filterCode = String(safePayload.filterCode || '').trim();
    const statsEventsShown = Number(safePayload.filterStats?.eventsShown);
    const eventLines = Number.isFinite(statsEventsShown) ? statsEventsShown : null;
    const generatedAt = new Date().toISOString();
    const description = safePayload.description;

    try {
      const saved = await writeSavedBugReport(full.markdown, { reportWindowId: event.sender?.id ?? null });
      return {
        delivery: 'file-pointer',
        clipboardText: buildClipboardPointer({
          filePath: saved.filePath,
          chars: saved.chars,
          bytes: saved.bytes,
          lines: saved.lines,
          eventLines,
          filterCode,
          generatedAt,
          description,
        }),
        savedPath: saved.filePath,
        chars: saved.chars,
        bytes: saved.bytes,
        lines: saved.lines,
        eventLines,
        filterCode: filterCode || null,
        generatedAt,
      };
    } catch (error) {
      // Never leave the user with nothing to paste: the disk write failed
      // (full disk, permissions, unwritable userData, ...), so fall back to
      // the old capped-inline clipboard content rather than surfacing a bare
      // error with no report at all.
      const capped = generateMarkdown(safePayload, event.sender?.id ?? null, { maxChars: CLIPBOARD_BUG_REPORT_MAX_CHARS });
      // Whether the fallback ACTUALLY lost anything is a measurement, not an
      // assumption: passing maxChars also switches on routine node-row sampling
      // inside buildNodeDiagnosticsMarkdown, which `truncated`/`hardTruncated`
      // never report — so those flags alone cannot answer "did the user get
      // less than the full report?".
      //
      // Deliberately NOT a length comparison against the uncapped render: the
      // two renders are produced milliseconds apart and each stamps its own
      // generation time and relative ages ("38m ago"), so their lengths drift
      // by a character or two for reasons that have nothing to do with capping.
      // Ask each reducer whether it fired instead.
      const reduced = !!capped.truncated
        || !!capped.hardTruncated
        || ROUTINE_ROW_OMISSION_RE.test(capped.markdown);
      return {
        delivery: 'inline-fallback',
        clipboardText: capped.markdown,
        reduced,
        saveError: error?.message || String(error),
        truncated: capped.truncated,
        hardTruncated: capped.hardTruncated,
        trimmedEventCount: capped.trimmedEventCount,
        trimmedLogCount: capped.trimmedLogCount,
      };
    }
  });
}
