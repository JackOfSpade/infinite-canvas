// The AI title screen on each results page, before its details are opened
// (electron/ipc/jobs/pageTitleScreen.js, 2026-11-22).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createPageTitleScreen,
  offTargetQueries,
  offTargetQueryWarning,
  partitionByPageTitleScreen,
  suggestQueryRewordings,
  PAGE_TITLE_SCREEN_WAIT_MS,
} from '../../electron/ipc/jobs/pageTitleScreen.js';
import { screenJobRolesByTitle } from '../../electron/ipc/jobPreferences.js';
import { mergeRoleScreenedJobs } from '../../electron/ipc/jobs/sourceRules.js';
import { CLAUDE_TASK_PROFILES } from '../../electron/ipc/claudeTaskProfiles.js';
import { KNOWN_TASKS } from '../../electron/ipc/knownTasks.js';
import { sanitizeLastRunReceipt } from '../../electron/ipc/jobRunStaging.js';
import { offTargetQueryReceiptLines, sourceReceiptWindowParts } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { PAGE_TITLE_SCREEN_FAILURE_BREAKER, offTargetQueryLogLine } from '../../electron/ipc/jobs/pageTitleScreen.js';

const read = rel => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const job = (title, extra = {}) => ({ source: 'glassdoor', title, company: 'Co', url: `https://www.glassdoor.com/job-listing/x?jl=${title.length}`, ...extra });

export default [
  {
    name: 'page title screen: verdicts per row, mismatches skipped, matches stamped, unclear opened unstamped',
    async run() {
      const calls = [];
      const screen = createPageTitleScreen({
        screenTitles: async (jobs, { signal }) => {
          calls.push({ titles: jobs.map(j => j.title), aborted: signal.aborted });
          return { verdictsByIndex: { 0: { outcome: 'match' }, 1: { outcome: 'mismatch', reason: 'mechanical engineering' }, 2: { outcome: 'unclear' } } };
        },
      });
      const forGlassdoor = screen.forSource('glassdoor');
      assert.equal(typeof forGlassdoor, 'function');
      assert.equal(screen.forSource('google'), null, 'Google panels are cheap; not screened');
      const rows = [job('Product Engineer'), job('Mechanical Engineer'), job('Engineer')];
      const handle = forGlassdoor(rows, { query: 'Product Engineer', queryIndex: 0, page: 1 });
      assert.equal(handle.waitMs, PAGE_TITLE_SCREEN_WAIT_MS.glassdoor);
      await handle.wait(handle.waitMs);
      assert.deepEqual([0, 1, 2].map(i => handle.verdictAt(i)), ['match', 'mismatch', 'unclear']);
      const { open, skipped } = partitionByPageTitleScreen(rows, handle);
      assert.deepEqual(skipped.map(j => j.title), ['Mechanical Engineer']);
      assert.deepEqual(open.map(j => j.title), ['Product Engineer', 'Engineer']);
      assert.deepEqual(open[0].roleScreen, { outcome: 'match', reason: '', via: 'page-title' });
      assert.equal(open[1].roleScreen, undefined, 'an unsure row stays unstamped for the post-gather title and snippet passes');
      const stats = screen.stats().glassdoor;
      assert.equal(stats.screened, 3);
      assert.equal(stats.mismatched, 1);
      assert.equal(stats.byQuery['0'].samples[0].reason, 'mechanical engineering');
      // The post-gather screen keeps a stamped row as it is and judges only the rest.
      const merged = mergeRoleScreenedJobs(open, { verdictsByIndex: { 0: { outcome: 'match', reason: '' } } });
      assert.deepEqual(merged.map(j => j.title), ['Product Engineer', 'Engineer']);
    },
  },
  {
    name: 'page title screen fails open: an error or a timeout opens every card on the page',
    async run() {
      const failing = createPageTitleScreen({ screenTitles: async () => { throw new Error('usage limit'); } });
      const handle = failing.forSource('ziprecruiter')([job('A'), job('B')], { query: 'q', queryIndex: 0 });
      await handle.settled;
      assert.deepEqual([handle.verdictAt(0), handle.verdictAt(1)], ['unclear', 'unclear']);
      assert.equal(partitionByPageTitleScreen([job('A'), job('B')], handle).skipped.length, 0);
      assert.equal(failing.stats().ziprecruiter.failedPages, 1);
      // A call that never answers is aborted at the call timeout.
      let sawAbort = false;
      const hanging = createPageTitleScreen({
        callTimeoutMs: 20,
        screenTitles: (_jobs, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { sawAbort = true; reject(signal.reason); });
        }),
      });
      const slow = hanging.forSource('glassdoor')([job('A')], { query: 'q', queryIndex: 0 });
      await slow.settled;
      assert.equal(sawAbort, true);
      assert.equal(slow.verdictAt(0), 'unclear');
      // Indeed never waits; a pending verdict reads as 'pending' and is opened.
      let release;
      const pending = createPageTitleScreen({ screenTitles: () => new Promise(resolve => { release = resolve; }) });
      const indeed = pending.forSource('indeed')([job('A')], { query: 'q', queryIndex: 0 });
      assert.equal(indeed.waitMs, 0);
      assert.equal(indeed.verdictAt(0), 'pending');
      assert.equal(partitionByPageTitleScreen([job('A')], indeed).open.length, 1);
      release({ verdictsByIndex: { 0: { outcome: 'mismatch' } } });
      await indeed.settled;
      assert.equal(indeed.verdictAt(0), 'mismatch', 'a late verdict still removes the row before it is staged');
    },
  },
  {
    name: 'page title screen uses its own task with the batch screen prompt and no snippet pass',
    async run() {
      const seen = [];
      const callText = async (prompt, options) => {
        seen.push({ task: options.task, prompt });
        return { remove: [{ reason: 'trades', indexes: [1] }], unsure: [2] };
      };
      const result = await screenJobRolesByTitle({
        jobs: [job('Product Engineer'), job('Carpenter'), job('Engineer', { snippet: 'x'.repeat(500) })],
        titles: ['Product Engineer'],
        callText,
        titleTask: 'job-role-screen-page',
        snippetPass: false,
      });
      assert.deepEqual(seen.map(s => s.task), ['job-role-screen-page'], 'no snippet call before descriptions exist');
      assert.match(seen[0].prompt, /Screen each job listing TITLE against the user's target job titles/u);
      assert.deepEqual([0, 1, 2].map(i => result.verdictsByIndex[i].outcome), ['match', 'mismatch', 'unclear']);
      assert.deepEqual(CLAUDE_TASK_PROFILES['job-role-screen-page'], CLAUDE_TASK_PROFILES['job-role-screen-batch'],
        'chosen by analogy with the proven batch screen (Haiku low) until a test is asked for');
      assert(KNOWN_TASKS.has('job-role-screen-page') && KNOWN_TASKS.has('job-query-rewording'));
    },
  },
  {
    name: 'off-target queries: flagged at 20+ screened titles and half or more skipped, with an AI rewording',
    async run() {
      const stats = {
        glassdoor: { byQuery: {
          0: { query: 'Product Engineer', queryIndex: 0, screened: 749, mismatched: 468, samples: [{ title: 'Mechanical Engineer', reason: 'mechanical engineering' }] },
          1: { query: 'AI Product Engineer', queryIndex: 1, screened: 561, mismatched: 20, samples: [] },
          2: { query: 'Tiny', queryIndex: 2, screened: 10, mismatched: 10, samples: [] },
        } },
      };
      const flagged = offTargetQueries(stats);
      assert.deepEqual(flagged.map(e => e.query), ['Product Engineer']);
      let task = '';
      const suggested = await suggestQueryRewordings(flagged, {
        targetTitles: ['Product Engineer'],
        callText: async (_prompt, options) => { task = options.task; return { suggestions: [{ index: 0, query: 'software product engineer', why: 'Leaves out hardware.' }] }; },
      });
      assert.equal(task, 'job-query-rewording');
      assert.equal(suggested[0].suggestion, 'software product engineer');
      const warning = offTargetQueryWarning(suggested[0]);
      assert.equal(warning.severity, 'warn', 'a warning, not a block: the jobs found are still kept');
      assert.match(warning.evidence, /On Glassdoor, 62% of the 749 titles found for "Product Engineer" were a different kind of job \(for example Mechanical Engineer\)/u);
      assert.match(warning.suggestion, /Try searching "software product engineer" instead/u);
      // A failed call leaves the entries without a suggestion; the same query is not "suggested".
      const failed = await suggestQueryRewordings(flagged, { targetTitles: [], callText: async () => { throw new Error('x'); } });
      assert.equal(failed[0].suggestion, undefined);
      const same = await suggestQueryRewordings(flagged, { targetTitles: [], callText: async () => ({ suggestions: [{ index: 0, query: 'product engineer', why: '' }] }) });
      assert.equal(same[0].suggestion, undefined);
      assert.match(offTargetQueryWarning(failed[0]).suggestion, /Consider rewording or removing/u);
    },
  },
  {
    name: 'page title screen is wired into the Glassdoor/ZipRecruiter walk and Indeed card loop, and the old trust-the-platform rule is gone',
    run() {
      const manual = read('electron/ipc/browser/manualScraper.js');
      assert(!manual.includes('app must not impose a second exact-ish title admission policy'));
      assert.match(manual, /let jobsToExpand = alreadyRead\.open;[\s\S]{0,400}task\.options\.screenTitles\(jobsToExpand,[\s\S]{0,900}jobsToExpand = screened\.open;[\s\S]{0,600}const walkPlan = buildPhysicalCardWalkPlan\(extracted, jobsToExpand\);/u);
      const indeed = read('electron/extractors/indeedBrowser.js');
      assert(!indeed.includes('Keep every distinct returned row instead of applying a'));
      assert.match(indeed, /if \(skipJob\?\.\(job\)\) continue;/u);
      assert.match(indeed, /enrichWithDescriptions\(page, pageJobs, signal, overlayBase, allJobs\.length, skipByTitle\)/u);
      assert.match(indeed, /partitionByPageTitleScreen\(pageJobs, titleScreen\)[\s\S]{0,400}pageJobs = screened\.open;[\s\S]{0,2500}const pageAdded = \[\];/u);
      const search = read('electron/ipc/jobs/searchHandlers.js');
      assert.match(search, /titleTask: 'job-role-screen-page',\s+snippetPass: false,/u);
      assert.match(search, /result\.preCapRelevanceDropped = \(Number\(result\.preCapRelevanceDropped\) \|\| 0\) \+ mismatched;/u,
        'skipped cards stay in the funnel as relevance drops');
      assert.match(search, /titleScreenBySource\.indeed \|\| null\);/u);
    },
  },
  {
    name: 'page title screen counts a skip only where the walk skipped it; a late verdict is not reported as skipped',
    async run() {
      let release;
      const screen = createPageTitleScreen({ screenTitles: () => new Promise(resolve => { release = resolve; }) });
      const rows = [job('A'), job('B')];
      const handle = screen.forSource('indeed')(rows, { query: 'q', queryIndex: 0 });
      const { open } = partitionByPageTitleScreen(rows, handle);
      assert.equal(open.length, 2);
      release({ verdictsByIndex: { 0: { outcome: 'mismatch' }, 1: { outcome: 'mismatch' } } });
      await handle.settled;
      const stats = screen.stats().indeed;
      assert.equal(stats.mismatched, 0, 'both rows were opened, so nothing was skipped');
      assert.equal(stats.pendingAtOpen, 2);
      assert.equal(stats.screened, 2);
      partitionByPageTitleScreen(rows, handle);
      assert.equal(screen.stats().indeed.screened, 2, 'a page is counted once');
    },
  },
  {
    name: 'page title screen stops waiting after repeated failures and waits again after a success',
    async run() {
      let fail = true;
      const screen = createPageTitleScreen({ screenTitles: async () => { if (fail) throw new Error('usage limit'); return { verdictsByIndex: {} }; } });
      const forZip = screen.forSource('ziprecruiter');
      for (let i = 0; i < PAGE_TITLE_SCREEN_FAILURE_BREAKER; i++) {
        const handle = forZip([job('A')], { query: 'q', queryIndex: 0 });
        assert.equal(handle.waitMs, PAGE_TITLE_SCREEN_WAIT_MS.ziprecruiter);
        await handle.settled;
      }
      fail = false;
      const tripped = forZip([job('A')], { query: 'q', queryIndex: 0 });
      assert.equal(tripped.waitMs, 0, 'a paused or failing AI no longer costs a wait per page');
      await tripped.settled;
      assert.equal(forZip([job('A')], { query: 'q', queryIndex: 0 }).waitMs, PAGE_TITLE_SCREEN_WAIT_MS.ziprecruiter);
    },
  },
  {
    name: 'page title screen stats survive the last-run receipt and reach the bug report; the count is saved with the source',
    run() {
      const receipt = sanitizeLastRunReceipt({
        runId: 'r1', terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 1 },
        sources: { glassdoor: { count: 465, pageTitleScreen: { pages: 40, screened: 942, mismatched: 477, matched: 400, unclear: 65, pendingAtOpen: 0, failedPages: 1, junk: 'x' } } },
      });
      assert.deepEqual(receipt.sources.glassdoor.pageTitleScreen, { pages: 40, screened: 942, mismatched: 477, matched: 400, unclear: 65, pendingAtOpen: 0, failedPages: 1 });
      assert(sourceReceiptWindowParts(receipt.sources.glassdoor).some(part => part.startsWith('page title screen: 477 of 942 card(s) skipped before opening')));
      const staging = read('electron/ipc/jobRunStaging.js');
      assert.match(staging, /if \(titleScreenSkipped !== undefined\) \{/u);
      const search = read('electron/ipc/jobs/searchHandlers.js');
      assert.match(search, /titleScreenSkipped: Math\.max\(0, Math\.floor\(Number\(pageTitleScreen\?\.stats\?\.\(\)\?\.\[sourceId\]\?\.mismatched\) \|\| 0\)\),/u,
        'saved when a platform finishes, so a crash before the end keeps it');
      assert.match(search, /resumedTitleScreenSkipped = Object\.fromEntries/u);
    },
  },
  {
    name: 'off-target query: the receipt keeps slot counts only, the bug report explains them, the warn log line carries the text',
    run() {
      const receipt = sanitizeLastRunReceipt({
        runId: 'r1', terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 1 },
        sources: { glassdoor: { count: 465, pageTitleScreen: {
          pages: 40, screened: 942, mismatched: 477, matched: 400, unclear: 65, pendingAtOpen: 0, failedPages: 0,
          offTargetQueries: [{ queryIndex: 2, screened: 749, mismatched: 464, suggested: true, query: 'Product Engineer' }, { queryIndex: 'x', screened: 0 }],
        } } },
      });
      const kept = receipt.sources.glassdoor.pageTitleScreen.offTargetQueries;
      assert.deepEqual(kept, [{ queryIndex: 2, screened: 749, mismatched: 464, suggested: true }], 'no query text in the receipt');
      const lines = offTargetQueryReceiptLines('glassdoor', receipt.sources.glassdoor);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /off-target search, query slot #3: 464 of 749 screened titles \(62%\)/u);
      assert.match(lines[0], /every results page for this query was still loaded/u);
      assert.match(lines[0], /nothing is applied automatically/u);
      assert.doesNotMatch(lines[0], /Product Engineer/u);
      assert.deepEqual(offTargetQueryReceiptLines('glassdoor', { count: 1 }), [], 'older receipts add nothing');

      const log = offTargetQueryLogLine({
        sourceId: 'glassdoor', query: 'Product Engineer', queryIndex: 2, screened: 749, mismatched: 464,
        samples: [{ title: 'Mechanical Engineer' }, { title: 'Mechanical Engineer' }, { title: 'Civil Engineer' }],
        suggestion: 'Software Product Engineer', why: 'adds software.',
      });
      assert.match(log, /^\[PageTitleScreen\] off-target query on Glassdoor \(query slot #3\): "Product Engineer" - 464 of 749 screened titles \(62%\)/u);
      assert.match(log, /e\.g\. Mechanical Engineer \| Civil Engineer\./u);
      assert.match(log, /still loaded every results page for this query/u);
      assert.match(log, /AI-suggested rewording: "Software Product Engineer" \(adds software\)\./u);
      assert.match(log, /Not applied automatically/u);
      assert.match(offTargetQueryLogLine({ sourceId: 'indeed', query: 'q', screened: 30, mismatched: 20 }), /No rewording was suggested/u);

      const search = read('electron/ipc/jobs/searchHandlers.js');
      assert.match(search, /logger\.warn\(`\[Jobs\]\[\$\{nodeId\}\] \$\{offTargetQueryLogLine\(entry\)\}`\);/u, 'warn level so the line survives a long scrape in the bug report');
      assert.match(read('electron/ipc/bugReport.js'), /\\\[PageTitleScreen\\\] off-target query\|/u, 'not cut at 500 characters');
    },
  },
];
