import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ipcMain } from 'electron';
import { __registerJobsHandlersForTests, getJobsTelemetry, reconcileSearchFunnel, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { readRunState, sanitizeLastRunReceipt } from '../../electron/ipc/jobRunStaging.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { reconcileGlassdoorSalaryFromDescription } from '../../src/utils/jobSalaryReconciliation.js';
import { filterNonEnglishJobs } from '../../src/utils/jobLanguage.js';
import { withListingClosed } from '../../electron/ipc/officialPostingBoardClosed.js';
import { RESEARCH_MIN_FIT_SCORE } from '../../electron/ipc/researchGate.js';

const englishDescription = 'Responsibilities include building reliable software and documenting system requirements with the operations team. '.repeat(8);
const frenchDescription = 'Nous recherchons une personne pour rejoindre notre équipe. Vous serez responsable de développer des applications et de travailler avec les équipes techniques. '.repeat(8);

export default [
  {
    name: 'official-posting search: LinkedIn recovery settles rows without research, progress or lookups and keeps only primarily English descriptions',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const settler = source.slice(source.indexOf('const settleScrapedRowsForScoring = async'), source.indexOf('void pruneStaleUnsavedAnalysisArtifacts();'));
      assert.ok(settler.length > 200, 'the scrape-time settler is still the single boundary');
      // Search paths no longer research: the settler takes no progress reporter and makes no lookup, liveness or dedup call.
      assert.doesNotMatch(settler, /resolveOfficialPostings|onProgress|progressSourceId|callListingLiveness|officialPostingDedup|recheckPendingListings|researchDeferredJobPreferences/u);
      assert.doesNotMatch(source, /Finding official postings/u);
      assert.doesNotMatch(source, /sourceId:\s*'official-posting'/u);
      const linked = source.slice(source.indexOf('const isLinkedInReEnrich ='), source.indexOf("// Use the source's ordinary list extractor"));
      const admitStart = linked.indexOf('const admitForScoring =');
      const admitEnd = linked.indexOf('const persistRecoveryPool =', admitStart);
      let options;
      const binding = { settleScrapedRowsForScoring: async (rows, value) => { options = value; return { jobs: rows }; },
        scoreSafeRowsWithBoardClosed: value => value, filterJobsByDescriptionEvidence: value => value,
        filterNonEnglishJobs, logger: { info() {} },
        overlayResolvedRecoveryRows: value => value, snapshotRecoveryJobs: [], nodeId: 'hub', signal: new AbortController().signal };
      vm.runInNewContext(`${linked.slice(admitStart, admitEnd)}\nglobalThis.admit = admitForScoring;`, binding);
      return binding.admit([{ id: 'english', description: englishDescription }, { id: 'french', description: frenchDescription }]).then(rows => {
        assert.deepEqual(Object.keys(options), ['signal'], 'LinkedIn recovery hands the settler only its abort signal, never an event or progress source');
        assert.deepEqual(rows.map(row => row.id), ['english'], 'LinkedIn recovery returns only primarily English descriptions');
      });
    },
  },
  {
    name: 'official-posting search: description-reconciled salary cannot retain a structured posted-pay anchor',
    run() {
      const result = reconcileGlassdoorSalaryFromDescription({ source: 'glassdoor', salary: '$50 - $60',
        salaryProvenance: 'posted', snippet: 'Salary range: $50 - $60 per hour.' });
      assert.equal(result.salaryProvenance, 'unknown');
      assert.match(result.salary, /per hour/u);
    },
  },
  {
    name: 'official-posting search: final descriptions filter by English majority before reply and durable score-safe checkpoint with zero research',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-search-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      const nodeId = 'official-posting-search-board';
      const livenessCalls = []; const progress = []; const phases = [];
      const row = { source: 'remoteok', title: 'Platform Engineer', company: 'Northwind Labs', location: 'Remote',
        salary: '', posted: 'today', url: 'https://listing.example.test/platform',
        snippet: 'Responsibilities and requirements: maintain resilient platform services and review operational failures. '.repeat(8) };
      const french = { ...row, title: 'Systems Engineer', url: 'https://listing.example.test/systems', description: frenchDescription };
      const bilingual = { ...row, title: 'Data Engineer', url: 'https://listing.example.test/data', description: `${frenchDescription}\n${englishDescription.repeat(2)}` };
      const rows = [row, french, bilingual];
      try {
        await fs.promises.writeFile(canvasFilePath, '{}');
        const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
        const authority = await claimJobAnalysisOperationAuthority({ canvasFilePath, hubId: nodeId, operationId: 'official-search',
          semanticBase: { kind: 'search', careerSnapshotId, runId: null, fingerprint: 'synthetic-official-search',
            analysisRevisionId: null, continuationId: null, sourceArtifactFingerprint: null } });
        assert.equal(authority.admitted, true);
        __registerJobsHandlersForTests({
          resolveRequiredPinnedCareerInput: async () => ({ profile: {}, careerData: '', pinned: true }),
          fetchHttpSources: async (...args) => {
            await args[10]('remoteok');
            const result = { sourceId: 'remoteok', jobs: rows, gathered: rows.length };
            await args[11]('remoteok', result);
            await args[8]({ sourceId: 'remoteok', query: 'platform engineer', page: 1, jobs: rows });
            return [result];
          },
          // Search paths no longer research: a liveness AI call here would be a regression.
          callListingLiveness: async (...args) => { livenessCalls.push(args); throw new Error('search must not call listing liveness AI'); },
          beforeSearchStageWrite: async ({ phase }) => { phases.push(phase); },
        });
        const sender = { id: 71921, isDestroyed: () => false, once() {}, on() {}, removeListener() {},
          send(channel, payload) { if (channel === 'job-source-progress') progress.push(payload); } };
        const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender }, {
          queries: ['platform engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
          enabledSourceIds: ['remoteok'], targetRole: '', preferredLocation: '',
        });
        assert.equal(result.success, true, result.error);
        assert.equal(livenessCalls.length, 0, 'zero listing-liveness AI calls during search');
        assert.ok(phases.includes('before-final-stage') || phases.includes('before-gathered-stage'), 'the durable score-safe checkpoint still ran');
        assert.equal(result.jobs.length, 2);
        assert.deepEqual(result.jobs.map(job => job.url).sort(), [row.url, bilingual.url].sort());
        assert.ok(result.jobs.every(job => !Object.hasOwn(job, 'language')), 'majority-English results need no language chip');
        for (const key of ['title', 'company', 'location', 'salary', 'snippet', 'url']) assert.equal(result.jobs[0][key], row[key]);
        assert.ok(result.jobs.every(job => !Object.hasOwn(job, 'officialPosting')), 'scraped rows carry no officialPosting until the Board researches them');
        const state = await readRunState(canvasFilePath, Date.now(), { nodeId });
        const stagedCount = url => state.stagedJobs.filter(entry => entry.job?.url === url).length;
        assert.deepEqual([stagedCount(row.url), stagedCount(bilingual.url), stagedCount(french.url)], [2, 2, 1],
          'the provider page stages every row once; only English-majority rows reach the final score-safe checkpoint');
        assert.ok(state.stagedJobs.every(entry => !Object.hasOwn(entry.job || {}, 'officialPosting')), 'staged rows carry no official posting');
        assert.ok(!progress.some(item => item.sourceId === 'official-posting'), 'no official-posting progress source is published');
        assert.ok(!progress.some(item => String(item.detail || '').includes('Finding official postings')), 'no Finding official postings progress');
        assert.equal(getJobsTelemetry().search.officialPosting.total ?? 0, 0, 'no official lookups were counted');
        assert.equal(getJobsTelemetry().search.languageDropped, 1);
        assert.equal(getJobsTelemetry().search.languages.total, 3, 'language telemetry counts the list before filtering');
        assert.equal(getJobsTelemetry().search.languages.nonEnglish, 1);
        assert.equal(getJobsTelemetry().search.languages.byLang.fr, 1);
        assert.equal(getJobsTelemetry().search.reconciliation.reconciled, true);

        const retryRows = [
          { ...row, source: 'indeed', jobkey: 'english-retry', url: 'https://www.indeed.com/viewjob?jk=english-retry', description: englishDescription },
          { ...french, source: 'indeed', jobkey: 'french-retry', url: 'https://www.indeed.com/viewjob?jk=french-retry' },
        ];
        __registerJobsHandlersForTests({
          retryIndeedJobDescriptions: async jobs => ({ jobs, attempted: jobs.length, recovered: jobs.length, remaining: 0 }),
        });
        const retried = await ipcMain.__getInvokeHandler('resume-job-source')({ sender }, {
          sourceId: 'indeed', nodeId, jobRunId: result.runId, canvasFilePath, enabledSourceIds: ['indeed'],
          careerSnapshotId, operationAuthority: authority.receipt,
          resumeState: { mode: 'retry-descriptions', jobs: retryRows },
        });
        assert.equal(retried.resolved, true, JSON.stringify(retried));
        assert.deepEqual(retried.items.map(job => job.jobkey), ['english-retry'], 'native description retry filters recovered French text before returning score-ready rows');
        assert.equal(getJobsTelemetry().resolves.indeed.languageDropped, 1);
        assert.equal(getJobsTelemetry().resolves.indeed.kept, 1);
        assert.ok(progress.some(item => item.sourceId === 'indeed' && item.count === 1 && item.detail?.includes('languageDropped=1')));
      } finally {
        registerJobsHandlers();
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'official-posting search: official dedup is a separate conserved stage and survives terminal receipt normalization',
    run() {
      const funnel = { raw: 9, deduped: 9, ageDropped: 0, roleDropped: 1, historyDropped: 1,
        descriptionEvidenceDropped: { total: 1 }, finalDedupDropped: 1, officialDedupDropped: 2, languageDropped: 1, kept: 2 };
      const result = reconcileSearchFunnel(funnel);
      assert.equal(result.reconciled, true); assert.equal(result.officialDedupDropped, 2);
      const receipt = sanitizeLastRunReceipt({ runId: 'synthetic-official-run', completedAt: Date.now(),
        terminal: { status: 'completed', outcome: 'populated' }, funnel: { ...funnel, descriptionEvidenceDropped: 1 } });
      assert.equal(receipt.funnel.officialDedupDropped, 2);
      assert.equal(receipt.funnel.languageDropped, 1);
    },
  },
  {
    name: 'official-posting search: source continuations settle (without research) before score-safe snapshot and reply checkpoints',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
      assert.doesNotMatch(source, /resolveScoreSafePostings/u, 'the researching resolver is gone from every search path');
      assert.doesNotMatch(source, /dependencies\.resolveOfficialPostings/u, 'jobs.js no longer reads the official-posting resolver dependency');
      const main = block("handleSafe('search-jobs',", "handleSafe('peek-job-run',");
      assert.ok(main.indexOf('kept = finalDeduped;') < main.indexOf('await settleScrapedRowsForScoring(kept,'));
      assert.ok(main.indexOf('await settleScrapedRowsForScoring(kept,') < main.indexOf("phase: 'before-final-stage'"));
      const single = block("handleSafe('search-jobs-single-source',", "handleSafe('prepare-board-jobs-history',");
      assert.match(single, /await settleScrapedRowsForScoring\(kept,/u);
      const linked = block('const isLinkedInReEnrich =', "// Use the source's ordinary list extractor");
      assert.match(linked, /const admitForScoring = async rows => \{\s*const officialResolution = await settleScrapedRowsForScoring/u);
      assert.match(linked, /const languageFilter = filterNonEnglishJobs\(officialResolution.jobs\)/u);
      assert.match(linked, /const scoringJobs = await admitForScoring\(descriptionRecoveryJobs\)/u);
      assert.doesNotMatch(linked, /items: admitForScoring\(/u);
      const generic = block('const runGenericResolve = async () =>', "checkpointContinuationBeforeReply('resolve-job-source')");
      assert.match(generic, /const resolveGenericPostings = createOfficialPostingRecoveryPassResolver\(rows =>\s*settleScrapedRowsForScoring\(rows, \{ signal \}\), \{ signal \}\)/u);
      assert.match(generic, /const resolvedJobs = \(await resolveGenericPostings\(scoreSafeRowsWithBoardClosed\(filterJobsByDescriptionEvidence\(descriptionRecoveryJobs\)\)\)\).jobs/u);
      assert.match(generic, /const scoringJobs = filterNonEnglishJobs\(resolvedJobs\).jobs/u);
      assert.match(generic, /const officialResolution = await resolveGenericPostings\(\s*overlayResolvedRecoveryRows\(scoreSafeRowsWithBoardClosed\(descriptionEvidence\), sourceRecoverySnapshot\?\.jobs\)\)/u);
      assert.match(linked, /scoringItems = await persistRecoveryPool\(items\)/u);
      assert.doesNotMatch(linked, /const scoringItems = await admitForScoring\(items\)/u);
      const indeed = block("handleSafe('resume-job-source',", "checkpointContinuationBeforeReply('resume-job-source')");
      assert.equal([...indeed.matchAll(/await settleScrapedRowsForScoring\(scoreSafeRowsWithBoardClosed\(descriptionEvidence\), \{ signal \}\)/gu)].length, 2);
    },
  },
  {
    name: 'official-posting search: settle-board-research does the official dedup and closed-listing settlement for eligible rows only, with no AI call',
    async run() {
      const posting = url => ({ level: 'L3', outcome: 'found', employer: 'Northwind Labs', title: 'Platform Engineer',
        sourceUrl: url, officialApplyUrl: url, trail: [] });
      const officialUrl = 'https://jobs.lever.co/northwind/req-one';
      const base = (title, matchScore, extra = {}) => ({ source: 'remoteok', title, company: 'Northwind Labs', location: 'Remote',
        salary: '', posted: 'today', url: `https://listing.example.test/${title.replaceAll(' ', '-').toLowerCase()}`,
        snippet: englishDescription, matchScore, ...extra });
      const closed = (job, reason = 'http-not-found') => withListingClosed(job, { board: 'remoteok', reason });
      const lowCopy = base('Copy A', RESEARCH_MIN_FIT_SCORE + 5, { officialPosting: posting(officialUrl) });
      const closedBlank = closed(base('Closed Blank', RESEARCH_MIN_FIT_SCORE + 10, { snippet: '' }));
      const highCopy = base('Copy B', RESEARCH_MIN_FIT_SCORE + 20, { officialPosting: posting(officialUrl) });
      const closedDescribed = closed(base('Closed Described', RESEARCH_MIN_FIT_SCORE + 8));
      const belowClosed = closed(base('Below Closed', RESEARCH_MIN_FIT_SCORE - 20, { snippet: '' }));
      const belowOpen = base('Below Open', RESEARCH_MIN_FIT_SCORE - 20);
      const unscored = closed(base('Unscored Closed', 0, { scoreStatus: 'unscored-test', snippet: '' }));
      const jobs = [lowCopy, closedBlank, highCopy, closedDescribed, belowClosed, belowOpen, unscored];
      const calls = [];
      const trap = name => async () => { calls.push(name); throw new Error(`${name} must not be called`); };
      __registerJobsHandlersForTests({ callListingLiveness: trap('liveness'), runScoreBatch: trap('score'), runGapReview: trap('gap') });
      try {
        const sender = { id: 71922, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, send() {} };
        const result = await ipcMain.__getInvokeHandler('settle-board-research')({ sender }, { jobs, nodeId: 'research-board', officialLookups: 4 });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(calls, [], 'no liveness, scoring or gap-review AI call for rows with nothing pending');
        assert.deepEqual(result.jobs, jobs, 'rows come back in request order and unchanged');
        const reasons = Object.fromEntries(result.dropped.map(entry => [entry.index, entry.reason]));
        assert.deepEqual(reasons, { 0: 'official-duplicate', 1: 'closed', 4: 'below-fit-closed' },
          'the lower-scored copy loses the official dedup, a described closed row stays, an unscored closed row is not treated as below threshold');
        assert.equal(result.counts.officialLookups, 4);
        assert.equal(result.counts.eligible, 4);
        assert.equal(result.counts.skippedBelowFit, 2);
        assert.equal(result.counts.skippedUnscored, 1);
        assert.equal(result.counts.officialDuplicatesDropped, 1);
        assert.equal(result.counts.closedDropped, 1);
        assert.equal(result.counts.belowFitClosedDropped, 1);
      } finally {
        registerJobsHandlers();
      }
    },
  },
];
