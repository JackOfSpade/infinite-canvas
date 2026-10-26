import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as indeedBrowser from '../../electron/extractors/indeedBrowser.js';
import * as apiExtractors from '../../electron/extractors/apiExtractors.js';
import * as manualScraper from '../../electron/ipc/browser/manualScraper.js';
import * as calibrationModule from '../../electron/ipc/listingLivenessCalibration.js';
import { getCurrentIpcRequestContext, handleSafe } from '../../electron/ipc/ipcUtils.js';
import { LISTING_LIVENESS_RULES, classifyListingLiveness, evidenceFromHtml, finalizeListingEvidence,
  listingLivenessPageProbe } from '../../electron/ipc/listingLiveness.js';

const SOURCE_ROOT = new URL('../../', import.meta.url);

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing capture boundary: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing capture boundary: ${end}`);
  return source.slice(from, to);
}

function oneDetailNavigation(source) {
  assert.equal((source.match(/\.goto\s*\(/gu) || []).length, 1,
    'a detail capture must reuse its one existing navigation');
}

function inOrder(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const position = source.indexOf(marker, previous + 1);
    assert.ok(position > previous, `capture step is missing or out of order: ${marker}`);
    previous = position;
  }
}

function zipDetailPage({ finalUrl, status, html }) {
  let currentUrl = 'https://www.ziprecruiter.com/jobs/search';
  const virtualConsole = new VirtualConsole();
  let dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only', url: currentUrl, virtualConsole });
  const observed = { navigations: 0, probeArgs: [] };
  const page = {
    browser: () => { throw new Error('synthetic list-page fallback'); },
    url: () => currentUrl,
    goto: async () => {
      dom.window.close();
      currentUrl = finalUrl;
      dom = new JSDOM(html, { runScripts: 'outside-only', url: currentUrl, virtualConsole });
      Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
      observed.navigations += 1;
      return { status: () => status };
    },
    evaluate: async (fn, ...args) => {
      if (fn.name === 'listingLivenessPageProbe') observed.probeArgs.push(args[0]);
      const call = `(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`;
      return dom.window.eval(call);
    },
    waitForFunction: async () => { throw new Error('synthetic carrier timeout'); },
  };
  return { page, observed, close: () => dom.window.close() };
}

export default [
  {
    name: 'listing liveness capture: Indeed detail visits retain one navigation and classify after description',
    async run() {
      const source = await fs.readFile(new URL('electron/extractors/indeedBrowser.js', SOURCE_ROOT), 'utf8');
      const retry = between(source, 'export async function retryIndeedJobDescriptions(', 'export async function runIndeedReEnrichPass(');
      const reEnrich = between(source, 'export async function runIndeedReEnrichPass(', '/**\n * Fetch Indeed job listings');
      for (const visit of [retry, reEnrich]) {
        oneDetailNavigation(visit);
        const challengeStep = '(runtime?.getChallengeSignals || getChallengeSignals)(page)';
        inOrder(visit, [
          'const httpStatus = navigationResponse?.status?.() ?? null',
          challengeStep,
          'indeedStructuralDetail(page, job, jobUrl, httpStatus)',
          'page.$eval(DESC_SELECTOR',
          'captureIndeedListingLiveness(page, job',
        ]);
        assert.match(visit, /if \(structural\.reason\) \{/u);
      }
      assert.match(source, /const structural = await indeedStructuralDetail\(page, job, jobUrl, httpStatus\)/u);
      assert.match(source, /recordListingEvidence\(job, evidence\)/u);
      assert.match(source, /const runReEnrichPass = options => runIndeedReEnrichPass\(page, \{ \.\.\.options, signal, host, officialClosedKeys \}\);/u);
    },
  },
  {
    name: 'listing liveness capture: ZipRecruiter detail keeps its one navigation and removes text-only closure',
    async run() {
      const source = await fs.readFile(new URL('electron/ipc/browser/manualScraper.js', SOURCE_ROOT), 'utf8');
      const detail = between(source, 'async function expandDescriptions(', 'export async function enrichResolvedJobDescriptions(');
      const capture = between(source, 'export async function captureZipRecruiterListingLiveness(', '/** Convert a Retry-After header');
      assert.match(capture, /if \(result\.verdict === 'unknown'\) return row;/u,
        'an unknown visit never enters the stamping branch');
      oneDetailNavigation(detail);
      assert.doesNotMatch(detail, /\bisNotFound\b/u);
      inOrder(detail, [
        'const navigationStatus = navigationResponse?.status?.() ?? null',
        'getChallengeSignals(fetchPage)',
        'if (isUnavailableDetailPage(pageInfo)',
        '// Try JSON-LD JobPosting.description first',
        'enhanced[i] = mergeExpandedJobDetail(job',
        'captureZipRecruiterListingLiveness(fetchPage, enhanced[i]',
      ]);
      assert.match(detail, /recordListingEvidence\(enhanced\[i\], finalizeListingEvidence/u);
    },
  },
  {
    name: 'listing liveness capture: a structural Workday flag on an aggregator writes a paired verdict',
    run() {
      const row = { source: 'indeed', title: 'Synthetic Analyst', jobkey: 'synthetic-workday' };
      assert.equal(indeedBrowser.markIndeedBoardClosed(row, 'workday-posting-unavailable', {
        finalUrl: 'https://www.indeed.com/viewjob?jk=synthetic-workday',
        now: new Date('2026-10-01T00:00:00Z'),
      }), true);
      assert.deepEqual(row.boardClosed, { board: 'indeed', reason: 'workday-posting-unavailable', at: '2026-10-01T00:00:00.000Z' });
      assert.deepEqual(row.listingLiveness, { verdict: 'closed', basis: 'structural', board: 'indeed', at: '2026-10-01T00:00:00.000Z' });
    },
  },
  {
    name: 'listing liveness capture: blank Indeed rows marked pending remain eligible for both re-enrich passes',
    async run() {
      const source = await fs.readFile(new URL('electron/extractors/indeedBrowser.js', SOURCE_ROOT), 'utf8');
      for (const [label, input] of [['fast', 'allJobs'], ['slow', 'missingDescJobs']]) {
        const pattern = new RegExp(`const (?:missingDescJobs|residualDescJobs) = ${input}\\.filter\\(job =>\\s*([^;]+?)\\s*\\);`, 'u');
        const predicate = source.match(pattern)?.[1];
        assert.ok(predicate, `missing ${label} re-enrich filter`);
        const eligible = new Function('job', 'indeedDescriptionLength', 'DESCRIPTION_EVIDENCE_MIN_CHARS', `return ${predicate};`);
        const length = job => String(job?.snippet || '').length;
        assert.equal(eligible({ snippet: '', descriptionDeferredReason: 'description-pending-liveness' }, length, 400), true,
          `${label} pass retries a blank row after its prior visit marked it pending`);
        assert.equal(eligible({ snippet: '', descriptionDeferredReason: 'indeed-job-unavailable' }, length, 400), false,
          `${label} pass leaves a terminal unavailable row alone`);
        assert.equal(eligible({ snippet: 'x'.repeat(400) }, length, 400), false,
          `${label} pass skips an already score-safe row`);
      }
      const reEnrich = between(source, 'export async function runIndeedReEnrichPass(', '/**\n * Fetch Indeed job listings');
      assert.match(reEnrich, /else \{\s*job\.descriptionDeferredReason = 'description-pending-liveness';\s*recordIndeedEnrichmentAttempt\(job, \{ stage, outcome: 'blank'/u,
        'each blank re-enrichment visit remains explicitly deferred');
    },
  },
  {
    name: 'listing liveness capture: a blank Indeed re-enrich visit stays deferred through the slower retry',
    async run() {
      const job = { source: 'indeed', title: 'Platform Engineer', company: 'Northwind Labs',
        jobkey: 'synthetic-reenrich', url: 'https://www.indeed.com/viewjob?jk=synthetic-reenrich',
        snippet: '', description: '' };
      const navigations = [];
      const page = {
        goto: async (_url, options) => { navigations.push(options.waitUntil); return { status: () => 200 }; },
        url: () => job.url,
        $eval: async () => '',
        evaluate: async (fn, args) => fn.name === 'listingLivenessPageProbe'
          ? { title: 'Platform Engineer | Indeed', h1: 'Platform Engineer', chromeText: '',
            descriptionText: args.descriptionText, closedHits: [], openSignals: [],
            jsonLd: { validThrough: null, isListed: null } }
          : null,
      };
      const runtime = { sleep: async () => {}, getChallengeSignals: async () => ({ isChallenge: false }) };
      for (const [stage, waitUntil] of [['re-enrich', 'domcontentloaded'], ['slow-re-enrich', 'networkidle2']]) {
        const recovered = await indeedBrowser.runIndeedReEnrichPass(page, { jobs: [job], stage,
          label: 'Synthetic re-enrich', waitUntil, timeout: 30_000, settleMs: [0, 0], gapMs: [0, 0], runtime });
        assert.equal(recovered, 0);
        assert.equal(job.descriptionDeferredReason, 'description-pending-liveness', `${stage} retains its retryable marker`);
        assert.equal(job._enrichAttempts?.at(-1)?.outcome, 'blank');
      }
      assert.deepEqual(navigations, ['domcontentloaded', 'networkidle2']);
    },
  },
  {
    name: 'listing liveness capture: a slow Indeed description recovery clears the pending scoring marker',
    async run() {
      const job = { source: 'indeed', title: 'Platform Engineer', company: 'Northwind Labs',
        jobkey: 'synthetic-slow-recovery', url: 'https://www.indeed.com/viewjob?jk=synthetic-slow-recovery',
        snippet: '', description: '' };
      const description = 'Build reliable synthetic platform services and document recovery procedures with the engineering team. '.repeat(6);
      let detailText = '';
      const page = {
        goto: async () => ({ status: () => 200 }),
        url: () => job.url,
        $eval: async () => detailText,
        evaluate: async (fn, args) => fn.name === 'listingLivenessPageProbe'
          ? { title: 'Platform Engineer | Indeed', h1: 'Platform Engineer', chromeText: '',
            descriptionText: args.descriptionText, closedHits: [], openSignals: [],
            jsonLd: { validThrough: null, isListed: null } }
          : null,
      };
      const runtime = { sleep: async () => {}, getChallengeSignals: async () => ({ isChallenge: false }) };
      await indeedBrowser.runIndeedReEnrichPass(page, { jobs: [job], stage: 're-enrich',
        label: 'Synthetic fast re-enrich', waitUntil: 'domcontentloaded', timeout: 20_000,
        settleMs: [0, 0], gapMs: [0, 0], runtime });
      assert.equal(job.descriptionDeferredReason, 'description-pending-liveness');
      detailText = description;
      const recovered = await indeedBrowser.runIndeedReEnrichPass(page, { jobs: [job], stage: 'slow-re-enrich',
        label: 'Synthetic slow re-enrich', waitUntil: 'networkidle2', timeout: 30_000,
        settleMs: [0, 0], gapMs: [0, 0], runtime });
      assert.equal(recovered, 1);
      assert.equal(job.description, description);
      assert.equal(job.descriptionDeferredReason, undefined, 'a score-safe description can enter scoring');
      assert.equal(indeedBrowser.isIndeedScoreSafeDescription(job), true);
    },
  },
  {
    name: 'listing liveness capture: structurally closed Indeed rows are excluded from both re-enrich passes',
    async run() {
      const source = await fs.readFile(new URL('electron/extractors/indeedBrowser.js', SOURCE_ROOT), 'utf8');
      const eligible = (input, name) => {
        const pattern = new RegExp(`const ${name} = ${input}\\.filter\\(job =>\\s*([^;]+?)\\s*\\);`, 'u');
        const predicate = source.match(pattern)?.[1];
        assert.ok(predicate, `missing ${name} filter`);
        return new Function('job', 'indeedDescriptionLength', 'DESCRIPTION_EVIDENCE_MIN_CHARS', `return ${predicate};`);
      };
      const fastEligible = eligible('allJobs', 'missingDescJobs');
      const slowEligible = eligible('missingDescJobs', 'residualDescJobs');
      const length = job => String(job?.snippet || '').length;
      const job = { source: 'indeed', title: 'Platform Engineer', company: 'Northwind Labs',
        jobkey: 'synthetic-closed-revisit', url: 'https://www.indeed.com/viewjob?jk=synthetic-closed-revisit',
        snippet: '', description: '' };
      assert.equal(fastEligible(job, length, 400), true);
      const page = {
        goto: async () => ({ status: () => 404 }), url: () => job.url, $eval: async () => '',
        evaluate: async () => null,
      };
      const runtime = { sleep: async () => {}, getChallengeSignals: async () => ({ isChallenge: false }) };
      await indeedBrowser.runIndeedReEnrichPass(page, { jobs: [job], stage: 're-enrich',
        label: 'Synthetic re-enrich', waitUntil: 'domcontentloaded', timeout: 20_000,
        settleMs: [0, 0], gapMs: [0, 0], runtime });
      assert.equal(job.boardClosed?.reason, 'http-not-found');
      assert.equal(job.descriptionDeferredReason, 'description-pending-liveness');
      assert.equal(fastEligible(job, length, 400), false, 'a known closed row cannot enter the fast pass again');
      assert.equal(slowEligible(job, length, 400), false, 'a known closed row cannot enter the slow pass');
    },
  },
  {
    name: 'listing liveness capture: Indeed overlay text cannot create a closed marker',
    async run() {
      const description = 'Build reliable synthetic platform services and mentor teammates. '.repeat(8);
      const html = `<html><head><title>Platform Engineer | Indeed</title></head><body><h1>Platform Engineer</h1>`
        + `<div id="jobDescriptionText">${description}</div>`
        + '<div id="__ic-panel">Job Collector: This job is no longer available</div></body></html>';
      const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://www.indeed.com/viewjob?jk=synthetic123' });
      try {
        dom.window.eval(`window.__listingProbe = ${listingLivenessPageProbe.toString()}`);
        const probed = dom.window.__listingProbe({ rules: LISTING_LIVENESS_RULES.indeed,
          expectedTitle: 'Platform Engineer', descriptionText: description,
          excludeSelectors: ['#__ic-panel'] });
        assert.deepEqual(Array.from(probed.closedHits), [], 'overlay wording is not listing evidence');
      } finally {
        dom.window.close();
      }
      const source = await fs.readFile(new URL('electron/extractors/indeedBrowser.js', SOURCE_ROOT), 'utf8');
      const capture = between(source, 'async function captureIndeedListingLiveness(', 'async function indeedStructuralDetail(');
      assert.match(capture, /excludeSelectors:\s*\['#__ic-panel'\]/u, 'the Indeed visit requests overlay exclusion');
    },
  },
  {
    name: 'listing liveness capture: LinkedIn soft blocks and in-place authwalls preserve prior paired state',
    async run() {
      assert.equal(typeof apiExtractors.linkedInCapturedVisitWall, 'function');
      const prior = {
        boardClosed: { board: 'linkedin', reason: 'http-not-found', at: '2026-10-01T00:00:00.000Z' },
        listingLiveness: { board: 'linkedin', verdict: 'closed', basis: 'structural', at: '2026-10-01T00:00:00.000Z' },
      };
      for (const [label, result, page, expectedWall] of [
        ['soft block', { ok: false, pageTitle: '', ldCount: 0 }, { title: '', h1: '', chromeText: 'Jobs People Learning' }, 'linkedin-soft-block'],
        ['in-place authwall', { ok: false, pageTitle: 'Sign Up | LinkedIn', ldCount: 0 },
          { title: 'Sign Up | LinkedIn', h1: 'Join to view this job', chromeText: 'Sign in to see more jobs. Join now.' }, 'linkedin-authwall'],
      ]) {
        const wall = apiExtractors.linkedInCapturedVisitWall(result, page);
        assert.equal(wall, expectedWall, label);
        const evidence = finalizeListingEvidence({ ...page, wall }, {
          board: 'linkedin', ruleKey: 'linkedin', requestedUrl: 'https://www.linkedin.com/jobs/view/synthetic123',
          finalUrl: 'https://www.linkedin.com/jobs/view/synthetic123', httpStatus: 200,
          expectedTitle: 'Platform Engineer', expectedCompany: 'Northwind Labs',
        });
        const decision = classifyListingLiveness(evidence, LISTING_LIVENESS_RULES.linkedin);
        assert.deepEqual(decision, { verdict: 'unknown', basis: 'wall' }, label);
        const row = apiExtractors.linkedInUndescribedRow({ source: 'linkedin', title: 'Platform Engineer', ...prior }, decision, evidence);
        assert.deepEqual(row.boardClosed, prior.boardClosed, `${label} keeps the old closed marker`);
        assert.deepEqual(row.listingLiveness, prior.listingLiveness, `${label} keeps the old liveness verdict`);
      }
      assert.equal(apiExtractors.linkedInCapturedVisitWall({ ok: false, pageTitle: 'Platform Engineer | LinkedIn', ldCount: 1 },
        { title: 'Platform Engineer | LinkedIn', h1: 'Platform Engineer' }), null);
      const source = await fs.readFile(new URL('electron/extractors/apiExtractors.js', SOURCE_ROOT), 'utf8');
      const capture = between(source, 'const result = await page.evaluate(extractDesc)', 'if (decision?.verdict ===');
      assert.match(capture, /linkedInCapturedVisitWall\(result, probed\)/u);
      assert.match(capture, /wall: visitWall/u, 'the wall signal reaches the classifier evidence');
    },
  },
  {
    name: 'listing liveness capture: promoted Dice apply control is recognized on the HTTP HTML path',
    run() {
      const rules = { ...LISTING_LIVENESS_RULES.dice,
        openRules: LISTING_LIVENESS_RULES.dice.openRules.map(rule => ({ ...rule, state: 'active' })) };
      const description = 'Synthetic platform duties include operating services and mentoring the team. '.repeat(8);
      const html = `<html><head><title>Platform Engineer | Dice</title></head><body><h1>Platform Engineer</h1>`
        + '<button data-testid="apply-button">Apply</button>'
        + `<div id="jobDescription">${description}</div></body></html>`;
      const evidence = evidenceFromHtml(html, { board: 'dice', ruleKey: 'dice', rules,
        requestedUrl: 'https://www.dice.com/job-detail/synthetic123',
        finalUrl: 'https://www.dice.com/job-detail/synthetic123', httpStatus: 200,
        expectedTitle: 'Platform Engineer', expectedCompany: 'Northwind Labs' });
      assert.equal(evidence.openSignals.some(signal => signal.ruleId === rules.openRules[0].id), true);
      assert.deepEqual(classifyListingLiveness(evidence, rules), { verdict: 'open', basis: 'open-marker' });
    },
  },
  {
    name: 'listing liveness capture: real promoted rules reach all four capture paths through the IPC snapshot',
    async run() {
      assert.equal(typeof calibrationModule.__setListingLivenessCalibrationStoreForTests, 'function');
      assert.equal(typeof indeedBrowser.captureIndeedListingLiveness, 'function');
      assert.equal(typeof manualScraper.captureZipRecruiterListingLiveness, 'function');
      assert.equal(typeof apiExtractors.livenessRulesFor, 'function');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-liveness-rules-'));
      const store = calibrationModule.createListingLivenessCalibrationStore(directory);
      const boards = ['linkedin', 'indeed', 'ziprecruiter', 'dice'];
      const restoreStore = calibrationModule.__setListingLivenessCalibrationStoreForTests(store);
      const previousFetch = globalThis.fetch;
      try {
        for (const board of boards) {
          const ruleId = LISTING_LIVENESS_RULES[board].openRules[0].id;
          const base = { board, ruleKey: board, titleMatchesPage: true, redirectedAway: false,
            closedHits: [], jsonLd: { validThrough: '', isListed: null } };
          for (let index = 0; index < 20; index++) await store.recordAiAnswer({ ruleKey: board, verdict: 'open',
            evidence: { ...base, openSignals: [{ ruleId, state: 'shadow' }] } });
          for (let index = 0; index < 5; index++) await store.recordAiAnswer({ ruleKey: board, verdict: 'closed',
            evidence: { ...base, openSignals: [] } });
          for (let index = 0; index < 15; index++) await store.recordAiAnswer({ ruleKey: board, verdict: 'unclear',
            evidence: { ...base, openSignals: [] } });
          assert.equal((await store.snapshot()).rulesFor(board).openRules[0].state, 'active', board);
        }
        const description = 'Synthetic platform duties include operating reliable services and mentoring the team. '.repeat(8);
        const htmlFor = board => {
          const control = board === 'linkedin' ? '<button class="jobs-apply-button">Apply</button>'
            : board === 'indeed' ? '<button id="indeedApplyButton">Apply</button>'
              : '<button data-testid="apply-button">Apply</button>';
          const descId = board === 'linkedin' ? 'job-details' : board === 'indeed' ? 'jobDescriptionText'
            : board === 'dice' ? 'jobDescription' : 'job-description';
          return `<html><head><title>Platform Engineer | ${board}</title></head><body><h1>Platform Engineer</h1>`
            + `<p>${description}</p>${control}<div id="${descId}">${description}</div></body></html>`;
        };
        const fakePage = (board, url) => ({
          url: () => url,
          evaluate: async (probe, args) => {
            const dom = new JSDOM(htmlFor(board), { runScripts: 'outside-only', url });
            try {
              dom.window.eval(`window.__listingProbe = ${probe.toString()}`);
              return dom.window.__listingProbe(args);
            } finally { dom.window.close(); }
          },
        });
        const channel = 'synthetic-listing-liveness-promoted-capture';
        handleSafe(channel, async () => {
          const context = getCurrentIpcRequestContext();
          for (const board of boards) assert.equal(context.livenessRules.rulesFor(board).openRules[0].state, 'active', board);
          const linkedUrl = 'https://www.linkedin.com/jobs/view/synthetic123';
          const linkedRules = apiExtractors.livenessRulesFor('linkedin');
          const linkedProbe = await fakePage('linkedin', linkedUrl).evaluate(listingLivenessPageProbe,
            { rules: linkedRules, expectedTitle: 'Platform Engineer', descriptionText: description });
          const linkedEvidence = finalizeListingEvidence(linkedProbe, { board: 'linkedin', ruleKey: 'linkedin',
            requestedUrl: linkedUrl, finalUrl: linkedUrl, httpStatus: 200, expectedTitle: 'Platform Engineer' });
          assert.deepEqual(classifyListingLiveness(linkedEvidence, linkedRules), { verdict: 'open', basis: 'open-marker' });
          const indeedUrl = 'https://www.indeed.com/viewjob?jk=synthetic123';
          const indeedJob = { source: 'indeed', title: 'Platform Engineer', company: 'Northwind Labs', url: indeedUrl };
          const indeedDecision = await indeedBrowser.captureIndeedListingLiveness(fakePage('indeed', indeedUrl), indeedJob,
            { requestedUrl: indeedUrl, httpStatus: 200, descriptionText: description });
          assert.deepEqual(indeedDecision, { verdict: 'open', basis: 'open-marker' });
          assert.equal(indeedJob.listingLiveness?.verdict, 'open');
          const zipUrl = 'https://www.ziprecruiter.com/jobs/synthetic123';
          const zipJob = { source: 'ziprecruiter', title: 'Platform Engineer', company: 'Northwind Labs', url: zipUrl };
          const zipResult = await manualScraper.captureZipRecruiterListingLiveness(fakePage('ziprecruiter', zipUrl), zipJob,
            { requestedUrl: zipUrl, httpStatus: 200, descriptionText: description });
          assert.equal(zipResult.listingLiveness?.verdict, 'open');
          const diceUrl = 'https://www.dice.com/job-detail/synthetic123';
          const diceJob = { source: 'dice', title: 'Platform Engineer', company: 'Northwind Labs', url: diceUrl,
            jobkey: 'synthetic123', snippet: description };
          globalThis.fetch = async () => new Response(htmlFor('dice'), { status: 200 });
          const [diceResult] = await apiExtractors.enrichDiceDescriptions([diceJob], null);
          assert.equal(diceResult.listingLiveness?.verdict, 'open');
          return { success: true };
        }, { captureListingLiveness: true });
        const sender = { id: 91949, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} };
        const response = await ipcMain.__getInvokeHandler(channel)({ sender }, { nodeId: 'synthetic-capture-hub' });
        assert.equal(response.success, true, response.error);
      } finally {
        globalThis.fetch = previousFetch;
        restoreStore();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'listing liveness capture: every production capture handler installs the rule snapshot',
    async run() {
      const source = await fs.readFile(new URL('electron/ipc/jobs.js', SOURCE_ROOT), 'utf8');
      const handlers = ['search-jobs', 'search-jobs-single-source', 'score-jobs', 'resolve-job-source', 'resume-job-source'];
      for (const [index, channel] of handlers.entries()) {
        const next = handlers[index + 1];
        const section = between(source, `handleSafe('${channel}',`, next ? `handleSafe('${next}',` : "ipcMain.handle('record-resolve-merge',");
        assert.match(section, /captureListingLiveness: true/u, `${channel} snapshots calibrated rules`);
      }
    },
  },
  {
    name: 'listing liveness capture: ZipRecruiter detail guards respect host authority, walls and same-visit text',
    async run() {
      assert.equal(manualScraper.isUnavailableDetailPage({ httpStatus: 404 }), true);
      assert.equal(manualScraper.isUnavailableDetailPage({ httpStatus: 410 }), true);
      assert.equal(manualScraper.isUnavailableDetailPage({ httpStatus: 200 }), false);
      const prior = {
        boardClosed: { board: 'ziprecruiter', reason: 'http-not-found', at: '2026-10-01T00:00:00.000Z' },
        listingLiveness: { board: 'ziprecruiter', verdict: 'closed', basis: 'structural', at: '2026-10-01T00:00:00.000Z' },
      };
      const requestedUrl = 'https://www.ziprecruiter.com/jobs/synthetic123';
      const row = { source: 'ziprecruiter', title: 'Platform Engineer', company: 'Northwind Labs',
        url: requestedUrl, jobkey: 'synthetic123', ...prior };
      const baseProbe = { title: 'Platform Engineer | ZipRecruiter', h1: 'Platform Engineer',
        chromeText: '', descriptionText: '', closedHits: [], openSignals: [],
        jsonLd: { validThrough: null, isListed: null } };
      const page = (finalUrl, probe = baseProbe) => ({ url: () => finalUrl,
        evaluate: async (_fn, args) => { assert.equal(args.descriptionText, 'Synthetic same-visit description.'); return probe; } });
      const args = { requestedUrl, httpStatus: 404, descriptionText: 'Synthetic same-visit description.' };
      const ats = await manualScraper.captureZipRecruiterListingLiveness(page('https://boards.greenhouse.io/northwind/jobs/synthetic123'), row, args);
      assert.equal(ats, null, 'an ATS 404 is terminal');
      const other = await manualScraper.captureZipRecruiterListingLiveness(page('https://tracker.example.test/r/synthetic123'), row, args);
      assert.equal(other, row, 'a different host 404 cannot close the board listing');
      const wall = await manualScraper.captureZipRecruiterListingLiveness(page(requestedUrl, { ...baseProbe,
        wall: 'ziprecruiter-error-shell' }), row, { ...args, httpStatus: 200 });
      assert.equal(wall, row, 'a transient error shell preserves the prior pair');
      assert.deepEqual(wall.boardClosed, prior.boardClosed);
      assert.deepEqual(wall.listingLiveness, prior.listingLiveness);
      const source = await fs.readFile(new URL('electron/ipc/browser/manualScraper.js', SOURCE_ROOT), 'utf8');
      const detail = between(source, 'async function expandDescriptions(', 'export async function enrichResolvedJobDescriptions(');
      assert.match(detail, /const otherHostNotFound = \[404, 410\]\.includes\(Number\(navigationStatus\)\)\s*&& detailFinalHostClass === 'other'/u);
      assert.match(detail, /wall: detailErrorShellSeen \? 'ziprecruiter-error-shell' : null/u);
      assert.match(detail, /descriptionText: text,\s*descriptionCapture,/u);
    },
  },
  {
    name: 'listing liveness capture: Indeed exact retry distinguishes aggregator, ATS, other host and blank detail',
    async run() {
      const source = await fs.readFile(new URL('electron/extractors/indeedBrowser.js', SOURCE_ROOT), 'utf8');
      assert.match(source, /runtime\?\.launchBrowser/u, 'the retry accepts an injected browser for capture-path tests');
      const rows = ['aggregator', 'ats', 'other', 'blank'].map(kind => ({ source: 'indeed',
        title: 'Platform Engineer', company: 'Northwind Labs', location: 'Remote',
        url: `https://www.indeed.com/viewjob?jk=synthetic-${kind}`, jobkey: `synthetic-${kind}`,
        snippet: '', description: '' }));
      let current = '';
      let navigations = 0;
      const page = {
        setExtraHTTPHeaders: async () => {}, evaluateOnNewDocument: async () => {},
        goto: async url => { current = url.includes('aggregator') ? 'https://www.indeed.com/viewjob?jk=synthetic-aggregator'
          : url.includes('ats') ? 'https://boards.greenhouse.io/northwind/jobs/synthetic-ats'
            : url.includes('other') ? 'https://tracker.example.test/r/synthetic-other' : url;
        navigations++; return { status: () => url.includes('blank') ? 200 : 404 }; },
        url: () => current,
        evaluate: async (fn, args) => fn.name === 'listingLivenessPageProbe'
          ? { title: 'Platform Engineer | Indeed', h1: 'Platform Engineer', chromeText: '',
            descriptionText: args.descriptionText, closedHits: [], openSignals: [],
            jsonLd: { validThrough: null, isListed: null } }
          : null,
        $eval: async () => '',
      };
      const runtime = {
        getSharedProfileReservationInfo: () => null,
        findSystemChromePath: async () => '/synthetic/chrome',
        reserveSharedProfile: () => () => {},
        launchBrowser: async () => ({}), createPage: async () => page,
        injectOverlay: async () => {}, updateOverlay: async () => {},
        getChallengeSignals: async () => ({ isChallenge: false }),
        sleep: async () => {}, closeBrowser: async () => {},
      };
      const result = await indeedBrowser.retryIndeedJobDescriptions(rows, null, '/synthetic/profile', runtime);
      assert.equal(navigations, 4);
      const byKey = new Map(result.jobs.map(row => [row.jobkey, row]));
      assert.equal(byKey.has('synthetic-ats'), false, 'official ATS 404 is terminal');
      assert.equal(byKey.get('synthetic-aggregator')?.boardClosed?.board, 'indeed');
      assert.equal(byKey.get('synthetic-aggregator')?.listingLiveness?.verdict, 'closed');
      assert.equal(byKey.get('synthetic-other')?.boardClosed, undefined, 'other-host 404 cannot confirm closure');
      assert.equal(byKey.get('synthetic-blank')?.descriptionDeferredReason, 'description-pending-liveness');
      assert.equal(result.unavailable.length, 2, 'only aggregator and ATS structural outcomes are unavailable');
    },
  },
  {
    name: 'listing liveness capture: ZipRecruiter expansion keeps other-host 404, treats error shell as wall and forwards same-visit text',
    async run() {
      const source = await fs.readFile(new URL('electron/ipc/browser/manualScraper.js', SOURCE_ROOT), 'utf8');
      assert.match(source, /runtime\?\.delay/u, 'the shell retry uses an injected delay in the fake-page test');
      const requestedUrl = 'https://www.ziprecruiter.com/jobs/synthetic123';
      const prior = {
        boardClosed: { board: 'ziprecruiter', reason: 'http-not-found', at: '2026-10-01T00:00:00.000Z' },
        listingLiveness: { board: 'ziprecruiter', verdict: 'closed', basis: 'structural', at: '2026-10-01T00:00:00.000Z' },
      };
      const row = { source: 'ziprecruiter', title: 'Platform Engineer', company: 'Northwind Labs',
        url: requestedUrl, jobkey: 'synthetic123', snippet: '', ...prior };
      const runVisit = async scenario => {
        const fake = zipDetailPage(scenario);
        try {
          const result = await manualScraper.enrichResolvedJobDescriptions(fake.page, [row], 'ziprecruiter', null, {},
            { delay: async () => true });
          return { result, observed: fake.observed };
        } finally { fake.close(); }
      };
      const other = await runVisit({ finalUrl: 'https://tracker.example.test/r/synthetic123', status: 404,
        html: '<html><head><title>Not Found</title></head><body><h1>External page</h1></body></html>' });
      assert.equal(other.observed.navigations, 1);
      assert.equal(other.result.jobs.length, 1, 'a different host 404 cannot retire a ZipRecruiter card');
      assert.deepEqual(other.result.jobs[0].listingLiveness, prior.listingLiveness);
      const shell = await runVisit({ finalUrl: requestedUrl, status: 200,
        html: '<html><head><title>Platform Engineer</title></head><body><h1>Platform Engineer</h1><p>We encountered an error while loading this job</p></body></html>' });
      assert.equal(shell.observed.navigations, 3, 'the bounded error-shell retry occurs twice');
      assert.equal(shell.result.jobs.length, 1);
      assert.deepEqual(shell.result.jobs[0].listingLiveness, prior.listingLiveness,
        'the shell is a wall and cannot overwrite the prior pair');
      const description = 'Synthetic platform duties and application instructions. '.repeat(10);
      const html = `<html><head><title>Platform Engineer</title><script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', title: 'Platform Engineer', description,
      })}</script></head><body><h1>Platform Engineer</h1><div class="whitespace-pre-line">${description}</div></body></html>`;
      const live = await runVisit({ finalUrl: requestedUrl, status: 200, html });
      assert.equal(live.result.jobs.length, 1);
      assert.equal(live.result.jobs[0].snippet, description.trim());
      assert.equal(live.observed.probeArgs.length, 1);
      assert.equal(live.observed.probeArgs[0].descriptionText, description.trim(),
        'the captured description reaches the same-visit liveness probe');
    },
  },
];
