import crypto from 'node:crypto';
import { assert, fs, os, path, LOCAL_AI_APPLICATION_VERSION, localApplicationStatus, queueLocalApplicationJob, resolveLocalOutputBundleRoot, validateLocalApplicationResult } from '../test-dependencies.js';

async function createCanvasProject() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-canvas-')));
  const canvasFilePath = path.join(root, 'My Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{"version":1}', 'utf8');
  return { root, canvasFilePath };
}

const draftedQualityReview = () => ({
  resume: { decision: 'drafted', rationale: 'The fresh résumé passed a relevance, evidence, and factual-support review.' },
  coverLetter: { decision: 'drafted', rationale: 'The fresh cover letter passed an argument, relevance, and factual-support review.' },
});

const normalizedCoverLetter = () => ({
  name: '', contact: [], salutation: '', recipient: '',
  paragraphs: ['A concise factual letter.'], closing: '', signatureTitle: '',
});

const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export default [
  {
    name: 'Local AI application: PDF import uses the same standalone résumé surface as API generation',
    run: () => {
      const localSource = fs.readFileSync(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      const apiSource = fs.readFileSync(path.resolve('electron/ipc/jobApplication.js'), 'utf8');
      const convergenceSource = fs.readFileSync(path.resolve('electron/ipc/applicationConvergence.js'), 'utf8');
      const cardSource = fs.readFileSync(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const routineSource = fs.readFileSync(path.resolve('local_ai/CLAUDE_CODE_ROUTINE.md'), 'utf8');
      assert(localSource.includes('renderLocalResumeWithFit')
        && localSource.includes('renderPdf(buildResumeDocument')
        && localSource.includes('targetPageCount')
        && localSource.includes('fit-feedback.json')
        && localSource.includes('render-retry-required')
        && localSource.includes("'kept_diminishing_returns'")
        && localSource.includes('documentSha256')
        && localSource.includes('there is no fixed revision limit')
        && localSource.includes('handoffHistory')
        && localSource.includes('handoff-receipts')
        && localSource.includes('writeLocalAiTerminalReceipt')
        && localSource.includes('result-imported')
        && localSource.includes('For a cover letter that already fits, improve it')
        && localSource.includes('missingArtifacts.length === 0'),
      'Local AI measures both final documents, records an auditable quality/fit trace, continues without a fixed revision cap until diminishing returns, and never saves when layout verification is unavailable');
      assert(localSource.includes('applicationConvergenceInstruction')
        && apiSource.includes('applicationConvergenceInstruction')
        && apiSource.includes('createApplicationConvergenceTracker')
        && convergenceSource.includes('expectedApplicationQualityDecision')
        && convergenceSource.includes('repeated a previously measured document'),
      'Local AI and every API application revision type consume one shared no-limit convergence policy');
      assert(localSource.includes('Layout density is app-owned')
        && localSource.includes('let density = null;')
        && !localSource.includes("let density = /\\bdata-density\\s*=\\s*[\"']compact[\"']/i.test(resumeMainHtml)"),
      'Local AI ignores model-supplied compact density and measures default density before the app applies its compact retry');
      assert(cardSource.includes('Repair bundle') && cardSource.includes('missingArtifacts') && cardSource.includes('revision-required') && cardSource.includes('Retry layout check') && cardSource.includes('Retry import'),
        'the card exposes repair for historical partial bundles, fit revision for measured overflow, and retry paths for render or validation failures');
      assert(routineSource.includes('resultSha256') && routineSource.includes('Preserve a verified one-page cover letter')
        && routineSource.includes('candidate location/contact')
        && routineSource.includes('page fit as a constraint')
        && routineSource.includes('SAME Claude Code run active') && routineSource.includes('45 seconds')
        && routineSource.includes('There is no fixed round limit')
        && routineSource.includes('Infinite Canvas owns all root document variants')
        && routineSource.includes('handoff-receipts/<job-id>.json')
        && routineSource.includes('Never claim that the app "confirmed" bullet line counts'),
      'the Local AI routine can select a measured revision job, protect optional contact location from inference, distinguish measurements from diagnosis, observe final imported measurements after staging cleanup, and quality-check both documents until diminishing returns');
      return { standalonePdfPath: true, fitRevision: true };
    },
  },
  {
    name: 'Local AI application: queued handoff is app-owned and supplies a strict routine',
    run: async () => {
      const project = await createCanvasProject();
      const queued = await queueLocalApplicationJob({
        job: { title: 'Developer', company: 'Acme', snippet: 'Build reliable systems.' },
        careerData: 'Built reliable systems with measurable outcomes.', additionalNotes: 'Prefer a concise letter.',
        canvasFilePath: project.canvasFilePath,
      });
      assert(queued.status === 'queued' && /^[a-f0-9-]{36}$/i.test(queued.id), 'queue creates a UUID-backed Local AI job');
      const [manifest, input, prompt, jobListing, careerData] = await Promise.all([
        fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'),
        fs.promises.readFile(path.join(queued.folder, 'input.json'), 'utf8'),
        fs.promises.readFile(path.join(queued.folder, 'CLAUDE_CODE_PROMPT.md'), 'utf8'),
        fs.promises.readFile(path.join(queued.folder, 'context', 'job-listing.md'), 'utf8'),
        fs.promises.readFile(path.join(queued.folder, 'context', 'career-data.txt'), 'utf8'),
      ]);
      assert(JSON.parse(manifest).status === 'queued' && JSON.parse(input).jobId === queued.id,
        'job manifest and input are tied to the exact queued job id');
      assert(queued.folder.startsWith(`${project.root}${path.sep}.local-ai${path.sep}jobs${path.sep}`)
        && queued.canvasFilePath === project.canvasFilePath
        && prompt.includes('local_ai/CLAUDE_CODE_ROUTINE.md') && prompt.includes('INPUT_JOBS_ROOT')
        && prompt.includes('result.json.outputBundleRoot'),
      'job is beside the saved canvas and binds Claude Code to the reusable routine plus one result file');
      assert(jobListing.includes('Developer') && jobListing.includes('Build reliable systems.')
        && careerData === 'Built reliable systems with measurable outcomes.',
      'Generate materializes the complete job-listing and career context Claude Code needs');
      const parsedManifest = JSON.parse(manifest);
      const parsedInput = JSON.parse(input);
      assert(parsedManifest.canvasFilePath === project.canvasFilePath && parsedInput.canvasRoot === project.root,
        'manifest and input bind the job to one canonical saved canvas and its folder');
      await fs.promises.rm(project.root, { recursive: true, force: true });
      return { id: queued.id };
    },
  },
  {
    name: 'Local AI application: editable output root stays canvas-relative',
    run: () => {
      const projectRoot = path.join(os.tmpdir(), 'local-ai-project');
      const valid = resolveLocalOutputBundleRoot('Applications/2026', projectRoot);
      assert(valid.relative === path.join('Applications', '2026') && valid.resolved === path.join(projectRoot, 'Applications', '2026'),
        'nested canvas-relative bundle roots retain the configured hierarchy root');
      for (const unsafe of ['../outside', path.resolve(projectRoot, '..', 'outside'), '.']) {
        let rejected = false;
        try { resolveLocalOutputBundleRoot(unsafe, projectRoot); } catch { rejected = true; }
        assert(rejected, `unsafe bundle root is rejected: ${unsafe}`);
      }
      return { root: valid.relative };
    },
  },
  {
    name: 'Local AI application: stale unfinished jobs are pruned before a new job is queued',
    run: async () => {
      const project = await createCanvasProject();
      const stale = await queueLocalApplicationJob({
        job: { title: 'Old Developer', company: 'Acme' }, careerData: 'Experience.', canvasFilePath: project.canvasFilePath,
      });
      const manifestPath = path.join(stale.folder, 'manifest.json');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      manifest.createdAt = '2000-01-01T00:00:00.000Z';
      await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
      await queueLocalApplicationJob({
        job: { title: 'New Developer', company: 'Acme' }, careerData: 'Experience.', canvasFilePath: project.canvasFilePath,
      });
      assert(!fs.existsSync(stale.folder), 'a job abandoned beyond the retention period is pruned before another is accepted');
      await fs.promises.rm(project.root, { recursive: true, force: true });
      return { stalePruned: true };
    },
  },
  {
    name: 'Local AI application: result contract rejects unsafe résumé markup',
    run: () => {
      const id = '123e4567-e89b-42d3-a456-426614174000';
      const good = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><section class="section">Evidence</section></main>',
        coverLetter: normalizedCoverLetter(),
        qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      assert(good.coverLetter.paragraphs.length === 1, 'valid structured output is normalized');
      let summaryOnlyRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Software Engineer</span><span class="company">FliteX</span><p class="role-summary">Built flight-routing automation.</p></article></main>',
          coverLetter: normalizedCoverLetter(), qualityReview: draftedQualityReview(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { summaryOnlyRejected = true; }
      assert(summaryOnlyRejected,
        'the Local AI import path must reject a summary-only role instead of copying raw notes into a bullet');
      let rejected = false;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><script>alert(1)</script></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { rejected = true; }
      assert(rejected, 'scripts in a Local AI result cannot enter the built application workspace');
      let emDashRejected = false;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><section class="section">Led the migration — reducing latency.</section></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { emDashRejected = true; }
      assert(emDashRejected, 'an em dash in candidate copy cannot enter a Local AI application');
      let rangeAccepted = true;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><section class="section">Led a 3–5 engineer team from Mar 2022 – Present.</section></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { rangeAccepted = false; }
      assert(rangeAccepted, 'date and numeric en-dash ranges remain valid candidate copy');
      let monthToMonthDateRangeAccepted = true;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><section class="section">Software Engineer, May 2023 – June 2026.</section></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { monthToMonthDateRangeAccepted = false; }
      assert(monthToMonthDateRangeAccepted, 'month-to-month date ranges remain valid candidate copy');
      let missingReviewRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><section class="section">Evidence</section></main>',
          coverLetter: normalizedCoverLetter(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { missingReviewRejected = true; }
      assert(missingReviewRejected, 'every Local AI result must record a quality disposition for both documents');
      let fitOnlyRationaleRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><section class="section">Evidence</section></main>',
          coverLetter: normalizedCoverLetter(),
          qualityReview: {
            resume: { decision: 'drafted', rationale: 'The résumé fits on the required one-page target.' },
            coverLetter: draftedQualityReview().coverLetter,
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { fitOnlyRationaleRejected = true; }
      assert(fitOnlyRationaleRejected, 'page fit alone cannot serve as a quality-completion rationale');
      const structuralOverflowReview = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><section class="section">Evidence</section></main>',
        coverLetter: normalizedCoverLetter(),
        qualityReview: {
          resume: { decision: 'drafted', rationale: 'Structural reduction after the résumé remained at 2 pages: dropped the weakest role and redundant bullets while retaining the most relevant backend evidence.' },
          coverLetter: draftedQualityReview().coverLetter,
        },
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      assert(structuralOverflowReview.qualityReview.resume.decision === 'drafted',
        'a concrete structural rationale remains valid when it truthfully mentions the measured overflow that prompted the revision');
      return { rejected, emDashRejected, rangeAccepted, monthToMonthDateRangeAccepted, missingReviewRejected, fitOnlyRationaleRejected, structuralOverflowAccepted: true, summaryOnlyRejected: true };
    },
  },
  {
    name: 'Local AI application: status treats malformed result.json as invalid without importing it',
    run: async () => {
      const project = await createCanvasProject();
      const queued = await queueLocalApplicationJob({ job: { title: 'Developer', company: 'Acme' }, careerData: 'Experience.', canvasFilePath: project.canvasFilePath });
      await fs.promises.writeFile(path.join(queued.folder, 'result.json'), '{bad json', 'utf8');
      const status = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(status.status === 'invalid' && /JSON|Unexpected/i.test(status.message),
        'bad result JSON is surfaced as an actionable invalid state');
      const otherProject = await createCanvasProject();
      let crossCanvasRejected = false;
      try { await localApplicationStatus(queued.id, otherProject.canvasFilePath); } catch { crossCanvasRejected = true; }
      assert(crossCanvasRejected, 'a job id cannot be reopened from a different canvas directory');
      await fs.promises.rm(project.root, { recursive: true, force: true });
      await fs.promises.rm(otherProject.root, { recursive: true, force: true });
      return { status: status.status };
    },
  },
  {
    name: 'Local AI application: corrected invalid results remain eligible for automatic status recovery',
    run: async () => {
      const source = await fs.promises.readFile(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const pollingGuard = source.match(/if \(!jobId \|\| !window\.electronAPI\?\.getLocalApplicationStatus \|\| \[([^\]]+)\]\.includes\(localApplication\.status\)\) return undefined;/);
      assert(pollingGuard && !/['"]invalid['"]/.test(pollingGuard[1]),
        'invalid results remain eligible for status polling after Claude Code corrects result.json');
      return { invalidRecoveryPolling: true };
    },
  },
  {
    name: 'Local AI application: measured overflow waits for an AI revision, then accepts a changed result',
    run: async () => {
      const project = await createCanvasProject();
      const queued = await queueLocalApplicationJob({ job: { title: 'Developer', company: 'Acme' }, careerData: 'Experience.', canvasFilePath: project.canvasFilePath });
      const result = {
        version: LOCAL_AI_APPLICATION_VERSION, jobId: queued.id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><section class="section">Evidence</section></main>',
        coverLetter: normalizedCoverLetter(),
        qualityReview: draftedQualityReview(),
      };
      const resultText = `${JSON.stringify(result)}\n`;
      const documentSha256 = {
        resume: sha256(result.resumeMainHtml),
        coverLetter: sha256(JSON.stringify(result.coverLetter)),
      };
      await fs.promises.writeFile(path.join(queued.folder, 'result.json'), resultText, 'utf8');
      await fs.promises.writeFile(path.join(queued.folder, 'fit-feedback.json'), `${JSON.stringify({
        version: 1, jobId: queued.id, status: 'revision-required', revisionRound: 17,
        resultSha256: sha256(resultText), documentSha256,
        resume: { targetPageCount: 1, pageCount: 2 }, coverLetter: { targetPageCount: 1, pageCount: 1 },
        message: 'résumé is 2 pages (target: 1). Re-run the Local AI routine.',
      })}\n`, 'utf8');
      const revisionRequired = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(revisionRequired.status === 'revision-required' && /2 page/.test(revisionRequired.message),
        'matching app feedback holds the result for a content-aware Local AI revision even beyond the old fixed limit');

      const diminishingResult = {
        ...result,
        qualityReview: {
          resume: { decision: 'kept_diminishing_returns', rationale: 'No remaining cut preserves more priority evidence than it removes from the résumé.' },
          coverLetter: { decision: 'kept_diminishing_returns', rationale: 'No material argument or relevance improvement remains for the cover letter.' },
        },
      };
      const diminishingText = `${JSON.stringify(diminishingResult)}\n`;
      await fs.promises.writeFile(path.join(queued.folder, 'result.json'), diminishingText, 'utf8');
      const reviewed = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(reviewed.status === 'completed', 'an unchanged result is import-ready only after both documents explicitly record diminishing returns');
      await fs.promises.writeFile(path.join(queued.folder, 'fit-feedback.json'), `${JSON.stringify({
        version: 1, jobId: queued.id, status: 'revision-exhausted', revisionRound: 18,
        resultSha256: sha256(diminishingText), documentSha256,
        message: 'The overflowing résumé remained unchanged after an explicit diminishing-returns review.',
      })}\n`, 'utf8');
      const exhausted = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(exhausted.status === 'revision-exhausted' && /diminishing-returns/.test(exhausted.message),
        'matching feedback terminates the loop because the overflowing document is unchanged at diminishing returns, not because of a retry count');

      const changedResult = {
        ...result,
        resumeMainHtml: '<main class="page"><section class="section">More relevant evidence</section></main>',
        qualityReview: {
          resume: { decision: 'changed_materially', rationale: 'Replaced weaker material with more relevant and specifically supported résumé evidence.' },
          coverLetter: { decision: 'kept_diminishing_returns', rationale: 'No material argument or relevance improvement remains for the cover letter.' },
        },
      };
      await fs.promises.writeFile(path.join(queued.folder, 'result.json'), `${JSON.stringify(changedResult, null, 2)}\n`, 'utf8');
      const revised = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(revised.status === 'completed', 'a materially changed résumé and unchanged diminishing-returns cover letter clear stale feedback and return to import-ready state');
      await fs.promises.rm(project.root, { recursive: true, force: true });
      return { held: revisionRequired.status, exhausted: exhausted.status, revised: revised.status };
    },
  },
];
