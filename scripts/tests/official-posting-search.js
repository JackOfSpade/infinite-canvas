import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { mergeSourceProgress } from '../../src/utils/sourceProgress.js';
import { ipcMain } from 'electron';
import { __registerJobsHandlersForTests, getJobsTelemetry, reconcileSearchFunnel, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { readRunState, sanitizeLastRunReceipt } from '../../electron/ipc/jobRunStaging.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { reconcileGlassdoorSalaryFromDescription } from '../../src/utils/jobSalaryReconciliation.js';
import { filterNonEnglishJobs } from '../../src/utils/jobLanguage.js';

const englishDescription = 'Responsibilities include building reliable software and documenting system requirements with the operations team. '.repeat(8);
const frenchDescription = 'Nous recherchons une personne pour rejoindre notre équipe. Vous serez responsable de développer des applications et de travailler avec les équipes techniques. '.repeat(8);

export default [
  {
    name: 'official-posting search: LinkedIn recovery replaces completed description activity while keeping the source pending',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const resolver = source.indexOf('const resolveScoreSafePostings = async');
      const start = source.indexOf('const onProgress =', resolver);
      const end = source.indexOf('\n    try {', start);
      const sent = [];
      const context = { rows: Array(12), progressSourceId: 'linkedin', nodeId: 'hub', jobRunId: 'run',
        signal: new AbortController().signal, recordJobSourceProgress() {},
        event: { sender: { isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) } } };
      vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.reportProgress = onProgress;`, context);
      let progress = { status: 'searching', count: 70, completed: 1, total: 1,
        activity: 'description-enrichment', activityCompleted: 19, activityTotal: 19 };
      context.reportProgress({ completed: 0, total: 12 });
      progress = mergeSourceProgress(progress, sent.at(-1));
      assert.equal(progress.count, 70, 'research does not replace provider volume with zero');
      assert.equal(progress.activity, 'official-posting');
      assert.equal(progress.activityCompleted, 0);
      assert.equal(progress.activityTotal, 12);
      context.reportProgress({ completed: 12, total: 12 });
      progress = mergeSourceProgress(progress, sent.at(-1));
      assert.equal(progress.status, 'searching', 'checkpoint and warning reconciliation still own terminal completion');
      assert.equal(mergeSourceProgress(progress, { status: 'done' }).activity, null);
      const linked = source.slice(source.indexOf('const isLinkedInReEnrich ='), source.indexOf("// Use the source's ordinary list extractor"));
      const admitStart = linked.indexOf('const admitForScoring =');
      const admitEnd = linked.indexOf('const persistRecoveryPool =', admitStart);
      let options;
      const binding = { resolveScoreSafePostings: async (rows, value) => { options = value; return { jobs: rows }; },
        scoreSafeRowsWithBoardClosed: value => value, filterJobsByDescriptionEvidence: value => value,
        filterNonEnglishJobs, logger: { info() {} },
        overlayResolvedRecoveryRows: value => value, snapshotRecoveryJobs: [], event: context.event, nodeId: 'hub', signal: context.signal, jobRunId: 'run' };
      vm.runInNewContext(`${linked.slice(admitStart, admitEnd)}\nglobalThis.admit = admitForScoring;`, binding);
      return binding.admit([{ id: 'english', description: englishDescription }, { id: 'french', description: frenchDescription }]).then(rows => {
        assert.equal(options.progressSourceId, 'linkedin');
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
    name: 'official-posting search: final descriptions filter by English majority before reply and durable score-safe checkpoint',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-search-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      const nodeId = 'official-posting-search-board';
      const calls = []; const progress = []; let resolved = false;
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
          resolveOfficialPostings: async (jobs, options) => {
            calls.push({ jobs, nodeId: options.nodeId, signal: options.signal });
            options.onProgress({ completed: 0, total: jobs.length });
            resolved = true;
            return { jobs: jobs.map(job => ({ ...job, officialPosting: { level: 'L5', outcome: 'not-found',
              employer: 'Northwind Labs', trail: [] } })), telemetry: { total: jobs.length, levels: { L5: jobs.length }, outcomes: { 'not-found': jobs.length } } };
          },
          beforeSearchStageWrite: async ({ phase }) => {
            if (phase === 'before-final-stage' || phase === 'before-gathered-stage') assert.equal(resolved, true);
          },
        });
        const sender = { id: 71921, isDestroyed: () => false, once() {}, on() {}, removeListener() {},
          send(channel, payload) { if (channel === 'job-source-progress') progress.push(payload); } };
        const result = await ipcMain.__getInvokeHandler('search-jobs')({ sender }, {
          queries: ['platform engineer'], nodeId, canvasFilePath, careerSnapshotId, operationAuthority: authority.receipt,
          enabledSourceIds: ['remoteok'], targetRole: '', preferredLocation: '',
        });
        assert.equal(result.success, true, result.error);
        assert.equal(calls.length, 1); assert.equal(calls[0].nodeId, nodeId);
        assert.ok(calls[0].signal instanceof AbortSignal);
        assert.equal(result.jobs.length, 2);
        assert.deepEqual(result.jobs.map(job => job.url).sort(), [row.url, bilingual.url].sort());
        assert.ok(result.jobs.every(job => !Object.hasOwn(job, 'language')), 'majority-English results need no language chip');
        for (const key of ['title', 'company', 'location', 'salary', 'snippet', 'url']) assert.equal(result.jobs[0][key], row[key]);
        assert.equal(result.jobs[0].officialPosting.level, 'L5');
        const state = await readRunState(canvasFilePath, Date.now(), { nodeId });
        assert.ok(state.stagedJobs.some(entry => entry.job?.officialPosting?.level === 'L5'));
        assert.equal(state.stagedJobs.filter(entry => entry.job?.officialPosting?.level === 'L5').length, 2, 'only English-majority rows reach the final score-safe checkpoint');
        assert.ok(progress.some(item => item.sourceId === 'official-posting' && item.count === 0
          && item.detail === 'Finding official postings 0 / 3'));
        assert.equal(getJobsTelemetry().search.officialPosting.total, 3);
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
          resolveOfficialPostings: async jobs => ({ jobs, telemetry: { total: jobs.length } }),
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
    name: 'official-posting search: source continuations resolve before score-safe snapshot and reply checkpoints',
    run() {
      const source = fs.readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
      const main = block("handleSafe('search-jobs',", "handleSafe('peek-job-run',");
      assert.ok(main.indexOf('kept = finalDeduped;') < main.indexOf('await resolveScoreSafePostings(kept,'));
      assert.ok(main.indexOf('await resolveScoreSafePostings(kept,') < main.indexOf("phase: 'before-final-stage'"));
      const single = block("handleSafe('search-jobs-single-source',", "handleSafe('prepare-board-jobs-history',");
      assert.match(single, /await resolveScoreSafePostings\(kept,/u);
      const linked = block('const isLinkedInReEnrich =', "// Use the source's ordinary list extractor");
      assert.match(linked, /const admitForScoring = async rows => \{\s*const officialResolution = await resolveScoreSafePostings/u);
      assert.match(linked, /const languageFilter = filterNonEnglishJobs\(officialResolution.jobs\)/u);
      assert.match(linked, /const scoringJobs = await admitForScoring\(descriptionRecoveryJobs\)/u);
      assert.doesNotMatch(linked, /items: admitForScoring\(/u);
      const generic = block('const runGenericResolve = async () =>', "checkpointContinuationBeforeReply('resolve-job-source')");
      assert.match(generic, /const resolveGenericPostings = createOfficialPostingRecoveryPassResolver\(rows =>\s*resolveScoreSafePostings\(rows, \{ event, nodeId, signal, jobRunId \}\), \{ signal \}\)/u);
      assert.match(generic, /const resolvedJobs = \(await resolveGenericPostings\(scoreSafeRowsWithBoardClosed\(filterJobsByDescriptionEvidence\(descriptionRecoveryJobs\)\)\)\).jobs/u);
      assert.match(generic, /const scoringJobs = filterNonEnglishJobs\(resolvedJobs\).jobs/u);
      assert.match(generic, /const officialResolution = await resolveGenericPostings\(\s*overlayResolvedRecoveryRows\(scoreSafeRowsWithBoardClosed\(descriptionEvidence\), sourceRecoverySnapshot\?\.jobs\)\)/u);
      assert.match(linked, /scoringItems = await persistRecoveryPool\(items\)/u);
      assert.doesNotMatch(linked, /const scoringItems = await admitForScoring\(items\)/u);
      const indeed = block("handleSafe('resume-job-source',", "checkpointContinuationBeforeReply('resume-job-source')");
      assert.equal([...indeed.matchAll(/await resolveScoreSafePostings\(scoreSafeRowsWithBoardClosed\(descriptionEvidence\),/gu)].length, 2);
    },
  },
];
