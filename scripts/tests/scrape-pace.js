import assert from 'node:assert/strict';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import {
  formatScrapePaceLine,
  getManualScraperTelemetry,
  notePaceChallengeEnd,
  notePaceChallengeStart,
  notePaceDetailOpened,
  notePaceListPage,
  notePaceSpacingWait,
  recordManualScraperTelemetry,
  resetManualScraperTelemetry,
  resetScrapePace,
} from '../../electron/ipc/browser/manualScraper.js';
import { buildJobsPipelineSnapshot, renderScrapePaceLines } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { challengeInputVerdict, createChallengeInputProbe, describeChallengeInput } from '../../electron/ipc/browser/challengeInputProbe.js';

const SOURCE = 'ziprecruiter';
const sender = { id: 71719, getURL: () => 'file:///synthetic/index.html' };
const report = () => __runWithIpcRequestContextForTests(
  { sender, nodeId: null, channel: 'bug-report' },
  () => buildJobsPipelineSnapshot(new Set(), sender.id, null, [], false, new Set(), new Set()),
);
const paceOf = (sourceId = SOURCE) => getManualScraperTelemetry().pace[sourceId];

// Mirrors production: the run-level reset, a source-start event (which is what
// makes the report render its Active Browser Scrape block at all), then the
// per-source pace reset that a source start performs.
function startPace(meta = {}) {
  resetManualScraperTelemetry();
  recordManualScraperTelemetry({ phase: 'source-start', sourceId: SOURCE, srcName: 'ZipRecruiter' });
  resetScrapePace(SOURCE, { srcName: 'ZipRecruiter', queryIndex: 1, queryTotal: 11, ...meta });
}

export default [{
  name: 'pace counts list and detail pages and splits checks between list and detail contexts',
  run() {
    startPace();
    notePaceListPage(SOURCE, { srcName: 'ZipRecruiter', queryIndex: 1, queryTotal: 11 });
    notePaceListPage(SOURCE, { srcName: 'ZipRecruiter', queryIndex: 1, queryTotal: 11 });
    const opened = () => notePaceDetailOpened(SOURCE, { srcName: 'ZipRecruiter', loadMs: 1000 });
    opened();
    opened();
    // A detail-page gate (challengeOnly) — ZipRecruiter's verification on a job page.
    notePaceChallengeStart(SOURCE, { srcName: 'ZipRecruiter', challengeOnly: true, now: 1_000 });
    notePaceChallengeEnd(SOURCE, { srcName: 'ZipRecruiter', now: 4_000 });
    opened();
    // A list-page gate — the same check encountered while paginating results.
    notePaceChallengeStart(SOURCE, { srcName: 'ZipRecruiter', challengeOnly: false, now: 10_000 });
    notePaceChallengeEnd(SOURCE, { srcName: 'ZipRecruiter', now: 11_500 });
    opened();
    opened();
    opened();
    const pace = paceOf();
    assert.equal(pace.srcName, 'ZipRecruiter');
    assert.equal(pace.queryIndex, 1);
    assert.equal(pace.queryTotal, 11);
    assert.equal(pace.listPages, 2);
    assert.equal(pace.detailOpened, 6);
    assert.deepEqual(pace.challenges, { list: 1, detail: 1 });
    // The two openers before the first check, then the one before the second.
    assert.deepEqual(pace.opensBetweenChallenges, [2, 1]);
    assert.equal(pace.opensSinceLastChallenge, 3);
    assert.equal(pace.challengeWaitMs, 4_500);
    assert.equal(pace.detailLoadMs, 6_000);
    assert.equal(pace.openChallengeSince, null);
    assert.equal(pace.lastChallengeAt, 10_000);
  },
}, {
  name: 'between-checks list keeps one value per check and only the last 20',
  run() {
    startPace();
    for (let check = 1; check <= 25; check++) {
      for (let opened = 0; opened < check; opened++) notePaceDetailOpened(SOURCE, { loadMs: 10 });
      notePaceChallengeStart(SOURCE, { challengeOnly: true, now: check * 1_000 });
    }
    const pace = paceOf();
    assert.equal(pace.challenges.detail, 25);
    assert.equal(pace.detailOpened, 325);
    assert.equal(pace.opensBetweenChallenges.length, 20);
    assert.deepEqual(pace.opensBetweenChallenges,
      [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    assert.equal(pace.opensSinceLastChallenge, 0);
  },
}, {
  name: 'an unresolved check counts its elapsed time as ongoing rather than completed',
  run() {
    startPace();
    const start = 1_700_000_000_000;
    notePaceChallengeStart(SOURCE, { challengeOnly: true, now: start });
    const midChallenge = start + ((7 * 60) + 12) * 1000;
    const open = paceOf();
    assert.equal(open.challengeWaitMs, 0);
    assert.equal(open.openChallengeSince, start);
    assert.match(formatScrapePaceLine(open, midChallenge), /waiting on you 7m12s \(check still open\)/u);
    notePaceChallengeEnd(SOURCE, { now: midChallenge });
    const closed = paceOf();
    assert.equal(closed.challengeWaitMs, 432_000);
    assert.equal(closed.openChallengeSince, null);
    // Once resolved the total is frozen: a later report time cannot inflate it.
    assert.match(formatScrapePaceLine(closed, midChallenge + 60_000), /waiting on you 7m12s · spacing/u);
  },
}, {
  name: 'a source restart resets its pace record instead of inheriting the previous attempt',
  run() {
    startPace();
    notePaceListPage(SOURCE, { srcName: 'ZipRecruiter' });
    notePaceDetailOpened(SOURCE, { srcName: 'ZipRecruiter', loadMs: 1_000 });
    notePaceChallengeStart(SOURCE, { srcName: 'ZipRecruiter', challengeOnly: true, now: 5_000 });
    assert.equal(paceOf().listPages, 1);
    resetScrapePace(SOURCE, { srcName: 'ZipRecruiter', queryIndex: 2, queryTotal: 11 });
    const pace = paceOf();
    assert.equal(pace.listPages, 0);
    assert.equal(pace.detailOpened, 0);
    assert.equal(pace.detailLoadMs, 0);
    assert.equal(pace.openChallengeSince, null);
    assert.deepEqual(pace.opensBetweenChallenges, []);
    assert.deepEqual(pace.challenges, { list: 0, detail: 0 });
    assert.equal(pace.queryIndex, 2);
    assert.equal(pace.queryTotal, 11);
  },
}, {
  name: 'the pace summary line names the counts and where the wall time went',
  run() {
    startPace();
    // Detail pages opened between consecutive checks, exactly the shape a
    // ZipRecruiter run produces: a check, some detail pages, another check…
    const between = [1, 1, 2, 1, 4];
    let at = 1_700_000_000_000;
    for (let index = 0; index < between.length; index++) {
      for (let opened = 0; opened < between[index]; opened++) {
        notePaceDetailOpened(SOURCE, { srcName: 'ZipRecruiter', loadMs: 7_000 });
      }
      notePaceChallengeStart(SOURCE, { srcName: 'ZipRecruiter', challengeOnly: index < 4, now: at });
      at += 86_400; // 5 checks × 1m26s4 = 7m12s of user-wait in total
      notePaceChallengeEnd(SOURCE, { srcName: 'ZipRecruiter', now: at });
    }
    notePaceListPage(SOURCE, { srcName: 'ZipRecruiter' });
    notePaceListPage(SOURCE, { srcName: 'ZipRecruiter' });
    notePaceSpacingWait(SOURCE, { srcName: 'ZipRecruiter', waitMs: 243_000 });
    assert.equal(formatScrapePaceLine(paceOf(), at),
      'ZipRecruiter pace: query 1/11 · 9 detail pages · 2 list pages · 5 checks (4 detail, 1 list)'
      + ' · detail pages between checks 1,1,2,1,4 · waiting on you 7m12s · spacing 4m03s'
      + ' · page loads 1m03s · 1m22s per detail page');
    // No record (or a non-record) formats to an empty line rather than text.
    assert.equal(formatScrapePaceLine(null), '');
    assert.equal(formatScrapePaceLine({}), 'source pace: query 1 · 0 detail pages · 0 list pages'
      + ' · 0 checks (0 detail, 0 list) · detail pages between checks n/a · waiting on you 0s'
      + ' · spacing 0s · page loads 0s · 0s per detail page');
  },
}, {
  name: 'the bug report renders a per-source scrape pace block only when telemetry carries pace',
  run() {
    startPace();
    notePaceListPage(SOURCE, { srcName: 'ZipRecruiter' });
    notePaceDetailOpened(SOURCE, { srcName: 'ZipRecruiter', loadMs: 5_000 });
    notePaceDetailOpened(SOURCE, { srcName: 'ZipRecruiter', loadMs: 5_000 });
    const withPace = report();
    assert.match(withPace, /### Active Browser Scrape/u);
    assert.match(withPace, /- Scrape pace \(per source, this process\):\n {2}- ZipRecruiter pace: /u);
    const paceLines = withPace.split('\n').filter(line => line.includes('ZipRecruiter pace:'));
    assert.equal(paceLines.length, 1);
    assert.match(paceLines[0], /· 2 detail pages · 1 list page · 0 checks \(0 detail, 0 list\)/u);
    // Metadata only: the pace row must never carry a URL or a posting title.
    assert.equal(/https?:\/\//u.test(paceLines[0]), false);
    assert.equal(paceLines[0].includes('synthetic'), false);

    // An older process (or a run that never entered a browser source) has no
    // `pace` at all: the block disappears while the section itself stays.
    resetManualScraperTelemetry();
    recordManualScraperTelemetry({ phase: 'source-start', sourceId: SOURCE, srcName: 'ZipRecruiter' });
    const withoutPace = report();
    assert.match(withoutPace, /### Active Browser Scrape/u);
    assert.equal(withoutPace.includes('Scrape pace'), false);
    assert.deepEqual(renderScrapePaceLines(undefined), []);
    assert.deepEqual(renderScrapePaceLines(null), []);
    assert.deepEqual(renderScrapePaceLines({}), []);
    assert.deepEqual(renderScrapePaceLines(getManualScraperTelemetry().pace), []);
  },
}, {
  name: 'input probe sums counts across page reloads and says what it saw, never who solved it',
  async run() {
    // A solve usually ends in a redirect, which wipes the page's own counters: the
    // probe must keep the first document's input after the second one appears.
    const reads = [
      { id: 'a', clicks: 0, keys: 0, moves: 0, frameFocus: 0 },
      { id: 'a', clicks: 0, keys: 0, moves: 5, frameFocus: 1 },
      { id: 'b', clicks: 1, keys: 0, moves: 0, frameFocus: 0 },
    ];
    let t = 0;
    const page = { evaluate: async () => reads.shift() };
    const probe = createChallengeInputProbe(page, { now: () => t });
    await probe.poll(); t = 30_000; await probe.poll(); t = 60_000; await probe.poll();
    const summary = probe.summary();
    assert.deepEqual({ clicks: summary.clicks, frameFocus: summary.frameFocus, moves: summary.moves, documents: summary.documents }, { clicks: 1, frameFocus: 1, moves: 5, documents: 2 });
    assert.equal(summary.firstInputAfterMs, 30_000);
    assert.equal(challengeInputVerdict(summary), 'input');
    assert.match(describeChallengeInput(summary), /1 click.*focus moved into the check's frame 1×.*most likely solved by hand/);

    const still = createChallengeInputProbe({ evaluate: async () => ({ id: 'c', clicks: 0, keys: 0, moves: 0, frameFocus: 0 }) });
    await still.poll(); await still.poll();
    assert.equal(challengeInputVerdict(still.summary()), 'none');
    assert.match(describeChallengeInput(still.summary()), /no mouse or key input.*most likely cleared by itself/);

    const moved = createChallengeInputProbe({ evaluate: async () => ({ id: 'd', clicks: 0, keys: 0, moves: 3, frameFocus: 0 }) });
    await moved.poll();
    assert.equal(challengeInputVerdict(moved.summary()), 'movement');

    // An unreadable page is "unknown", never "nobody touched it".
    const broken = createChallengeInputProbe({ evaluate: async () => { throw new Error('detached'); } });
    await broken.poll();
    assert.equal(challengeInputVerdict(broken.summary()), 'unknown');
    assert.match(describeChallengeInput(broken.summary()), /unknown/);
  },
}, {
  name: 'pace line and bug report say how each finished check ended',
  run() {
    startPace();
    notePaceChallengeStart(SOURCE, { srcName: 'ZipRecruiter', challengeOnly: true, now: 1_000 });
    notePaceChallengeEnd(SOURCE, { srcName: 'ZipRecruiter', now: 129_000, input: 'none' });
    notePaceChallengeStart(SOURCE, { srcName: 'ZipRecruiter', challengeOnly: true, now: 200_000 });
    notePaceChallengeEnd(SOURCE, { srcName: 'ZipRecruiter', now: 230_000, input: 'input' });
    const line = formatScrapePaceLine(paceOf(), 300_000);
    assert.match(line, /checks cleared: 1 with clicks or keys, 1 without/);
    recordManualScraperTelemetry({ phase: 'challenge-resolved', srcName: 'ZipRecruiter', clearedAfter: '2m08s', input: 'none',
      inputCounts: { clicks: 0, keys: 0, moves: 0, frameFocus: 0, documents: 2, polls: 80, failedPolls: 0 } });
    const text = JSON.stringify(report());
    assert.match(text, /challenge-resolved ZipRecruiter.*cleared=2m08s input=none \(clicks 0, keys 0, into-check focus 0, mouse moves 0\)/);
  },
}];
