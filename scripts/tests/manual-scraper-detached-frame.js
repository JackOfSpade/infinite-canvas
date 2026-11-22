import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getManualScraperTelemetry,
  resetManualScraperTelemetry,
  waitForReady,
  getChallengeSignals,
  detachedListRecoveryUrl,
  isDetachedDetailFrameError,
  pageUnreadableWarning,
  resolveManualSourceStopReason,
} from '../../electron/ipc/browser/manualScraper.js';
import { isUnreadablePage } from '../../electron/ipc/browser/manualScraper/pageReadiness.js';
import { runExtractor } from '../../electron/ipc/browser/manualScraper/listWalk.js';
import { isDetachedFrameError } from '../../electron/ipc/browser/manualScraper/detailParsing.js';

// Puppeteer's exact wording from the ZipRecruiter run that lost every row.
const DETACHED = "Attempted to use detached Frame 'F35FF1A2C0D6'.";
const SOURCE = 'ziprecruiter';
const overlayBase = { srcName: 'ZipRecruiter' };

const CHALLENGE = {
  isChallenge: true, isHardBlock: false, reason: 'cloudflare-challenge-frame',
  hasCloudflareChallengeFrame: true, hasCloudflareTurnstileWidget: true,
  url: 'https://www.ziprecruiter.com/jobs-search?search=x', title: 'Just a moment...', bodyHead: '',
  bodyTextLength: 10, matchedVerificationMarkers: [], hasNormalContent: false,
};

// getChallengeSignals is the only evaluate call that passes the two marker
// arrays; every other evaluate (overlay paint, block id, input probe) is inert.
function stubPage({ probe }) {
  let probes = 0;
  return {
    get probes() { return probes; },
    evaluate: async (fn, a, b) => {
      if (Array.isArray(a) && Array.isArray(b)) {
        probes += 1;
        return probe(probes);
      }
      return null;
    },
    url: () => 'https://www.ziprecruiter.com/jobs-search?search=x',
    isClosed: () => false,
    mouse: {},
    on() {},
    off() {},
    frames: () => [],
    mainFrame: () => ({}),
  };
}

const phases = () => getManualScraperTelemetry().events.map((e) => e.phase);
const abortAfterReads = (n) => {
  let reads = 0;
  return { get aborted() { reads += 1; return reads > n; } };
};

const read = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');

export default [{
  name: 'detached-frame predicate is shared and matches Puppeteer wording only',
  run() {
    assert.equal(isDetachedFrameError(new Error(DETACHED)), true);
    assert.equal(isDetachedFrameError('Navigating frame was detached'), true);
    assert.equal(isDetachedFrameError(new Error('Execution context was destroyed, most likely because of a navigation.')), false);
    assert.equal(isDetachedFrameError(new Error('SITE_CHANGED: no cards')), false);
    // The detail walk keeps its name but uses the same rule.
    assert.equal(isDetachedDetailFrameError(DETACHED), true);
    assert.equal(isDetachedDetailFrameError('Navigation timeout of 12000 ms exceeded'), false);
  },
}, {
  name: 'a detached-frame probe is reported as unread and detached, never as a clean page',
  async run() {
    const page = stubPage({ probe: () => { throw new Error(DETACHED); } });
    const signals = await getChallengeSignals(page);
    assert.equal(signals.reason, 'evaluate-failed');
    assert.equal(signals.pageDetached, true);
    assert.equal(signals.isChallenge, false);
    assert.equal(signals.bodyTextLength, null);
    assert.equal(isUnreadablePage(page, signals), true);
    // A plain probe failure is unread, but the page object is still usable.
    const transient = await getChallengeSignals(stubPage({ probe: () => { throw new Error('Execution context was destroyed'); } }));
    assert.equal(transient.reason, 'evaluate-failed');
    assert.equal(transient.pageDetached, false);
    assert.equal(isUnreadablePage({ isClosed: () => true }, transient), true);
    assert.equal(isUnreadablePage({ isClosed: () => false, browser: () => ({ isConnected: () => false }) }, transient), true);
    assert.equal(isUnreadablePage({ isClosed: () => false }, transient), false);
  },
}, {
  name: 'readiness on a detached page returns page-detached, not ok',
  async run() {
    resetManualScraperTelemetry();
    const page = stubPage({ probe: () => { throw new Error(DETACHED); } });
    const outcome = await waitForReady(page, SOURCE, overlayBase, abortAfterReads(50), null);
    assert.equal(outcome, 'page-detached');
    assert.equal(page.probes, 1, 'a dead page is handed back on the first probe, not retried');
    assert.ok(phases().includes('page-detached'));
    assert.ok(!phases().includes('challenge-resolved'));
  },
}, {
  name: 'a check whose page detaches after the user cleared it is not recorded as resolved',
  async run() {
    resetManualScraperTelemetry();
    const page = stubPage({ probe: (n) => { if (n === 1) return CHALLENGE; throw new Error(DETACHED); } });
    const outcome = await waitForReady(page, SOURCE, overlayBase, abortAfterReads(50), null);
    assert.equal(outcome, 'page-detached');
    assert.ok(!phases().includes('challenge-resolved'));
    // The open check is closed in the pace record on this way out too.
    assert.equal(getManualScraperTelemetry().pace?.[SOURCE]?.openChallengeSince ?? null, null);
  },
}, {
  name: 'unreadable probes during a check never start the clean timer or resolve the check',
  async run() {
    resetManualScraperTelemetry();
    // One challenge read, then every probe fails without detaching. The old
    // loop counted those failures as clean and resolved after ~1.5s + settle;
    // now the check stays open until the wait is aborted.
    const page = stubPage({ probe: (n) => { if (n === 1) return CHALLENGE; throw new Error('Execution context was destroyed'); } });
    const outcome = await waitForReady(page, SOURCE, overlayBase, abortAfterReads(7), null);
    assert.equal(outcome, 'abort');
    assert.ok(page.probes >= 6);
    assert.ok(!phases().includes('challenge-resolved'));
  },
}, {
  name: 'runExtractor separates a detached frame from a transient evaluate error',
  async run() {
    const detached = await runExtractor({ evaluate: async () => { throw new Error(DETACHED); }, isClosed: () => false }, '1');
    assert.equal(detached.evalError, null);
    assert.equal(detached.siteChangedError, null);
    assert.match(detached.detachedError.message, /detached Frame/);
    assert.deepEqual(detached.jobs, []);

    const closed = await runExtractor({ evaluate: async () => { throw new Error('Protocol error: Target closed'); }, isClosed: () => true }, '1');
    assert.ok(closed.detachedError);
    assert.equal(closed.evalError, null);

    const transient = await runExtractor({ evaluate: async () => { throw new Error('Execution context was destroyed'); }, isClosed: () => false }, '1');
    assert.equal(transient.detachedError, null);
    assert.ok(transient.evalError);

    const changed = await runExtractor({ evaluate: async () => { throw new Error('SITE_CHANGED: zero cards'); }, isClosed: () => false }, '1');
    assert.ok(changed.siteChangedError);
    assert.equal(changed.detachedError, null);

    const ok = await runExtractor({ evaluate: async () => [{ title: 'a' }], isClosed: () => false }, '1');
    assert.equal(ok.jobs.length, 1);
    assert.equal(ok.detachedError, null);
  },
}, {
  name: 'recovery reopens only a list position a URL can reproduce',
  run() {
    const dead = 'https://www.ziprecruiter.com/jobs-search?search=x&page=3';
    const task = 'https://www.ziprecruiter.com/jobs-search?search=x';
    assert.equal(detachedListRecoveryUrl({ deadPageUrl: dead, taskUrl: task, urlPaginated: true, onFirstPage: false }), dead);
    assert.equal(detachedListRecoveryUrl({ deadPageUrl: 'about:blank', taskUrl: task, onFirstPage: true }), task);
    // First page: the query's own list URL, never the dead page's last route
    // (right after a check that can be the check page itself).
    assert.equal(detachedListRecoveryUrl({ deadPageUrl: 'https://www.ziprecruiter.com/challenge', taskUrl: task, onFirstPage: true }), task);
    assert.equal(detachedListRecoveryUrl({ deadPageUrl: 'about:blank', taskUrl: task, urlPaginated: true, onFirstPage: false }), null);
    // Positions a fresh page cannot restore: revealed scroll lists, load-more
    // lists past their first batch, click pagers past page one.
    assert.equal(detachedListRecoveryUrl({ deadPageUrl: dead, taskUrl: task, scrollSource: true }), null);
    assert.equal(detachedListRecoveryUrl({ deadPageUrl: dead, taskUrl: task, loadMoreRowsRead: 20 }), null);
    assert.equal(detachedListRecoveryUrl({ deadPageUrl: dead, taskUrl: task, urlPaginated: false, onFirstPage: false }), null);
  },
}, {
  name: 'walk recovers a detached list page once per query and never reports it as an extractor fault',
  run() {
    const src = read('electron/ipc/browser/manualScraper.js');
    // The page binding is reassignable so the walk follows the replacement.
    assert.match(src, /let \{ page \} = platform;/);
    assert.doesNotMatch(src, /const \{ page, navStatusRef \} = platform;/);
    // Replacement tab: same setup as the platform launch.
    const helper = src.slice(src.indexOf('async function openReplacementScrapePage'), src.indexOf('export function detachedListRecoveryUrl'));
    assert.match(helper, /createBackgroundScrapePage\(browser/);
    assert.match(helper, /applyStealthMask\(replacement\)/);
    assert.match(helper, /replacement\.on\('response'[\s\S]*navStatusRef\.last = status/);
    assert.match(helper, /replacement\.on\('console'/);
    assert.match(helper, /replacement\.on\('requestfailed'/);
    assert.match(helper, /evaluateOnNewDocument\(OVERLAY_SCRIPT\)/);
    // Recovery re-runs the normal readiness/challenge wait on the fresh page.
    const recover = src.slice(src.indexOf('const recoverDetachedListPage'), src.indexOf('const noteDetachedUnrecovered'));
    assert.match(recover, /page = replacement;/);
    assert.match(recover, /await waitForReady\(page, sourceId, overlayBase, signal, url\)/);
    // One recovery per query: the flag is set before the attempt, both sites check it.
    assert.match(src, /let pageRecoveryUsed = false;/);
    assert.match(src, /if \(pageRecoveryUsed\) return 'page-detached';\s*pageRecoveryUsed = true;/);
    const extractBranch = src.slice(src.indexOf('if (detachedError) {'), src.indexOf('if (evalError) {'));
    assert.ok(extractBranch.length > 0, 'the detached branch runs before the evalError retry');
    assert.match(extractBranch, /pageRecoveryUsed \? null : detachedListRecoveryUrl/);
    assert.match(extractBranch, /pageRecoveryUsed = true;/);
    assert.match(extractBranch, /noteDetachedUnrecovered\(/);
    assert.doesNotMatch(extractBranch, /extractor-error/);
    // Unrecovered: stop the source through the browser-closed path.
    assert.match(src, /const noteDetachedUnrecovered = [\s\S]*?earlyExit = true;/);
    assert.match(src, /const pageUnreadable = !!pageDetachedUnrecovered && !browserClosedUnexpectedly && !signal\?\.aborted;/);
    assert.match(src, /pageUnreadableWarning\(\{/);
    assert.match(src, /if \(browserClosed \|\| pageUnreadable\) earlyExit = false;/, 'later sources still run');
    // The page-turn gate handles a dead page before reading its URL.
    const turnGate = src.slice(src.indexOf("let pagedReady = await waitForReady("), src.indexOf("if (pagedReady === 'hard-block' || pagedReady === 'skip')"));
    assert.match(turnGate, /if \(pagedReady === 'page-detached'\) \{/);
    assert.match(turnGate, /noteDetachedUnrecovered\(\{ qi, pageNum, cause: 'page-turn-readiness', recoveryState \}\)/);
    // A readiness wait that hands back a dead page is never extracted from.
    assert.match(src, /if \(readyState === 'page-detached'\) \{\s*noteDetachedUnrecovered\(/);
  },
}, {
  name: 'readiness never counts an unreadable probe as clean (source pin)',
  run() {
    const src = read('electron/ipc/browser/manualScraper/pageReadiness.js');
    const probeGate = src.indexOf('if (probeFailed) {');
    const cleanTimer = src.indexOf('if (cleanSince === null) cleanSince = Date.now();');
    assert.ok(probeGate > 0 && cleanTimer > probeGate, 'the unreadable-probe gate precedes the stable-clean timer');
    assert.match(src, /postSettleSignals\?\.reason === 'evaluate-failed'/);
    assert.match(src, /return 'page-detached';/);
  },
}, {
  name: 'an unrecovered dead page is reported as an unreadable page, not a closed window',
  run() {
    assert.equal(resolveManualSourceStopReason({ pageUnreadable: true, earlyExit: true }), 'page-unreadable');
    assert.equal(resolveManualSourceStopReason({ browserClosed: true, pageUnreadable: true }), 'browser-closed');
    const warning = pageUnreadableWarning({ srcName: 'ZipRecruiter', queryIndex: 1, pageNum: 1, unreadQueries: 8, queryTotal: 9 });
    assert.equal(warning.severity, 'block');
    assert.match(warning.evidence, /results page stopped responding to the scraper \(search 1 of 9, page 1\)/);
    assert.doesNotMatch(warning.suggestion, /window/);
    assert.match(read('electron/ipc/bugReport/jobsSnapshot.js'), /v\.stopReason === 'page-unreadable'/);
    const nav = read('electron/ipc/browser/manualScraper/expandByNavigation.js');
    assert.match(nav, /detailWaitResult === 'page-detached'\s*\? 'detail-page-detached'/);
    assert.match(read('electron/ipc/browser/manualScraper/glassdoorLocation.js'), /if \(originReady === 'page-detached'\) \{/);
    const readiness = read('electron/ipc/browser/manualScraper/pageReadiness.js');
    assert.ok(readiness.indexOf('if (probeFailed) {') < readiness.indexOf('    terminalSince = null;\n'), 'an unreadable probe does not reset the terminal timer');
  },
}];
