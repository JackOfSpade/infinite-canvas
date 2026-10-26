// Board-closed handling: a job board's "gone" verdict flags the row instead of
// dropping it, the official-posting resolver sees it, and the most official
// source decides. Synthetic names only (Northwind Labs, Acme Talent Partners ...).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { JSDOM } from 'jsdom';
import {
  __registerJobsHandlersForTests, filterJobsByDescriptionEvidence, getJobsTelemetry,
  reconcileSearchFunnel, registerJobsHandlers, retiredListingKeys,
} from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { readRunState, sanitizeLastRunReceipt } from '../../electron/ipc/jobRunStaging.js';
import { buildJobRecoverySnapshot, buildJobsPipelineSnapshot } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import {
  BOARD_CLOSED_REASONS, boardClosedBoardLabel, normalizeBoardClosed, normalizeOfficialPosting,
  officialResearchSettled, OFFICIAL_POSTING_ROW_FIELDS, OFFICIAL_POSTING_TRAIL,
} from '../../electron/ipc/officialPostingFields.js';
import {
  BOARD_CLOSED_DISPOSITIONS, boardClosedDetailAllowed, boardClosedRetirement, boardClosedSetAside,
  boardClosedTelemetryBlock, isBoardClosedRow, mergeBoardClosedTelemetry, preferOpenRows,
  scoreSafeRowsWithBoardClosed, settleBoardClosedRows, withBoardClosed,
} from '../../electron/ipc/officialPostingBoardClosed.js';
import { createOfficialPostingRecoveryPassResolver, mergeOfficialPostingTelemetry, officialPostingDedup } from '../../electron/ipc/officialPostingService.js';
import { shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import {
  composeDetailBlockReprobeResult, didDetailBlockReprobeRecover, unavailableDetailDisposition,
} from '../../electron/ipc/browser/manualScraper.js';
import { classifyIndeedUnavailablePage, markIndeedBoardClosed, needsIndeedDescriptionRetry } from '../../electron/extractors/indeedBrowser.js';
import {
  linkedInClosedMarkerProbe, linkedInEnrichedRow, linkedInPostingClosed, linkedInUndescribedRow,
} from '../../electron/extractors/apiExtractors.js';
import { __pastePromptForTests, __projectLocalApplicationJobForAcceptanceHarness as safeJob } from '../../electron/ipc/localAiApplication.js';
import { officialPostingDisplay } from '../../src/utils/officialPostingDisplay.js';
import { buildJobTreeNodes } from '../../src/nodes/jobsearch/buildJobTree.js';
import { dedupJobsAcrossSources } from '../../src/utils/jobIdentity.js';
import { mergeResolvedSourceItems } from '../../src/utils/jobSourceResolveMerge.js';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';

const AT = '2026-10-24T12:00:00.000Z';
const read = relative => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const longText = seed => `${seed} Responsibilities include building reliable services, reviewing incidents and mentoring peers. `.repeat(8);
const marker = (board = 'linkedin', reason = 'linkedin-no-longer-accepting') => ({ board, reason, at: AT });

function posting(extra = {}) {
  return {
    level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
    location: { display: 'Remote, Canada', workMode: 'remote', remote: true, remoteCountry: 'Canada', remoteRegion: '' },
    salary: { text: '', provenance: 'unknown' }, sourceUrl: 'https://careers.northwind.example.test/jobs/platform',
    officialApplyUrl: 'https://careers.northwind.example.test/jobs/platform/apply', ats: 'ashby', tenant: 'northwind-synthetic',
    fetchedAt: AT, contentHash: 'a'.repeat(64), trail: ['careers-page'], ...extra,
  };
}
const miss = (trail, extra = {}) => ({ level: 'L5', outcome: 'not-found', employer: 'Acme Talent Partners', trail, ...extra });
const row = (extra = {}) => ({
  source: 'remoteok', title: 'Platform Engineer', company: 'Northwind Labs', location: 'Remote', salary: '',
  posted: 'today', url: 'https://listing.example.test/platform', snippet: longText('Platform'), ...extra,
});
const closedRow = (extra = {}) => row({ boardClosed: marker(), ...extra });
// What the evidence gate reads: the scraped text only.
const scrapedSafe = job => filterJobsByDescriptionEvidence([job]).jobs.length === 1;
const viewOf = text => async job => ({ employer: job.company, title: job.title, location: job.location, salary: '',
  description: text, officialPosting: normalizeOfficialPosting(job.officialPosting) || undefined });

async function settle(rows, getView = viewOf(longText('Official posting'))) {
  return settleBoardClosedRows(rows, { scoreSafe: scrapedSafe, getView, minChars: 400 });
}

const pureTests = [
  // ── Field ────────────────────────────────────────────────────────────────
  {
    name: 'board-closed field: bounded exact-key marker, shared row field, frozen-job whitelist and no stage prompt',
    run() {
      assert.ok(OFFICIAL_POSTING_ROW_FIELDS.includes('boardClosed'));
      assert.deepEqual(normalizeBoardClosed(marker('indeed', 'indeed-job-unavailable')),
        { board: 'indeed', reason: 'indeed-job-unavailable', at: AT });
      assert.equal(normalizeBoardClosed({ ...marker(), at: '2026-10-24T12:00:00Z' }).at, AT, 'at is canonical ISO');
      for (const reason of BOARD_CLOSED_REASONS) assert.ok(normalizeBoardClosed(marker('ziprecruiter', reason)), reason);
      for (const bad of [null, [], 'closed', {}, { board: 'linkedin', reason: 'linkedin-no-longer-accepting' },
        { ...marker(), extra: 'page text' }, marker('LinkedIn'), marker('linked in'), marker('x'.repeat(41)), marker('linkedin', 'closed'),
        marker('linkedin', 'No longer accepting applications'), { ...marker(), at: 'yesterday' }, { ...marker(), at: 'x'.repeat(41) },
        { ...marker(), at: '<b>2026-10-24</b>' }]) assert.equal(normalizeBoardClosed(bad), null, JSON.stringify(bad));
      assert.equal(boardClosedBoardLabel('linkedin'), 'LinkedIn');
      assert.equal(boardClosedBoardLabel('ziprecruiter'), 'ZipRecruiter');
      assert.equal(boardClosedBoardLabel('<script>'), '');

      const frozen = safeJob(row({ boardClosed: marker('ziprecruiter', 'detail-page-not-found') }));
      assert.deepEqual(frozen.boardClosed, marker('ziprecruiter', 'detail-page-not-found'));
      assert.equal(safeJob(row({ boardClosed: { ...marker(), injected: true } })).boardClosed, undefined);
      assert.equal(safeJob(row()).boardClosed, undefined);
      // The Board card carries it (and clears a stale one), and the constructor refuses what the normalizer refuses.
      const cardOf = (job, protectedCards = []) => buildJobTreeNodes({ displayedJobs: [job],
        bucketTree: { roles: [{ name: 'Platform Engineering', jobIndices: [0] }], likelihoodBands: [{ label: 'Strong (70-100%)', minScore: 70, maxScore: 100 }], salaryRanges: [{ label: 'Any', minSalary: 0, maxSalary: null }] },
        originalPos: { x: 0, y: 0 }, hubId: 'board-closed-hub', baseNodeId: 'closed', protectedCards }).newNodes.find(node => node.type === 'jobcard');
      const card = cardOf(row({ matchScore: 80, boardClosed: marker() }));
      assert.deepEqual(card.data.boardClosed, marker());
      assert.equal(cardOf(row({ matchScore: 80, reuseCardId: card.id }), [card]).data.boardClosed, undefined, 'a reused card does not keep a stale marker');
      assert.equal(isBoardClosedRow(card.data), true); assert.equal(isBoardClosedRow(row()), false);
      assert.deepEqual(withBoardClosed(row(), { board: 'indeed', reason: 'indeed-job-unavailable', now: new Date(AT) }).boardClosed, marker('indeed', 'indeed-job-unavailable'));
      const plain = row();
      assert.equal(withBoardClosed(plain, { board: 'indeed', reason: 'not an enum value' }), plain);
      assert.equal(withBoardClosed(plain, { board: 'indeed', reason: 'indeed-job-unavailable', now: new Date('nonsense') }), plain);

      // The discovery stage prompt prints the job's identifying facts only.
      const job = safeJob(row({ boardClosed: marker('linkedin', 'linkedin-no-longer-accepting') }));
      const input = { jobId: 'synthetic-board-closed', job, authorityProtocol: 'requirements-ledger.v3', careerAuthority: { version: 1 },
        __careerAuthorityIndex: { identity: { name: 'Jordan Sample', contact: ['jordan@example.test'] } },
        hostCareerEvidenceCatalog: [], sourceRoles: [], careerSkillEvidence: { skills: [] } };
      const state = { handoffCode: 'synthetic-handoff', baseHashes: {}, stage: 'requirements',
        authorityStore: { receipt: () => ({ digest: 'c'.repeat(64), streams: {} }) },
        authorityListingPage: { text: 'Maintain dependable platform services.', index: 0, pageCount: 1, digest: 'd'.repeat(64) } };
      const prompt = __pastePromptForTests({ input, state });
      const context = JSON.parse(prompt.split('Authoritative context:\n')[1]);
      assert.equal(Object.hasOwn(context.job, 'boardClosed'), false);
      for (const sentinel of ['linkedin-no-longer-accepting', AT, 'boardClosed']) assert.equal(prompt.includes(sentinel), false, sentinel);
    },
  },

  // ── Detection (a): aggregator detail pages in the manual scraper ─────────
  {
    name: 'board-closed detection: aggregator not-found and ZipRecruiter closed redirect keep the row flagged; Workday and employer or ATS hosts still drop',
    run() {
      const now = new Date(AT);
      const card = { source: 'ziprecruiter', title: 'Support Engineer', company: 'Fabrikam Cloud', location: 'Remote', url: 'https://www.ziprecruiter.com/c/fabrikam/job/support' };
      const keep = unavailableDetailDisposition({ pageInfo: { isNotFound: true }, job: card, sourceId: 'ziprecruiter',
        expectedUrl: card.url, finalUrl: card.url, now });
      assert.equal(keep.reason, 'detail-page-not-found');
      assert.deepEqual(keep.row, { ...card, boardClosed: marker('ziprecruiter', 'detail-page-not-found') }, 'list-card fields survive');
      const redirect = unavailableDetailDisposition({ pageInfo: { zipRecruiterClosedJobRedirect: true }, job: card, sourceId: 'ziprecruiter',
        expectedUrl: card.url, finalUrl: 'https://www.ziprecruiter.com/jobseeker/home?closed_job_redirect=1', now });
      assert.equal(redirect.reason, 'ziprecruiter-closed-job-redirect');
      assert.equal(redirect.row.boardClosed.reason, 'ziprecruiter-closed-job-redirect');
      // Dice is an aggregator too; the board id is the source id.
      assert.equal(unavailableDetailDisposition({ pageInfo: { isNotFound: true }, job: { ...card, source: 'dice' }, sourceId: 'dice',
        expectedUrl: 'https://www.dice.com/job-detail/x', finalUrl: 'https://www.dice.com/job-detail/x', now }).row.boardClosed.board, 'dice');

      // The official source saying "closed" keeps today's drop.
      const workday = unavailableDetailDisposition({ pageInfo: { workdayPostingAvailable: false }, job: card, sourceId: 'ziprecruiter',
        expectedUrl: 'https://northwind.wd5.myworkdayjobs.com/en-US/careers/job/1/apply', finalUrl: 'https://northwind.wd5.myworkdayjobs.com/en-US/careers/job/1/apply', now });
      assert.equal(workday.reason, 'workday-posting-unavailable'); assert.equal(workday.row, null);
      // Workday's flag wins even if the ZipRecruiter page was the expected URL.
      assert.equal(unavailableDetailDisposition({ pageInfo: { workdayPostingAvailable: false, isNotFound: true }, job: card, sourceId: 'ziprecruiter',
        expectedUrl: card.url, finalUrl: card.url, now }).row, null);
      for (const [expectedUrl, finalUrl] of [
        [card.url, 'https://careers.northwind.example.test/jobs/1'],
        ['https://careers.northwind.example.test/jobs/1', 'https://careers.northwind.example.test/jobs/1'],
        [card.url, 'https://boards.greenhouse.io/northwind/jobs/9'],
        ['https://jobs.lever.co/northwind/abc', 'https://www.ziprecruiter.com/jobseeker/home'],
        ['', ''], ['not a url', 'also not'],
      ]) assert.equal(unavailableDetailDisposition({ pageInfo: { isNotFound: true }, job: card, sourceId: 'ziprecruiter', expectedUrl, finalUrl, now }).row, null, `${expectedUrl} -> ${finalUrl}`);
      assert.equal(unavailableDetailDisposition({ pageInfo: { isNotFound: true }, job: null, sourceId: 'ziprecruiter', expectedUrl: card.url, finalUrl: card.url }).row, null);
      assert.equal(boardClosedDetailAllowed({ expectedUrl: 'https://www.linkedin.com/jobs/view/1', finalUrl: 'https://www.linkedin.com/jobs/view/1' }), true);
      assert.equal(boardClosedDetailAllowed({ expectedUrl: 'https://www.linkedin.com/jobs/view/1', finalUrl: 'https://careers.example.test/x' }), false);

      // Counters stay apart: dropped rows are NOT kept rows, and a kept row is still terminal proof.
      assert.equal(didDetailBlockReprobeRecover({ boardClosedDetailKept: 1 }), true);
      assert.equal(didDetailBlockReprobeRecover({ boardClosedDetailKept: 0, unavailableDetailDropped: 0 }), false);
      const probe = { jobs: [card], expandedCount: 0, unavailableDetailDropped: 1, boardClosedDetailKept: 1 };
      const composed = composeDetailBlockReprobeResult(probe, { jobs: [], unavailableDetailDropped: 2, boardClosedDetailKept: 3 });
      assert.equal(composed.unavailableDetailDropped, 3); assert.equal(composed.boardClosedDetailKept, 4);
      assert.equal(composeDetailBlockReprobeResult({ jobs: [], boardClosedDetailKept: 0 }, null, [], 'description-rate-limited').boardClosedDetailKept, 0);

      const scraper = read('electron/ipc/browser/manualScraper.js');
      const branch = scraper.slice(scraper.indexOf('if (isUnavailableDetailPage(pageInfo)) {'), scraper.indexOf('const isExternalZipDetail'));
      assert.match(branch, /unavailableDetailDisposition\(\{/u);
      assert.ok(branch.indexOf('boardClosedDetailKept += 1;') < branch.indexOf('if (enhanced[i] != null) unavailableDetailDropped += 1;'));
      assert.ok(scraper.includes('boardClosedDetailKept: sourceBoardClosedDetailKept,'));
    },
  },

  // ── Detection (b): Indeed unavailable pages ──────────────────────────────
  {
    name: 'board-closed detection: Indeed unavailable pages flag the row instead of retiring it, and are not retried again',
    run() {
      const indeedUrl = 'https://www.indeed.com/viewjob?jk=abc123';
      for (const [title, body, reason] of [
        ['Indeed', "We can't find this page. This page doesn't exist.", 'page-unavailable'],
        ['Indeed', 'This job is no longer available.', 'job-unavailable'],
      ]) {
        assert.equal(classifyIndeedUnavailablePage({ title, body }), reason);
        const job = { source: 'indeed', title: 'Data Engineer', company: 'Contoso Systems', url: indeedUrl, snippet: '' };
        assert.equal(needsIndeedDescriptionRetry(job), true);
        assert.equal(markIndeedBoardClosed(job, reason, { expectedUrl: indeedUrl, finalUrl: indeedUrl }), true);
        assert.equal(job.boardClosed.board, 'indeed'); assert.equal(job.boardClosed.reason, `indeed-${reason}`);
        assert.equal(job.descriptionDeferredReason, `indeed-${reason}`, 'the established deferral marker is kept');
        assert.equal(needsIndeedDescriptionRetry(job), false, 'a terminal board verdict is not retried');
      }
      // The same wording served by an employer or ATS page is the official source closing.
      const redirected = { source: 'indeed', title: 'Data Engineer', company: 'Contoso Systems', url: indeedUrl, snippet: '' };
      assert.equal(markIndeedBoardClosed(redirected, 'job-unavailable', { expectedUrl: indeedUrl, finalUrl: 'https://careers.contoso.example.test/jobs/1' }), false);
      assert.equal(redirected.boardClosed, undefined);
      assert.equal(redirected.descriptionDeferredReason, 'indeed-job-unavailable', 'unflagged rows retire through the old marker');
      assert.equal(markIndeedBoardClosed(null, 'job-unavailable'), false);

      const indeed = read('electron/extractors/indeedBrowser.js');
      const retry = indeed.slice(indeed.indexOf('export async function retryIndeedJobDescriptions'), indeed.indexOf('Fetch Indeed job listings using a real Chrome session'));
      assert.match(retry, /markIndeedBoardClosed\(job, unavailableReason, \{ expectedUrl: jobUrl, finalUrl: page\.url\(\) \}\)/u);
      assert.match(retry, /const activeRows = rows\.filter\(job => !officialClosedKeys\.has\(sourceJobKey\(job\)\)\);/u);
      assert.doesNotMatch(retry, /unavailableKeys/u);
      assert.match(indeed, /markIndeedBoardClosed\(job, unavailableReason, \{ expectedUrl: jobUrl, finalUrl: page\.url\(\) \}\);\n\s+recordIndeedEnrichmentAttempt\(job, \{ stage, outcome: 'unavailable'/u);
    },
  },

  // ── Detection (c): LinkedIn closed marker ────────────────────────────────
  {
    name: 'board-closed detection: LinkedIn closed marker outside the description flags the row and keeps its description',
    run() {
      const probeIn = (html, descriptionSelector = '.show-more-less-html__markup') => {
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
        dom.window.eval(`window.__probe = ${linkedInClosedMarkerProbe.toString()}`);
        void descriptionSelector;
        return dom.window.__probe();
      };
      const closed = probeIn('<body><figure class="closed-job"><figcaption>No longer accepting applications</figcaption></figure><div class="show-more-less-html__markup">Build services.</div></body>');
      assert.equal(linkedInPostingClosed(closed), true);
      assert.equal(linkedInPostingClosed(probeIn('<body><figcaption>NO LONGER ACCEPTING   APPLICATIONS</figcaption><div class="description__text">Build services.</div></body>')), true, 'case and spacing');
      // A description that merely quotes the phrase is not the board talking.
      assert.equal(linkedInPostingClosed(probeIn('<body><div class="show-more-less-html__markup">Note: we are no longer accepting applications after Friday.</div></body>')), false);
      assert.equal(linkedInPostingClosed(probeIn('<body><h1>Platform Engineer</h1><div class="show-more-less-html__markup">Apply now. Applications are closed soon.</div></body>')), false);
      assert.equal(linkedInPostingClosed(probeIn('<body><h1>Platform Engineer</h1></body>')), false);
      assert.equal(linkedInPostingClosed(null), false); assert.equal(linkedInPostingClosed({ page: 1 }), false);

      const described = { source: 'linkedin', title: 'Platform Engineer', company: 'Northwind Labs', url: 'https://www.linkedin.com/jobs/view/1', snippet: '' };
      const flagged = linkedInEnrichedRow(described, longText('LinkedIn'), true);
      assert.equal(flagged.snippet, longText('LinkedIn')); assert.equal(flagged.description, longText('LinkedIn'));
      assert.equal(flagged.boardClosed.board, 'linkedin'); assert.equal(flagged.boardClosed.reason, 'linkedin-no-longer-accepting');
      assert.equal(scrapedSafe(flagged), true, 'LinkedIn rows are not dropped: the description is still score-safe');
      assert.equal(linkedInEnrichedRow(described, longText('LinkedIn'), false).boardClosed, undefined);
      assert.equal(linkedInEnrichedRow(flagged, longText('LinkedIn'), false).boardClosed, undefined, 'a re-read without the marker clears a stale flag');
      assert.equal(linkedInUndescribedRow(described, true).boardClosed.board, 'linkedin');
      assert.equal(linkedInUndescribedRow(described, false), described);

      const extractor = read('electron/extractors/apiExtractors.js');
      assert.match(extractor, /linkedInPostingClosed\(await page\.evaluate\(linkedInClosedMarkerProbe\)\.catch\(\(\) => null\)\)/u);
      assert.match(extractor, /enriched\[i\] = linkedInEnrichedRow\(job, result\.text, closedMarker\);/u);
      assert.match(extractor, /enriched\[i\] = linkedInUndescribedRow\(job, closedMarker\);/u);
    },
  },

  // ── Pipeline helpers ─────────────────────────────────────────────────────
  {
    name: 'board-closed set-aside: only the evidence gate drops that are flagged are rescued, open rows win dedup ties, and an unflagged run is untouched',
    run() {
      const open = row({ title: 'Platform Engineer' });
      const flaggedDescribed = closedRow({ title: 'Platform Engineer', source: 'linkedin' });
      const flaggedBare = closedRow({ title: 'Data Engineer', company: 'Contoso Systems', snippet: '' });
      const plainBare = row({ title: 'Support Engineer', company: 'Fabrikam Cloud', snippet: '' });
      const evidence = filterJobsByDescriptionEvidence([flaggedDescribed, open, flaggedBare, plainBare]);
      assert.deepEqual(boardClosedSetAside(evidence), [flaggedBare], 'a bare unflagged row stays deferred, exactly as before');
      assert.equal(evidence.dropped.length, 2, 'descriptionEvidence.dropped is untouched for every existing bookkeeping use');
      const rescued = scoreSafeRowsWithBoardClosed(evidence);
      assert.deepEqual(rescued, [open, flaggedDescribed, flaggedBare], 'open rows first, closed rows after');
      const unflagged = filterJobsByDescriptionEvidence([open, plainBare]);
      assert.equal(scoreSafeRowsWithBoardClosed(unflagged), unflagged.jobs, 'the same array: nothing changes without a flag');
      const list = [open];
      assert.equal(preferOpenRows(list), list);

      // First-wins dedup would otherwise keep the closed LinkedIn copy over the open Indeed copy.
      const closedFirst = closedRow({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/9' });
      const openSecond = row({ source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=9' });
      const dropped = [];
      assert.deepEqual(dedupJobsAcrossSources([closedFirst, openSecond]).map(job => job.source), ['linkedin'], 'control: order alone makes the closed copy win');
      const kept = dedupJobsAcrossSources(preferOpenRows([closedFirst, openSecond]), { onDuplicate: entry => dropped.push(entry) });
      assert.deepEqual(kept.map(job => job.source), ['indeed']);
      assert.equal(dropped[0].dropped, closedFirst);
    },
  },

  {
    name: 'board-closed set-aside: a described flagged row listed before an open duplicate never beats it in the official dedup, whatever is set aside',
    run() {
      // The normal LinkedIn case: a flagged row WITH a description passes the evidence gate, so no
      // description-less row is set aside. Solve, resume and single-source paths still must not
      // hand the resolver the closed copy first.
      const official = posting();
      const closedFirst = closedRow({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/21', officialPosting: official });
      const openSecond = row({ source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=21', officialPosting: official });
      const evidence = filterJobsByDescriptionEvidence([closedFirst, openSecond]);
      assert.deepEqual(boardClosedSetAside(evidence), [], 'control: a described flagged row is score-safe, so nothing is set aside');
      const ordered = scoreSafeRowsWithBoardClosed(evidence);
      assert.deepEqual(ordered, [openSecond, closedFirst], 'the open copy goes first even when nothing was set aside');
      assert.deepEqual(evidence.jobs, [closedFirst, openSecond], 'the evidence result itself is not reordered in place');
      const dedup = officialPostingDedup(ordered);
      assert.deepEqual(dedup.kept.map(job => job.source), ['indeed'], 'the open copy survives the official dedup');
      assert.deepEqual(dedup.dropped.map(entry => entry.dropped), [closedFirst]);
      assert.equal(isBoardClosedRow(dedup.kept[0]), false, 'the surviving card does not carry the closed marker');

      // Same result when a description-less flagged row IS set aside beside the described one.
      const bare = closedRow({ title: 'Data Engineer', company: 'Contoso Systems', snippet: '' });
      const mixed = scoreSafeRowsWithBoardClosed(filterJobsByDescriptionEvidence([closedFirst, bare, openSecond]));
      assert.deepEqual(mixed, [openSecond, closedFirst, bare]);

      // Several flagged rows keep their relative order behind the open rows, and an unflagged pool is untouched.
      const closedLate = closedRow({ source: 'ziprecruiter', title: 'Cloud Engineer', company: 'Fabrikam Cloud', url: 'https://www.ziprecruiter.com/jobs/cloud' });
      const openLate = row({ source: 'remoteok', title: 'Cloud Engineer', company: 'Fabrikam Cloud', url: 'https://remoteok.example.test/cloud' });
      assert.deepEqual(scoreSafeRowsWithBoardClosed(filterJobsByDescriptionEvidence([closedFirst, closedLate, openSecond, openLate])),
        [openSecond, openLate, closedFirst, closedLate]);
      const plain = filterJobsByDescriptionEvidence([openSecond, openLate]);
      assert.equal(scoreSafeRowsWithBoardClosed(plain), plain.jobs, 'the same array: nothing changes without a flag');
    },
  },
  {
    name: 'board-closed renderer merge: an open copy beats a pending board-closed copy of the same posting, whichever arrived first',
    run() {
      const closedLinkedIn = closedRow({
        source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/31', officialPosting: miss(['bridge-unavailable'], { employer: 'Northwind Labs' }),
      });
      const openIndeed = row({ source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=31', jobkey: '31' });
      const unrelated = row({ source: 'remoteok', title: 'Cloud Engineer', company: 'Fabrikam Cloud', url: 'https://remoteok.example.test/cloud' });
      const sourcesOf = merged => merged.mergedPending.map(job => `${job.source}${isBoardClosedRow(job) ? '(closed)' : ''}`);

      // Search ran with Indeed blocked and kept the closed LinkedIn row unchecked. Continue returns the open copy.
      const resumed = mergeResolvedSourceItems([closedLinkedIn, unrelated], [openIndeed], 'indeed');
      assert.deepEqual(sourcesOf(resumed), ['remoteok', 'indeed'], 'the open copy replaces the pending closed copy');
      assert.deepEqual(resumed.fresh, [openIndeed]);
      assert.equal(resumed.replacedExisting, 1, 'the replaced pending row is counted for the merge receipt');
      assert.equal(resumed.mergedPending.includes(closedLinkedIn), false);
      assert.deepEqual(resumed.keep, [unrelated]);

      // A verified pending copy needs a verified replacement, so an unchecked open copy cannot downgrade it.
      const officialClosed = closedRow({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/31', officialPosting: posting() });
      assert.deepEqual(sourcesOf(mergeResolvedSourceItems([officialClosed], [openIndeed], 'indeed')), ['linkedin(closed)']);

      // The other arrival order: a pending open copy keeps the posting, the closed copy is the duplicate.
      const lateClosed = mergeResolvedSourceItems([openIndeed], [closedLinkedIn], 'linkedin');
      assert.deepEqual(sourcesOf(lateClosed), ['indeed']);
      assert.deepEqual(lateClosed.fresh, []); assert.equal(lateClosed.replacedExisting, 0);

      // Closed meets closed: the pending copy stays, as before.
      const secondClosed = closedRow({ source: 'ziprecruiter', url: 'https://www.ziprecruiter.com/jobs/31', boardClosed: marker('ziprecruiter', 'detail-page-not-found') });
      assert.deepEqual(mergeResolvedSourceItems([closedLinkedIn], [secondClosed], 'ziprecruiter').mergedPending, [closedLinkedIn]);

      // A different posting never displaces a pending closed row, and an open incoming row with no closed twin changes nothing.
      const otherPosting = row({ source: 'indeed', title: 'Data Engineer', company: 'Contoso Systems', url: 'https://www.indeed.com/viewjob?jk=32', jobkey: '32' });
      const distinct = mergeResolvedSourceItems([closedLinkedIn], [otherPosting], 'indeed');
      assert.deepEqual(distinct.mergedPending, [closedLinkedIn, otherPosting]); assert.equal(distinct.replacedExisting, 0);

      // The exact-retry path still replaces a same-source board-closed row in place, and removal keys still apply.
      const closedIndeed = closedRow({ source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=31', jobkey: '31', boardClosed: marker('indeed', 'indeed-job-unavailable') });
      const retried = mergeResolvedSourceItems([closedIndeed, unrelated], [{ ...closedIndeed, snippet: longText('Recovered') }], 'indeed', { replaceMatchingItems: true });
      assert.equal(retried.mergedPending.length, 2); assert.equal(retried.replacedExisting, 1);
      assert.equal(retried.mergedPending.find(job => job.source === 'indeed').snippet, longText('Recovered'));
      const removed = mergeResolvedSourceItems([closedIndeed, unrelated], [], 'indeed', { removedItemKeys: [sourceJobKey(closedIndeed)] });
      assert.deepEqual(removed.mergedPending, [unrelated]);

      // The same listing seen open again from the same board (no exact-retry flag) also replaces the pending closed copy.
      const reopened = mergeResolvedSourceItems([closedIndeed, unrelated], [row({ source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=31', jobkey: '31' })], 'indeed');
      assert.deepEqual(sourcesOf(reopened), ['remoteok', 'indeed']);

      // Inputs are not mutated.
      const pending = [closedLinkedIn, unrelated];
      mergeResolvedSourceItems(pending, [openIndeed], 'indeed');
      assert.deepEqual(pending, [closedLinkedIn, unrelated]);
    },
  },

  {
    name: 'Amendment 4 renderer merge never supplants a pending row with a dropped ghost representative',
    run() {
      for (const incomingLocation of ['Lakeview, Ontario, Canada', '']) {
        const base = { source: 'linkedin', title: 'Platform Analyst', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada' };
        const first = row({ ...base, url: 'https://www.linkedin.com/jobs/view/2001', snippet: longText('Revision Alpha') });
        const closed = closedRow({ ...base, url: 'https://www.linkedin.com/jobs/view/2002', snippet: longText('Revision Beta') });
        const incoming = row({ ...base, source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=ghost', jobkey: 'ghost',
          location: incomingLocation, snippet: closed.snippet });
        const previous = [first, closed]; const fresh = [incoming]; const before = JSON.stringify({ previous, fresh });
        assert.deepEqual(dedupJobsAcrossSources(previous), previous, 'different concurrent requisitions on the same board survive');
        const merged = mergeResolvedSourceItems(previous, fresh, 'indeed');
        assert.deepEqual(merged.keep, previous, 'the lost incoming copy cannot supplant the closed pending requisition');
        assert.deepEqual(merged.fresh, []); assert.deepEqual(merged.mergedPending, previous); assert.equal(merged.replacedExisting, 0);
        assert.equal(JSON.stringify({ previous, fresh }), before, 'inputs are unchanged');
      }
    },
  },
  {
    name: 'Amendment 4 renderer merge protects every verified pending closed level from an unchecked or missed open copy',
    run() {
      for (const level of ['L1', 'L2', 'L3', 'L4']) for (const incomingPosting of [undefined, miss(['bridge-unavailable']), miss(['bridge-research'])]) {
        const closed = closedRow({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/31',
          officialPosting: posting({ level, outcome: level === 'L4' ? 'link-only' : 'found' }) });
        const incoming = row({ source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=31', jobkey: '31', officialPosting: incomingPosting });
        const merged = mergeResolvedSourceItems([closed], [incoming], 'indeed');
        assert.deepEqual(merged.keep, [closed], `${level} verified pending copy survives an unverified open copy`);
        assert.deepEqual(merged.fresh, []); assert.equal(merged.replacedExisting, 0);
        const verified = { ...incoming, officialPosting: posting() };
        assert.deepEqual(mergeResolvedSourceItems([closed], [verified], 'indeed').mergedPending, [verified], 'a verified open copy can replace it');
      }
    },
  },

  // ── Keep or drop after resolution (spec section 4) ───────────────────────
  {
    name: 'board-closed keep/drop: L1-L3 keep; no description drops; a description drops only after settled research',
    async run() {
      const withPosting = (job, officialPosting) => ({ ...job, officialPosting });
      // L1-L3 with a live official posting: KEEP, even with no scraped description.
      for (const level of ['L1', 'L2', 'L3']) {
        const bare = withPosting(closedRow({ snippet: '' }), posting({ level }));
        const result = await settle([bare]);
        assert.deepEqual(result.kept, [bare], level); assert.equal(result.dispositions.get(bare), BOARD_CLOSED_DISPOSITIONS.keptOfficial);
      }
      // ... and keep with a description whose official text was not needed.
      const described = withPosting(closedRow(), posting({ level: 'L3' }));
      assert.equal((await settle([described], async () => { throw new Error('view not needed'); })).dispositions.get(described), 'kept-official');
      // Official text that cannot serve as evidence (missing, short, unchanged scraped text) is not evidence.
      const bare = withPosting(closedRow({ snippet: '' }), posting());
      for (const view of [async () => { throw new Error('store down'); }, viewOf('short'), async job => ({ ...(await viewOf(longText('x'))(job)), officialPosting: posting({ trail: ['official-text-missing'] }) }),
        async job => ({ ...(await viewOf(longText('x'))(job)), officialPosting: posting({ level: 'L4', outcome: 'link-only' }) })]) {
        const result = await settle([bare], view);
        assert.equal(result.kept.length, 0); assert.equal(result.dropped[0].disposition, BOARD_CLOSED_DISPOSITIONS.droppedNoDescription);
      }
      assert.equal((await settle([bare], null)).dropped.length, 1, 'no view reader: no official evidence');

      // No score-safe scraped description and no live official text: DROP as today, whatever the resolver said.
      for (const outcome of [undefined, miss(['bridge-research']), miss(['bridge-unavailable']), miss(['bridge-timeout']), miss([], { outcome: 'failed' }),
        miss(['bridge-research', 'ambiguous'], { outcome: 'ambiguous' }), posting({ level: 'L4', outcome: 'link-only' })]) {
        const result = await settle([withPosting(closedRow({ snippet: '' }), outcome)]);
        assert.equal(result.kept.length, 0, JSON.stringify(outcome)); assert.equal(result.dropped[0].disposition, 'dropped-no-description');
      }
      assert.equal((await settle([withPosting(closedRow({ snippet: 'short stub', descriptionDeferredReason: 'indeed-job-unavailable' }), miss(['bridge-unavailable']))])).dropped.length, 1,
        'a deferral marker means no score-safe description');

      // A description (the LinkedIn case): DROP only on a settled research conclusion.
      for (const settled of [miss(['bridge-research']), miss(['bridge-research', 'no-anchor'], { outcome: 'not-found' }),
        miss(['bridge-research', 'ambiguous'], { outcome: 'ambiguous' }), miss(['recent-miss', 'bridge-research']), miss(['closed'], { outcome: 'closed' }),
        miss(['title-mismatch'], { outcome: 'closed' }), { ...miss(['bridge-research']), level: 'L6', employer: '' }]) {
        const result = await settle([withPosting(closedRow(), settled)]);
        assert.equal(result.kept.length, 0, JSON.stringify(settled)); assert.equal(result.dropped[0].disposition, BOARD_CLOSED_DISPOSITIONS.droppedSettled);
      }
      // Research that did not run, did not finish or hit a transient failure: KEEP, flagged, unchecked.
      for (const unsettled of [undefined, miss(['bridge-unavailable']), miss(['bridge-timeout']), miss(['bridge-aborted']), miss(['crawl-budget']),
        miss(['bridge-research', 'research-miss']), miss(['bridge-research', 'bridge-timeout']), miss(['bridge-research', 'fetch-failed']),
        miss(['bridge-research', 'fetch-timeout']), miss([], { outcome: 'failed' }), miss(['bridge-research'], { outcome: 'unreadable' }),
        miss(['no-anchor'])]) {
        const input = withPosting(closedRow(), unsettled);
        const result = await settle([input]);
        assert.deepEqual(result.kept, [input], JSON.stringify(unsettled)); assert.equal(result.dispositions.get(input), BOARD_CLOSED_DISPOSITIONS.keptUnchecked);
      }
      // L4 (a live official link, text unreadable) beside a description: the posting is live, so it is kept as official.
      const l4 = withPosting(closedRow(), posting({ level: 'L4', outcome: 'link-only' }));
      assert.equal((await settle([l4])).dispositions.get(l4), 'kept-official');

      // Unflagged rows pass through untouched and are never counted.
      const plain = withPosting(row({ snippet: '' }), miss(['bridge-research']));
      const mixed = await settle([plain, withPosting(closedRow({ snippet: '' }), miss(['bridge-research']))]);
      assert.deepEqual(mixed.kept, [plain]); assert.equal(mixed.dispositions.size, 0);
    },
  },
  {
    name: 'board-closed settled-research rule agrees with the resolver durable-miss rule for every trail code',
    run() {
      for (const code of OFFICIAL_POSTING_TRAIL) {
        for (const outcome of ['not-found', 'ambiguous', 'closed', 'unreadable', 'failed']) {
          for (const trail of [[code], ['bridge-research', code]]) {
            const candidate = miss(trail, { outcome });
            const expected = !['unreadable', 'failed'].includes(outcome)
              && shouldPersistOfficialPostingResult(candidate, { researchRan: false })
              // A5 records a completed comparison directly, even without a
              // separate research marker. Invalid or unavailable runs still
              // fail the resolver durability check above.
              && (outcome === 'closed' || trail.includes('bridge-research')
                || trail.includes('comparative-none') || trail.includes('comparative-disagree'));
            assert.equal(officialResearchSettled(normalizeOfficialPosting(candidate)), expected, `${outcome} ${trail}`);
          }
        }
      }
      assert.equal(officialResearchSettled(normalizeOfficialPosting(posting())), false, 'a found posting is not a miss');
      assert.equal(officialResearchSettled(null), false);
    },
  },

  // ── Telemetry ────────────────────────────────────────────────────────────
  {
    name: 'board-closed telemetry: counts per source board, funnel conservation, receipts and the report carry counts only',
    async run() {
      const rows = [
        { ...closedRow({ title: 'A', snippet: '' }), boardClosed: marker('ziprecruiter', 'detail-page-not-found'), officialPosting: posting() },
        { ...closedRow({ title: 'B', snippet: '' }), boardClosed: marker('ziprecruiter', 'detail-page-not-found'), officialPosting: miss(['bridge-research']) },
        { ...closedRow({ title: 'C' }), officialPosting: miss(['bridge-unavailable']) },
        { ...closedRow({ title: 'D' }), officialPosting: miss(['bridge-research']) },
        { ...closedRow({ title: 'E', snippet: '' }), boardClosed: marker('indeed', 'indeed-job-unavailable'), officialPosting: undefined },
        row({ title: 'Open' }),
      ];
      const settled = await settle(rows);
      const duplicate = { dropped: { ...closedRow({ title: 'F' }) }, kept: rows[5] };
      const block = boardClosedTelemetryBlock({ input: [...rows, duplicate.dropped], settled, officialDedupDrops: [duplicate] });
      assert.deepEqual(block, {
        ziprecruiter: { detected: 2, keptOfficial: 1, keptUnchecked: 0, dropped: 1 },
        linkedin: { detected: 3, keptOfficial: 0, keptUnchecked: 1, dropped: 2 },
        indeed: { detected: 1, keptOfficial: 0, keptUnchecked: 0, dropped: 1 },
      });
      assert.deepEqual(mergeBoardClosedTelemetry(block, block, null, 'x', { 'bad key': { detected: 9 }, linkedin: { detected: 1.9, dropped: -4, junk: 7 } }).linkedin,
        { detected: 7, keptOfficial: 0, keptUnchecked: 2, dropped: 4 });
      const merged = mergeOfficialPostingTelemetry({ total: 1, levels: { L2: 1 } }, { boardClosed: block }, { boardClosed: block });
      assert.equal(merged.boardClosed.linkedin.detected, 6); assert.equal(merged.total, 1);
      assert.equal(Object.hasOwn(mergeOfficialPostingTelemetry({ total: 1 }, { total: 2 }), 'boardClosed'), false, 'a pass without any keeps its historical shape');
      assert.equal(JSON.stringify(block).includes('Platform'), false, 'counts only: no titles');

      // Funnel: the evidence gate drop is re-added when set aside, then removed by the pass that kept nothing.
      const funnel = { raw: 10, deduped: 10, ageDropped: 0, roleDropped: 0, historyDropped: 0, descriptionEvidenceDropped: { total: 3 },
        boardClosedSetAside: 3, finalDedupDropped: 1, officialDedupDropped: 0, boardClosedDropped: 2, kept: 7 };
      const reconciled = reconcileSearchFunnel(funnel);
      assert.equal(reconciled.reconciled, true); assert.equal(reconciled.expectedKept, 7);
      assert.equal(reconciled.boardClosedSetAside, 3); assert.equal(reconciled.boardClosedDropped, 2);
      assert.equal(reconcileSearchFunnel({ ...funnel, boardClosedDropped: 0 }).reconciled, false, 'a drop the funnel cannot attribute still trips the integrity warning');
      assert.equal(Object.hasOwn(reconcileSearchFunnel({ raw: 2, deduped: 2, kept: 2 }), 'boardClosedSetAside'), false);
      const receipt = sanitizeLastRunReceipt({ runId: 'synthetic-board-closed-run', completedAt: Date.now(), terminal: { status: 'completed', outcome: 'populated' },
        funnel: { ...funnel, descriptionEvidenceDropped: 3 },
        sources: { ziprecruiter: { count: 4, providerGathered: 4, boardClosedDetailKept: 2, unavailableDetailDropped: 1 } } });
      assert.equal(receipt.funnel.boardClosedSetAside, 3); assert.equal(receipt.funnel.boardClosedDropped, 2);
      assert.equal(receipt.sources.ziprecruiter.boardClosedDetailKept, 2); assert.equal(receipt.sources.ziprecruiter.unavailableDetailDropped, 1);
      assert.equal(Object.hasOwn(sanitizeLastRunReceipt({ runId: 'synthetic-plain', completedAt: Date.now(), terminal: { status: 'completed', outcome: 'zero' },
        funnel: { raw: 0, deduped: 0, kept: 0 } }).funnel, 'boardClosedSetAside'), false);
    },
  },

  // ── Display ──────────────────────────────────────────────────────────────
  {
    name: 'board-closed display: open-on-official-site, not-checked and settled labels with the board name',
    run() {
      const display = job => officialPostingDisplay({ title: 'Platform Engineer', company: 'Northwind Labs', url: 'https://listing.example.test/p', ...job });
      for (const [board, label] of [['linkedin', 'LinkedIn'], ['indeed', 'Indeed'], ['ziprecruiter', 'ZipRecruiter'], ['glassdoor', 'Glassdoor'], ['dice', 'Dice']]) {
        for (const level of ['L1', 'L2', 'L3']) {
          assert.equal(display({ boardClosed: marker(board, 'detail-page-not-found'), officialPosting: posting({ level }) }).statusLabel,
            `Closed on ${label} · open on official site`, `${board} ${level}`);
        }
        assert.equal(display({ boardClosed: marker(board, 'detail-page-not-found'), officialPosting: miss(['bridge-unavailable']) }).statusLabel,
          `Closed on ${label} · official posting not checked`);
      }
      assert.equal(display({ boardClosed: marker() }).statusLabel, 'Closed on LinkedIn · official posting not checked', 'no resolution at all');
      assert.equal(display({ boardClosed: marker(), officialPosting: miss([], { outcome: 'failed' }) }).statusLabel, 'Closed on LinkedIn · official posting not checked', 'a failure label does not stack');
      // An L6 poster keeps its own label in front.
      assert.equal(display({ boardClosed: marker(), officialPosting: { ...miss(['bridge-unavailable']), level: 'L6', employer: '' } }).statusLabel,
        'poster, employer unknown · Closed on LinkedIn · official posting not checked');
      // Settled after a later Generate-time check: say what is known, not "not checked".
      assert.equal(display({ boardClosed: marker(), officialPosting: miss(['bridge-research']) }).statusLabel, 'Closed on LinkedIn');
      assert.equal(display({ boardClosed: marker(), officialPosting: miss(['bridge-research'], { outcome: 'closed' }) }).statusLabel, 'Closed on LinkedIn · Official posting closed');
      // Unflagged and invalid markers change nothing; the link logic is untouched.
      assert.equal(display({ officialPosting: miss(['bridge-research']) }).statusLabel, '');
      assert.equal(display({ boardClosed: { board: 'linkedin' }, officialPosting: posting() }).statusLabel, '');
      assert.equal(display({ boardClosed: marker(), officialPosting: posting() }).applyUrl, display({ officialPosting: posting() }).applyUrl);
      assert.equal(display({ boardClosed: marker(), officialPosting: posting() }).levelLabel, 'ATS linked from careers page');
    },
  },

  // ── Incremental retire semantics ─────────────────────────────────────────
  {
    name: 'board-closed retirement: a kept row is not removed, an unresolved description-less row is, legacy retired markers still retire',
    async run() {
      const keptL2 = { ...closedRow({ title: 'Kept L2', snippet: '', descriptionDeferredReason: 'indeed-job-unavailable', source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=2' }), officialPosting: posting() };
      const unresolved = closedRow({ title: 'Unresolved', snippet: '', descriptionDeferredReason: 'indeed-page-unavailable', source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=3' });
      const legacy = row({ title: 'Legacy', snippet: '', descriptionDeferredReason: 'indeed-job-unavailable', source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=4' });
      const throttled = row({ title: 'Throttled', snippet: '', descriptionDeferredReason: 'description-rate-limited', source: 'indeed', url: 'https://www.indeed.com/viewjob?jk=5' });
      const described = { ...closedRow({ title: 'Described', source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/6' }), officialPosting: miss(['bridge-research']) };
      const settled = await settle([keptL2, unresolved, described]);
      const resolution = { jobs: settled.kept, boardClosedDrops: settled.dropped.map(entry => ({ kept: null, dropped: entry.row })) };
      const outcome = boardClosedRetirement(resolution);
      assert.deepEqual([...outcome.keptKeys], [sourceJobKey(keptL2)]);
      const dropped = [keptL2, unresolved, legacy, throttled];
      assert.equal(retiredListingKeys(dropped).includes(sourceJobKey(keptL2)), true, 'control: the old rule retires every marked row');
      const removed = retiredListingKeys(dropped, outcome);
      assert.equal(removed.includes(sourceJobKey(keptL2)), false, 'an L2 board-closed row is kept, so it is not retired');
      assert.equal(removed.includes(sourceJobKey(unresolved)), true, 'an unresolved description-less one is');
      assert.equal(removed.includes(sourceJobKey(legacy)), true, 'a pre-flag retired marker keeps retiring');
      assert.equal(removed.includes(sourceJobKey(throttled)), false, 'a throttled row is still never retired');
      assert.equal(removed.includes(sourceJobKey(described)), true, 'a described row the pass dropped after settled research retires too');
      assert.equal(new Set(removed).size, removed.length);
      assert.deepEqual(retiredListingKeys([legacy, throttled]), [sourceJobKey(legacy)]);
      assert.deepEqual(boardClosedRetirement(null), { keptKeys: new Set(), droppedKeys: [] });
    },
  },
  {
    name: 'board-closed recovery pass: a dropped board-closed row is receipted like a dedup loser and survives repeated passes',
    async run() {
      const keep = { ...closedRow({ title: 'Kept One', snippet: '' }), officialPosting: posting() };
      const gone = closedRow({ title: 'Gone One', snippet: '' });
      const open = row({ title: 'Open One' });
      let calls = 0;
      const resolver = createOfficialPostingRecoveryPassResolver(async rows => {
        calls += 1;
        const dropped = rows.filter(job => job.title === 'Gone One').map(job => ({ kept: null, dropped: job, reason: 'dropped-no-description', stage: 'board-closed' }));
        return { jobs: rows.filter(job => job.title !== 'Gone One').map(job => job.title === 'Kept One' ? keep : job),
          officialPosting: { total: rows.length, boardClosed: { linkedin: { detected: 2, keptOfficial: 1, keptUnchecked: 0, dropped: 1 } } },
          officialDedupDropped: 0, officialDedupDrops: [], boardClosedDropped: dropped.length, boardClosedDrops: dropped };
      });
      const first = await resolver([closedRow({ title: 'Kept One', snippet: '' }), gone, open]);
      assert.deepEqual(first.jobs.map(job => job.title).sort(), ['Kept One', 'Open One']);
      assert.equal(first.boardClosedDropped, 1); assert.equal(first.boardClosedDrops[0].dropped, gone);
      assert.equal(first.officialPosting.boardClosed.linkedin.detected, 2);
      // The same inputs again (the reply after the checkpoint) reuse the receipts: no second resolution, same drop.
      const second = await resolver([closedRow({ title: 'Kept One', snippet: '' }), gone, open]);
      assert.equal(calls, 1);
      assert.deepEqual(second.jobs.map(job => job.title).sort(), ['Kept One', 'Open One']);
      assert.equal(second.boardClosedDropped, 1);
      await assert.rejects(createOfficialPostingRecoveryPassResolver(async rows => ({ jobs: rows.slice(1), officialPosting: null, officialDedupDropped: 0,
        officialDedupDrops: [], boardClosedDropped: 0, boardClosedDrops: [] }))([open, row({ title: 'Lost' })]), /omitted an input identity/u);
      await assert.rejects(createOfficialPostingRecoveryPassResolver(async () => ({ jobs: [], officialPosting: null, officialDedupDropped: 0,
        officialDedupDrops: [], boardClosedDropped: 2, boardClosedDrops: [] }))([open]), /board-closed receipt/u);
    },
  },

  // ── Every score-safe path ────────────────────────────────────────────────
  {
    name: 'board-closed pipeline wiring: every score-safe path hands set-aside rows to the resolver boundary',
    run() {
      const source = read('electron/ipc/jobs.js');
      const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
      const main = block("handleSafe('search-jobs',", "handleSafe('peek-job-run',");
      assert.ok(main.indexOf('const boardClosedAside = boardClosedSetAside(descriptionEvidence);') > main.indexOf('const descriptionEvidence = filterJobsByDescriptionEvidence(kept);'));
      assert.ok(main.indexOf('kept = preferOpenRows([...kept, ...boardClosedAside]);') < main.indexOf('const finalDeduped = dedupByTitleCompany(kept'));
      assert.ok(main.indexOf('const finalDeduped = dedupByTitleCompany(kept') < main.indexOf('await resolveScoreSafePostings(kept,'));
      assert.match(main, /dedupByTitleCompany\(preferOpenRows\(platformCap\.jobs\)/u, 'the admission dedup also prefers open rows');
      assert.match(main, /\? \{ boardClosedSetAside: boardClosedAside\.length, boardClosedDropped \}/u);
      const single = block("handleSafe('search-jobs-single-source',", "handleSafe('prepare-board-jobs-history',");
      assert.match(single, /kept = scoreSafeRowsWithBoardClosed\(descriptionEvidence\);/u);
      assert.match(single, /await resolveScoreSafePostings\(kept,/u);
      const linked = block('const isLinkedInReEnrich =', "// Use the source's ordinary list extractor");
      assert.match(linked, /resolveScoreSafePostings\(\s*scoreSafeRowsWithBoardClosed\(filterJobsByDescriptionEvidence\(overlayResolvedRecoveryRows\(rows, snapshotRecoveryJobs\)\)\)/u);
      const generic = block('const runGenericResolve = async () =>', "checkpointContinuationBeforeReply('resolve-job-source')");
      assert.equal([...generic.matchAll(/scoreSafeRowsWithBoardClosed\(/gu)].length, 2, 'snapshot persistence and the final reply');
      assert.match(generic, /descriptionEvidence\.dropped\.filter\(job => !isBoardClosedRow\(job\)\)/u, 'terminal rows never read as "still lack a description"');
      const indeed = block("handleSafe('resume-job-source',", "checkpointContinuationBeforeReply('resume-job-source')");
      assert.equal([...indeed.matchAll(/await resolveScoreSafePostings\(scoreSafeRowsWithBoardClosed\(descriptionEvidence\),/gu)].length, 2, 'retry-descriptions and native resume');
      assert.match(indeed, /\]\.filter\(key => key && !boardClosedOutcome\.keptKeys\.has\(key\)\)\)\]/u);
      // The resolver boundary settles every board-closed row, including the failure path.
      const boundary = block('const settleBoardClosed = async', 'void pruneStaleUnsavedAnalysisArtifacts();');
      assert.equal([...boundary.matchAll(/await settleBoardClosed\(/gu)].length, 2);
      assert.match(boundary, /const settled = await settleBoardClosed\(deduped\.kept, signal\);/u);
      // Description-recovery bookkeeping treats a board-closed row as terminal.
      assert.match(source, /emptyRows: evidence\.dropped\.filter\(job => job\?\.source === sourceId && !isBoardClosedRow\(job\)\)/u);
      assert.match(source, /filterJobsByDescriptionEvidence\(sourceRecovery\)\.dropped\.filter\(job => !isBoardClosedRow\(job\)\)/u);
    },
  },
];

// ── Handler-level tests ─────────────────────────────────────────────────────
// They share the synthetic search harness below (function declarations hoist).
const handlerTests = [];

async function withSearchHarness(run) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-board-closed-'));
  const canvasFilePath = path.join(directory, 'canvas.json');
  try {
    await fs.promises.writeFile(canvasFilePath, '{}');
    const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
    await run({ directory, canvasFilePath, careerSnapshotId });
  } finally {
    registerJobsHandlers();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function runSearch({ canvasFilePath, careerSnapshotId, nodeId, rows, resolveOfficialPostings, getOfficialPostingView, extraDependencies = {} }) {
  const authority = await claimJobAnalysisOperationAuthority({ canvasFilePath, hubId: nodeId, operationId: `op-${nodeId}`,
    semanticBase: { kind: 'search', careerSnapshotId, runId: null, fingerprint: `synthetic-${nodeId}`,
      analysisRevisionId: null, continuationId: null, sourceArtifactFingerprint: null } });
  assert.equal(authority.admitted, true);
  const bySource = new Map();
  for (const job of rows) bySource.set(job.source, [...(bySource.get(job.source) || []), job]);
  const calls = [];
  __registerJobsHandlersForTests({
    resolveRequiredPinnedCareerInput: async () => ({ profile: {}, careerData: '', pinned: true }),
    fetchHttpSources: async (...args) => {
      const results = [];
      for (const [sourceId, jobs] of bySource) {
        await args[10](sourceId);
        const result = { sourceId, jobs, gathered: jobs.length };
        await args[11](sourceId, result);
        await args[8]({ sourceId, query: 'platform engineer', page: 1, jobs });
        results.push(result);
      }
      return results;
    },
    resolveOfficialPostings: async (jobs, options) => { calls.push(jobs); return resolveOfficialPostings(jobs, options); },
    getOfficialPostingView,
    ...extraDependencies,
  });
  const sender = { id: 71933, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} };
  const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender }, {
    queries: ['platform engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
    enabledSourceIds: [...bySource.keys()], targetRole: '', preferredLocation: '',
  });
  return { result, calls, authority };
}

handlerTests.push(
  {
    name: 'board-closed pipeline: set-aside rows merge into the final dedup and resolver, then keep or drop by rule, and the funnel reconciles',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const nodeId = 'board-closed-search-hub';
        const rows = [
          row({ title: 'Platform Engineer', company: 'Northwind Labs' }),
          closedRow({ title: 'Data Engineer', company: 'Contoso Systems', snippet: '', boardClosed: marker('ziprecruiter', 'detail-page-not-found'), url: 'https://www.ziprecruiter.com/jobs/data' }),
          closedRow({ title: 'Support Engineer', company: 'Fabrikam Cloud', snippet: '', boardClosed: marker('ziprecruiter', 'ziprecruiter-closed-job-redirect'), url: 'https://www.ziprecruiter.com/jobs/support' }),
          closedRow({ title: 'QA Engineer', company: 'Adventure Works', snippet: '', boardClosed: marker('indeed', 'indeed-job-unavailable'), url: 'https://www.indeed.com/viewjob?jk=qa' }),
          closedRow({ title: 'Site Reliability Engineer', company: 'Tailspin Works', url: 'https://www.linkedin.com/jobs/view/sre' }),
          closedRow({ title: 'Security Engineer', company: 'Litware Group', url: 'https://www.linkedin.com/jobs/view/sec' }),
        ];
        const bridgeUp = ['Support Engineer', 'Security Engineer', 'Platform Engineer'];
        const { result, calls } = await runSearch({
          canvasFilePath, careerSnapshotId, nodeId, rows,
          getOfficialPostingView: viewOf(longText('Official Northwind posting')),
          resolveOfficialPostings: async jobs => ({
            jobs: jobs.map(job => ({ ...job, officialPosting: job.title === 'Data Engineer' ? posting({ employer: 'Contoso Systems', title: 'Data Engineer' })
              : miss(bridgeUp.includes(job.title) ? ['bridge-research'] : ['bridge-unavailable'], { employer: job.company }) })),
            telemetry: { total: jobs.length, levels: { L2: 1, L5: jobs.length - 1 }, outcomes: { found: 1, 'not-found': jobs.length - 1 } },
          }),
        });
        assert.equal(result.success, true, result.error);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].length, 6, 'the resolver received the score-safe rows AND the three set-aside description-less board-closed rows');
        assert.deepEqual(calls[0].slice(-3).map(job => job.title).sort(), ['Data Engineer', 'QA Engineer', 'Support Engineer'], 'set-aside rows follow the open rows');
        const titles = result.jobs.map(job => job.title).sort();
        // Platform: open. Data: L2 official text. SRE: described, bridge down -> kept unchecked.
        // Support/QA: no description, no official text -> gone as before. Security: described, settled miss -> gone.
        assert.deepEqual(titles, ['Data Engineer', 'Platform Engineer', 'Site Reliability Engineer']);
        const byTitle = Object.fromEntries(result.jobs.map(job => [job.title, job]));
        assert.equal(byTitle['Data Engineer'].officialPosting.level, 'L2'); assert.equal(byTitle['Data Engineer'].snippet, '', 'identity and scraped text are never rewritten');
        assert.equal(byTitle['Data Engineer'].boardClosed.board, 'ziprecruiter');
        assert.equal(byTitle['Site Reliability Engineer'].boardClosed.board, 'linkedin');
        assert.equal(byTitle['Platform Engineer'].boardClosed, undefined);

        const search = getJobsTelemetry().search;
        assert.equal(search.descriptionEvidenceDropped.total, 3, 'the evidence gate bookkeeping is unchanged');
        assert.equal(search.boardClosedSetAside, 3); assert.equal(search.boardClosedDropped, 3);
        assert.equal(search.kept, 3);
        assert.equal(search.reconciliation.reconciled, true, JSON.stringify(search.reconciliation));
        assert.deepEqual(search.officialPosting.boardClosed, {
          ziprecruiter: { detected: 2, keptOfficial: 1, keptUnchecked: 0, dropped: 1 },
          indeed: { detected: 1, keptOfficial: 0, keptUnchecked: 0, dropped: 1 },
          linkedin: { detected: 2, keptOfficial: 0, keptUnchecked: 1, dropped: 1 },
        });
        const state = await readRunState(canvasFilePath, Date.now(), { nodeId });
        const staged = state.stagedJobs.map(entry => entry.job?.title);
        assert.ok(staged.includes('Data Engineer') && staged.includes('Site Reliability Engineer'), 'kept board-closed rows reach the durable checkpoint');

        // The bug report states the stages and counts, never a listing.
        const report = buildJobsPipelineSnapshot(new Set([nodeId]), null, null);
        assert.match(report, /board-closed-rescued: 3/u); assert.match(report, /board-closed-dropped: 3/u);
        assert.match(report, /Board-closed listings[^\n]*`ziprecruiter` detected 2 · kept \(official\) 1 · kept \(official posting not checked\) 0 · dropped 1/u);
        assert.match(report, /`linkedin` detected 2 · kept \(official\) 0 · kept \(official posting not checked\) 1 · dropped 1/u);
        assert.equal(report.includes('Contoso Systems') || report.includes('Litware Group'), false);
      });
    },
  },
  {
    name: 'board-closed pipeline: an open copy beats a closed copy of the same posting at both dedup stages, and resolver failure follows the unresolved rule',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const nodeId = 'board-closed-dedup-hub';
        const rows = [
          closedRow({ source: 'weworkremotely', title: 'Platform Engineer', company: 'Northwind Labs', url: 'https://weworkremotely.example.test/closed' }),
          row({ source: 'remoteok', title: 'Platform Engineer', company: 'Northwind Labs', url: 'https://remoteok.example.test/open' }),
          closedRow({ source: 'weworkremotely', title: 'Cloud Engineer', company: 'Fabrikam Cloud', snippet: '', url: 'https://weworkremotely.example.test/bare' }),
        ];
        const { result } = await runSearch({
          canvasFilePath, careerSnapshotId, nodeId, rows,
          getOfficialPostingView: viewOf(longText('Official')),
          resolveOfficialPostings: async () => { throw new Error('the resolver is down'); },
        });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(result.jobs.map(job => `${job.source}:${job.title}`), ['remoteok:Platform Engineer'],
          'the open copy survived; the closed duplicate lost the tie; the bare closed row left as before');
        const search = getJobsTelemetry().search;
        assert.equal(search.boardClosedSetAside, 1); assert.equal(search.boardClosedDropped, 1);
        assert.equal(search.reconciliation.reconciled, true, JSON.stringify(search.reconciliation));
        assert.equal(search.officialPosting.failed, 2, 'only the open row and the bare closed row reached the resolver');
        assert.deepEqual(search.officialPosting.boardClosed, { linkedin: { detected: 1, keptOfficial: 0, keptUnchecked: 0, dropped: 1 } },
          'the closed duplicate never reached the resolver boundary; the bare row, resolution failed, is dropped as before');
      });
    },
  },
  {
    name: 'board-closed pipeline: a resolver outage keeps a described board-closed row unchecked, flagged and visible',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const nodeId = 'board-closed-outage-hub';
        const { result } = await runSearch({
          canvasFilePath, careerSnapshotId, nodeId,
          rows: [closedRow({ title: 'Platform Engineer', source: 'remoteok' })],
          getOfficialPostingView: viewOf(longText('Official')),
          resolveOfficialPostings: async () => { throw new Error('the resolver is down'); },
        });
        assert.equal(result.success, true, result.error);
        assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].boardClosed.board, 'linkedin');
        assert.equal(officialPostingDisplay(result.jobs[0]).statusLabel, 'Closed on LinkedIn · official posting not checked');
        assert.deepEqual(getJobsTelemetry().search.officialPosting.boardClosed, { linkedin: { detected: 1, keptOfficial: 0, keptUnchecked: 1, dropped: 0 } });
      });
    },
  },
  {
    name: 'board-closed report: a description retry separates the listings it removed from the board-closed ones it kept',
    run() {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, pipeline: telemetry.pipeline, search: telemetry.search, resolves: telemetry.resolves };
      const nodeId = 'board-closed-report-hub';
      try {
        telemetry.nodeId = nodeId;
        telemetry.pipeline = { phase: 'completed', active: false, startedAt: Date.now() - 5_000, ts: Date.now(), runId: 'board-closed-report-run' };
        telemetry.search = { ts: Date.now() - 4_000, queries: 1, raw: 2, deduped: 2, ageDropped: 0, roleDropped: 0, historyDropped: 0, relevanceDropped: 0, kept: 2,
          runId: 'board-closed-report-run', bySource: { indeed: { count: 2, providerGathered: 2, unavailableDetailDropped: 1, boardClosedDetailKept: 2, stopReason: 'empty-page' } } };
        telemetry.resolves = { indeed: { ts: Date.now() - 3_000, kind: 'description-retry', runId: 'board-closed-report-run',
          attemptedDescriptions: 3, recoveredDescriptions: 0, remainingDescriptions: 0, boardClosedKept: 2,
          unavailableDescriptions: [{ key: 'k1', title: 'Gone Engineer', url: 'https://www.indeed.com/viewjob?jk=gone', reason: 'job-unavailable' }] } };
        const report = buildJobsPipelineSnapshot(new Set([nodeId]), null, null);
        assert.match(report, /\*\*1 unavailable listing\(s\) removed\*\* · 2 board-closed listing\(s\) kept for the official-posting check/u);
        assert.equal(report.includes('Gone Engineer'), false, 'details withheld');
      } finally {
        Object.assign(telemetry, saved);
      }
    },
  },
  {
    name: 'board-closed report: the terminal receipt names the funnel stages and the kept-versus-dropped detail counters',
    run() {
      const telemetry = getJobsTelemetry();
      const savedPipeline = telemetry.pipeline;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-closed-receipt-'));
      const canvas = path.join(directory, 'canvas.json');
      const nodeId = 'board-closed-receipt-hub';
      try {
        telemetry.pipeline = null;
        fs.writeFileSync(path.join(directory, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId: 'board-closed-receipt-run', nodeId, startedAt: 1_700_100_000_000, completedAt: 1_700_100_093_000,
          terminal: { status: 'completed', outcome: 'populated' }, stagingStarted: true, cleanup: { attempted: true, cleared: true },
          funnel: { raw: 13, relevanceDropped: 0, deduped: 13, ageDropped: 0, roleDropped: 0, historyDropped: 0, descriptionEvidenceDropped: 4,
            boardClosedSetAside: 3, boardClosedDropped: 2, kept: 10 },
          sources: { ziprecruiter: { count: 9, providerGathered: 10, unavailableDetailDropped: 1, boardClosedDetailKept: 2, stopReason: 'end-of-results' } },
        }), 'utf8');
        const recovery = buildJobRecoverySnapshot(canvas, new Set([nodeId]));
        assert.match(recovery, /description evidence 4 · board-closed: 3 rescued from the evidence gate for the official-posting check, 2 dropped after it/u);
        assert.match(recovery, /1 confirmed-unavailable detail listing dropped/u);
        assert.match(recovery, /2 board-closed detail listings kept for the official-posting check/u, 'the kept counter stays apart from the dropped one');
      } finally {
        telemetry.pipeline = savedPipeline;
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'board-closed retry-descriptions: the flagged Indeed row is replaced in place when kept, and retired only when the official pass did not keep it',
    async run() {
      await withSearchHarness(async ({ canvasFilePath, careerSnapshotId }) => {
        const nodeId = 'board-closed-retry-hub';
        const seed = await runSearch({
          canvasFilePath, careerSnapshotId, nodeId, rows: [row({ title: 'Seed Engineer', company: 'Seed Co' })],
          getOfficialPostingView: viewOf(longText('Official')),
          resolveOfficialPostings: async jobs => ({ jobs, telemetry: { total: jobs.length } }),
        });
        assert.equal(seed.result.success, true, seed.result.error);
        const indeedRow = (title, key, extra = {}) => ({ source: 'indeed', title, company: `${title} Co`, location: 'Remote', posted: 'today',
          url: `https://www.indeed.com/viewjob?jk=${key}`, jobkey: key, snippet: '', ...extra });
        const keptRow = indeedRow('Kept Engineer', 'keep1');
        const goneRow = indeedRow('Gone Engineer', 'gone1');
        const officialClosed = indeedRow('Employer Closed', 'emp1');
        const flag = job => ({ ...job, descriptionDeferredReason: 'indeed-job-unavailable', boardClosed: marker('indeed', 'indeed-job-unavailable') });
        let retryCalls = 0;
        __registerJobsHandlersForTests({
          resolveRequiredPinnedCareerInput: async () => ({ profile: {}, careerData: '', pinned: true }),
          retryIndeedJobDescriptions: async jobs => {
            retryCalls += 1;
            // The scraper flagged two rows (the employer-host row was retired outright, as before).
            return { jobs: jobs.filter(job => job.title !== 'Employer Closed').map(job => job.title === 'Kept Engineer' || job.title === 'Gone Engineer' ? flag(job) : job),
              attempted: 3, recovered: 0, remaining: 0, challengeReason: null,
              unavailable: jobs.map(job => ({ key: sourceJobKey(job), title: job.title, url: job.url, reason: 'job-unavailable' })) };
          },
          getOfficialPostingView: viewOf(longText('Official Kept posting')),
          resolveOfficialPostings: async jobs => ({
            jobs: jobs.map(job => ({ ...job, officialPosting: job.title === 'Kept Engineer' ? posting({ employer: 'Kept Engineer Co', title: 'Kept Engineer' }) : miss(['bridge-research']) })),
            telemetry: { total: jobs.length },
          }),
        });
        const sender = { id: 71933, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} };
        const reply = await ipcMain.__getInvokeHandler('resume-job-source')({ sender }, {
          sourceId: 'indeed', nodeId, jobRunId: seed.result.runId, canvasFilePath, enabledSourceIds: ['indeed'],
          careerSnapshotId, operationAuthority: seed.authority.receipt,
          resumeState: { mode: 'retry-descriptions', jobs: [keptRow, goneRow, officialClosed] },
        });
        assert.equal(retryCalls, 1);
        assert.equal(reply.resolved, true, JSON.stringify(reply));
        assert.deepEqual(reply.items.map(job => job.title), ['Kept Engineer'], 'the L2 row is replaced in place; the unresolved description-less row is gone');
        assert.equal(reply.items[0].boardClosed.board, 'indeed');
        assert.equal(reply.replaceMatchingItems, true);
        assert.equal(reply.removedItemKeys.includes(sourceJobKey(keptRow)), false, 'an L2 board-closed row is not in removedItemKeys');
        assert.equal(reply.removedItemKeys.includes(sourceJobKey(goneRow)), true, 'an unresolved description-less one is');
        assert.equal(reply.removedItemKeys.includes(sourceJobKey(officialClosed)), true, 'the employer-host verdict retires as before');
        assert.equal(new Set(reply.removedItemKeys).size, reply.removedItemKeys.length);
      });
    },
  },
);

export default [...pureTests, ...handlerTests];
