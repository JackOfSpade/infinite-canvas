import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { __registerJobsHandlersForTests, getJobsTelemetry, reconcileSearchFunnel, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { readRunState, sanitizeLastRunReceipt } from '../../electron/ipc/jobRunStaging.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';
import { reconcileGlassdoorSalaryFromDescription } from '../../src/utils/jobSalaryReconciliation.js';

export default [
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
    name: 'official-posting search: fresh score-safe rows resolve before the final durable checkpoint without rewriting identity',
    async run() {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'official-posting-search-'));
      const canvasFilePath = path.join(directory, 'canvas.json');
      const nodeId = 'official-posting-search-board';
      const calls = []; const progress = []; let resolved = false;
      const row = { source: 'remoteok', title: 'Platform Engineer', company: 'Northwind Labs', location: 'Remote',
        salary: '', posted: 'today', url: 'https://listing.example.test/platform',
        snippet: 'Responsibilities and requirements: maintain resilient platform services and review operational failures. '.repeat(8) };
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
            const result = { sourceId: 'remoteok', jobs: [row], gathered: 1 };
            await args[11]('remoteok', result);
            await args[8]({ sourceId: 'remoteok', query: 'platform engineer', page: 1, jobs: [row] });
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
        assert.equal(result.jobs.length, 1);
        for (const key of ['title', 'company', 'location', 'salary', 'snippet', 'url']) assert.equal(result.jobs[0][key], row[key]);
        assert.equal(result.jobs[0].officialPosting.level, 'L5');
        const state = await readRunState(canvasFilePath, Date.now(), { nodeId });
        assert.ok(state.stagedJobs.some(entry => entry.job?.officialPosting?.level === 'L5'));
        assert.ok(progress.some(item => item.sourceId === 'official-posting' && item.count === 0
          && item.detail === 'Finding official postings 0 / 1'));
        assert.equal(getJobsTelemetry().search.officialPosting.total, 1);
        assert.equal(getJobsTelemetry().search.reconciliation.reconciled, true);
      } finally {
        registerJobsHandlers();
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'official-posting search: official dedup is a separate conserved stage and survives terminal receipt normalization',
    run() {
      const funnel = { raw: 8, deduped: 8, ageDropped: 0, roleDropped: 1, historyDropped: 1,
        descriptionEvidenceDropped: { total: 1 }, finalDedupDropped: 1, officialDedupDropped: 2, kept: 2 };
      const result = reconcileSearchFunnel(funnel);
      assert.equal(result.reconciled, true); assert.equal(result.officialDedupDropped, 2);
      const receipt = sanitizeLastRunReceipt({ runId: 'synthetic-official-run', completedAt: Date.now(),
        terminal: { status: 'completed', outcome: 'populated' }, funnel: { ...funnel, descriptionEvidenceDropped: 1 } });
      assert.equal(receipt.funnel.officialDedupDropped, 2);
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
      assert.match(linked, /const admitForScoring = async rows => \(await resolveScoreSafePostings/u);
      assert.match(linked, /const scoringJobs = await admitForScoring\(descriptionRecoveryJobs\)/u);
      assert.doesNotMatch(linked, /items: admitForScoring\(/u);
      const generic = block('const runGenericResolve = async () =>', "checkpointContinuationBeforeReply('resolve-job-source')");
      assert.match(generic, /const scoringJobs = \(await resolveScoreSafePostings/u);
      assert.match(generic, /const officialResolution = await resolveScoreSafePostings\(descriptionEvidence.jobs,/u);
      const indeed = block("handleSafe('resume-job-source',", "checkpointContinuationBeforeReply('resume-job-source')");
      assert.equal([...indeed.matchAll(/await resolveScoreSafePostings\(descriptionEvidence.jobs,/gu)].length, 2);
    },
  },
];
