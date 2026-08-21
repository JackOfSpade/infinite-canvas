import crypto from 'node:crypto';
import { assert, buildCoverLetterDocument, ensureDirectoryWithinRoot, fs, os, path, LOCAL_AI_APPLICATION_VERSION, localApplicationStatus, queueLocalApplicationJob, readRegisteredApplicationArtifact, resolveLocalOutputBundleRoot, validateLocalApplicationResult } from '../test-dependencies.js';

async function createCanvasProject() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-canvas-')));
  const canvasFilePath = path.join(root, 'My Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{"version":1}', 'utf8');
  return { root, canvasFilePath };
}

const draftedQualityReview = () => ({
  resume: { decision: 'drafted', rationale: 'The fresh résumé passed a relevance, evidence, and factual-support review.' },
  coverLetter: { decision: 'drafted', rationale: 'The fresh cover letter preserves one controlling argument with minimum-sufficient evidence and passed factual-support review.' },
});

const validCoverLetterArgument = () => ({
  roleThesis: 'Build an evidence-grounded case for the employer need.',
  primaryEvidence: {
    evidence: 'Built the supported integration capability described in the résumé.',
    evidenceRole: 'Relevant engineering role',
    relationToThesis: 'The evidence directly establishes the supported employer-facing claim.',
  },
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
      const normalizedRoutineSource = routineSource.replace(/\s+/g, ' ');
      assert(normalizedRoutineSource.includes('Treat concise career data as compressed evidence')
        && normalizedRoutineSource.includes('make the narrow inferences needed to express that work coherently')
        && normalizedRoutineSource.includes('Do not dress up familiarity or self-assessed knowledge')
        && normalizedRoutineSource.includes('Never add an unrecorded outcome, improvement, scale, duration, ownership level, production use, adoption, or causal result')
        && normalizedRoutineSource.includes('never move a fact between employers or projects'),
      'Local AI résumé generation must apply the same bounded compressed-evidence synthesis rule as API generation');
      assert(normalizedRoutineSource.includes('grammatical parallelism')
        && normalizedRoutineSource.includes('faulty parallelism in coordinated forms such as `from X to/through Y`')
        && normalizedRoutineSource.includes('Pair noun phrases with noun phrases or actions with actions')
        && normalizedRoutineSource.includes('do not use bureaucratic padding such as `from the time of`'),
      'Local AI generation must critique and repair faulty parallelism without padding the sentence');
      assert(normalizedRoutineSource.includes('detached synthesis that broadens one example into a role-wide or career-wide claim')
        && normalizedRoutineSource.includes('must name the concrete responsibility, system, decision, or process it synthesizes')
        && normalizedRoutineSource.includes('Treat phrases such as `most of my work` and `throughout my career` as factual breadth claims')
        && normalizedRoutineSource.includes('Across paragraph boundaries, replace `this`, `that`, or `it` when more than one antecedent is plausible'),
      'Local AI must keep synthesis evidence-scoped and replace ambiguous cross-paragraph references');
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
        && localSource.includes('localAiCoverLetterTelemetry')
        && localSource.includes("['revision-required', 'revision-exhausted'].includes(priorFeedback?.status)")
        && localSource.includes('LOCAL_AI_RESULT_CHANGED')
        && localSource.includes('resumeIsMateriallyUnderfilled')
        && localSource.includes('minimum 90%')
        && localSource.includes('For a cover letter that already fits, improve it')
        && localSource.includes('COVER_LETTER_COHESION_REVISION_RULE')
        && localSource.includes('one controlling throughline')
        && localSource.includes('minimum-sufficient evidence')
        && localSource.includes('résumé owns breadth')
        && localSource.includes('Cut or consolidate before introducing another employer, project, or tool merely to cover a different requirement')
        && localSource.includes('relationship clear before the details')
        && localSource.includes('unclear antecedents')
        && localSource.includes('plausible-but-unverified steps')
        && localSource.includes('sanitizeCoverLetterArgument')
        && localSource.includes('assertCoverLetterReviewAttestsToArgument')
        && localSource.includes('primaryEvidence.relationToThesis')
        && localSource.includes('coverLetterArgument.secondaryEvidence.narrativeRole is invalid')
        && localSource.includes('missingArtifacts.length === 0'),
      'Local AI measures both final documents, keeps Local AI cover-letter revisions argument-led and fact-bounded rather than a requirement checklist, requests evidence-led revision for a materially underfilled one-page résumé, records an auditable quality/fit trace, treats an unchanged measured revision as idempotent, continues without a fixed revision cap until diminishing returns, and never saves when layout verification is unavailable');
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
      assert(cardSource.includes('Repair bundle') && cardSource.includes('missingArtifacts') && cardSource.includes('revision-required') && cardSource.includes('Retry layout check') && cardSource.includes('Retry import')
        && cardSource.includes('LOCAL_AI_RESULT_SETTLE_MS') && cardSource.includes('expectedResultSha256') && cardSource.includes('imported?.errorCode') && cardSource.includes('LOCAL_AI_RESULT_CHANGED') && cardSource.includes('waiting briefly for the final save'),
      'the card exposes repair for historical partial bundles, waits for a stable Claude Code result before auto-importing, and retains fit, render, and validation recovery paths');
      assert(routineSource.includes('resultSha256') && routineSource.includes('Preserve a verified one-page cover letter')
        && routineSource.includes('candidate location/contact')
        && routineSource.includes('page fit as a constraint')
        && routineSource.includes('never use `<b>` or')
        && routineSource.includes('front-load the most relevant')
        && routineSource.includes("Order each role's highlights by interview value")
        && normalizedRoutineSource.includes('colon-led evidence dumps')
        && normalizedRoutineSource.includes('unsolicited admissions of missing experience')
        && normalizedRoutineSource.includes('never repeat a metaphor across paragraphs')
        && routineSource.includes('<span data-achievement-id="ID">figure</span>')
        && routineSource.includes('Every top-level résumé category is a peer')
        && routineSource.includes('never use it as a peer category heading')
        && normalizedRoutineSource.includes("first sentence adds information beyond the application context")
        && normalizedRoutineSource.includes("Never announce that the candidate is applying")
        && normalizedRoutineSource.includes("Respect the recruiter's intelligence")
        && !normalizedRoutineSource.includes('Name the target company and role naturally in the opening sentence')
        && routineSource.includes('SAME Claude Code run active') && routineSource.includes('6 minutes')
        && routineSource.includes('There is no fixed round limit')
        && routineSource.includes('Infinite Canvas owns all root document variants')
        && routineSource.includes('handoff-receipts/<job-id>.json')
        && routineSource.includes('"coverLetterArgument"')
        && routineSource.includes('"relationToThesis"')
        && routineSource.includes('non-rendered argument contract')
        && routineSource.includes('one controlling argument')
        && routineSource.includes('minimum-sufficient evidence')
        && routineSource.includes('Never claim that the app "confirmed" bullet line counts'),
      'the Local AI routine can select a measured revision job, protect optional contact location from inference, require an argument-led cover-letter opening, distinguish measurements from diagnosis, observe final imported measurements after staging cleanup, and quality-check both documents until diminishing returns');
      assert((apiSource.match(/\$\{COVER_LETTER_OPENING_RULE\}/g) || []).length === 2
        && apiSource.includes('Please accept my application')
        && apiSource.includes("I am applying for"),
      'both API cover-letter authoring paths receive the same argument-led opening rule as the validator');
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
      if (process.platform !== 'win32') {
        const jobMode = (await fs.promises.stat(queued.folder)).mode & 0o777;
        const privateFileModes = await Promise.all([
          'manifest.json', 'input.json', 'CLAUDE_CODE_PROMPT.md',
          path.join('context', 'job-listing.md'), path.join('context', 'career-data.txt'),
        ].map(async file => (await fs.promises.stat(path.join(queued.folder, file))).mode & 0o777));
        assert(jobMode === 0o700 && privateFileModes.every(mode => mode === 0o600),
          'Local AI candidate context must use owner-only directory and file permissions');
      }
      await fs.promises.rm(project.root, { recursive: true, force: true });
      return { id: queued.id };
    },
  },
  {
    name: 'Local AI application: editable output root stays canvas-relative',
    run: async () => {
      const projectRoot = path.join(os.tmpdir(), 'local-ai-project');
      const valid = resolveLocalOutputBundleRoot('Applications/2026', projectRoot);
      assert(valid.relative === path.join('Applications', '2026') && valid.resolved === path.join(projectRoot, 'Applications', '2026'),
        'nested canvas-relative bundle roots retain the configured hierarchy root');
      for (const unsafe of ['../outside', path.resolve(projectRoot, '..', 'outside'), '.']) {
        let rejected = false;
        try { resolveLocalOutputBundleRoot(unsafe, projectRoot); } catch { rejected = true; }
        assert(rejected, `unsafe bundle root is rejected: ${unsafe}`);
      }
      const containmentRoot = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-containment-')));
      const outsideRoot = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-outside-')));
      const linkedOutput = path.join(containmentRoot, 'Applications');
      try {
        await fs.promises.symlink(outsideRoot, linkedOutput, process.platform === 'win32' ? 'junction' : 'dir');
        let symlinkRejected = false;
        try {
          await ensureDirectoryWithinRoot(containmentRoot, path.join(linkedOutput, '2026'), {
            label: 'Local AI output bundle root',
          });
        } catch { symlinkRejected = true; }
        assert(symlinkRejected, 'a symlink inside the configured output hierarchy must be rejected before traversal');
        assert(!fs.existsSync(path.join(outsideRoot, '2026')),
          'rejecting a linked output root must not create even an intermediate directory outside the canvas');
      } finally {
        await fs.promises.rm(containmentRoot, { recursive: true, force: true });
        await fs.promises.rm(outsideRoot, { recursive: true, force: true });
      }
      return { root: valid.relative, symlinkTraversalBlocked: true };
    },
  },
  {
    name: 'application save: registered artifacts cannot be linked or changed before promotion',
    run: async () => {
      const workDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'application-artifact-')));
      const outsideDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'application-artifact-outside-')));
      const artifactPath = path.join(workDir, 'Application.html');
      const outsidePath = path.join(outsideDir, 'outside.html');
      const original = '<!doctype html><main class="page">Trusted</main>';
      try {
        await fs.promises.writeFile(artifactPath, original, { mode: 0o600 });
        await fs.promises.writeFile(outsidePath, '<main>Outside</main>', { mode: 0o600 });
        const workspaceStat = await fs.promises.lstat(workDir);
        const workspaceIdentity = {
          realPath: await fs.promises.realpath(workDir),
          dev: workspaceStat.dev,
          ino: workspaceStat.ino,
        };
        const read = await readRegisteredApplicationArtifact(workDir, artifactPath, {
          encoding: 'utf8', workspaceIdentity, expectedSha256: sha256(original),
        });
        assert(read === original, 'the unchanged registered artifact remains readable');

        await fs.promises.writeFile(artifactPath, '<main class="page">Changed</main>', { mode: 0o600 });
        let changedRejected = false;
        try {
          await readRegisteredApplicationArtifact(workDir, artifactPath, {
            encoding: 'utf8', workspaceIdentity, expectedSha256: sha256(original),
          });
        } catch { changedRejected = true; }
        assert(changedRejected, 'a regular file modified after registration must fail its trusted-source fingerprint');

        await fs.promises.unlink(artifactPath);
        await fs.promises.symlink(outsidePath, artifactPath, process.platform === 'win32' ? 'file' : undefined);
        let linkedRejected = false;
        try {
          await readRegisteredApplicationArtifact(workDir, artifactPath, {
            encoding: 'utf8', workspaceIdentity, expectedSha256: sha256(original),
          });
        } catch { linkedRejected = true; }
        assert(linkedRejected, 'a registered source replaced by a symlink must be rejected');
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
      }
      return { fingerprintBound: true, symlinkBlocked: true };
    },
  },
  {
    name: 'Local AI application: project routine cannot traverse a linked local_ai folder',
    run: async () => {
      const routineProject = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-routine-project-')));
      const outsideDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-routine-outside-')));
      const canvasProject = await createCanvasProject();
      const previousRoot = process.env.INFINITE_CANVAS_PROJECT_ROOT;
      try {
        await fs.promises.writeFile(path.join(routineProject, 'package.json'), '{"private":true}', 'utf8');
        await fs.promises.mkdir(path.join(routineProject, 'Job Application Design System'));
        await fs.promises.writeFile(path.join(outsideDir, 'CLAUDE_CODE_ROUTINE.md'), '# untrusted linked routine', 'utf8');
        await fs.promises.symlink(outsideDir, path.join(routineProject, 'local_ai'), process.platform === 'win32' ? 'junction' : 'dir');
        process.env.INFINITE_CANVAS_PROJECT_ROOT = routineProject;
        let rejected = false;
        try {
          await queueLocalApplicationJob({
            job: { title: 'Developer', company: 'Acme' },
            careerData: 'Experience.',
            canvasFilePath: canvasProject.canvasFilePath,
          });
        } catch (error) {
          rejected = /symbolic link|resolved outside|must not traverse/i.test(String(error?.message || error));
        }
        assert(rejected, 'a linked project routine folder must be rejected before discovery or copy');
      } finally {
        if (previousRoot === undefined) delete process.env.INFINITE_CANVAS_PROJECT_ROOT;
        else process.env.INFINITE_CANVAS_PROJECT_ROOT = previousRoot;
        await fs.promises.rm(routineProject, { recursive: true, force: true });
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
        await fs.promises.rm(canvasProject.root, { recursive: true, force: true });
      }
      return { linkedRoutineRejected: true };
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
      const validResumeMain = '<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>';
      const good = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      assert(good.coverLetter.paragraphs.length === 1
        && good.coverLetterArgument.roleThesis === validCoverLetterArgument().roleThesis,
      'valid structured output preserves the non-rendered controlling-argument contract');
      const uniformHighlightText = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><section class="section"><h2><strong>Experience</strong></h2><article class="role"><ul class="highlights"><li>Cut latency <strong data-achievement-id="receipt-1">42%</strong> with <b>Python</b> services.</li></ul></article></section></main>',
        coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      const normalizedHighlight = /<ul\b[^>]*class="highlights"[^>]*>([\s\S]*?)<\/ul>/i.exec(uniformHighlightText.resumeMainHtml)?.[1] || '';
      assert(!/<(?:b|strong)\b/i.test(normalizedHighlight)
        && uniformHighlightText.resumeMainHtml.includes('<span data-achievement-id="receipt-1">42%</span>')
        && uniformHighlightText.resumeMainHtml.includes('<span>Python</span>')
        && uniformHighlightText.resumeMainHtml.includes('<h2><strong>Experience</strong></h2>'),
      'Local AI import neutralizes inline emphasis only inside highlight bullets, preserving receipt attributes, text, and structural heading emphasis');
      const unrestrictedParagraphs = ['First.', 'Second.', 'Third.', 'Fourth.', `${'word '.repeat(900)}Fifth.`];
      const unrestricted = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: { ...normalizedCoverLetter(), paragraphs: unrestrictedParagraphs }, coverLetterArgument: validCoverLetterArgument(),
        qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      assert(unrestricted.coverLetter.paragraphs.length === unrestrictedParagraphs.length
        && unrestricted.coverLetter.paragraphs[4].endsWith('Fifth.'),
        'Local AI import must preserve arbitrary paragraph counts and full paragraph text for measured PDF fit');
      for (const opener of [
        'I am writing to apply for the Developer role at Acme.',
        "I'm writing to apply for the Developer role at Acme.",
        'I’m writing to apply for the Developer role at Acme.',
        'I am applying for the Developer role at Acme.',
        "I'm applying for the Developer role at Acme.",
        'I’m applying for the Developer role at Acme.',
        'Please accept my application for the Developer role at Acme.',
      ]) {
        let bannedOpenerRejected = false;
        try {
          validateLocalApplicationResult({
            version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
            outputBundleRoot: 'Applied Jobs',
            resumeMainHtml: validResumeMain,
            coverLetter: { ...normalizedCoverLetter(), paragraphs: [opener] }, coverLetterArgument: validCoverLetterArgument(),
            qualityReview: draftedQualityReview(),
          }, id, path.join(os.tmpdir(), 'local-ai-project'), { company: 'Acme', title: 'Developer' });
        } catch (error) {
          bannedOpenerRejected = /generic-language check.*banned opener/i.test(String(error?.message || error));
        }
        assert(bannedOpenerRejected,
          `Local AI validation must reject application-announcement opener: ${opener}`);
      }
      const canonicalEnvelope = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><header class="resume-header"><h1 class="name">Maya Chen</h1><p class="tagline">Senior Engineer</p><p class="contact">maya@example.test · Toronto, ON</p></header><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></main>',
        coverLetter: {
          ...normalizedCoverLetter(), name: 'Wrong Name', contact: ['wrong@example.test'],
          salutation: 'Dear Acme Hiring Team,', recipient: 'Acme Hiring Team', closing: 'Regards,', signatureTitle: 'Engineer',
        },
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'), { company: 'Acme', title: 'Senior Platform Engineer' });
      assert(canonicalEnvelope.coverLetter.name === 'Maya Chen'
        && JSON.stringify(canonicalEnvelope.coverLetter.contact) === JSON.stringify(['maya@example.test', 'Toronto, ON'])
        && canonicalEnvelope.coverLetter.tagline === 'Senior Engineer'
        && /^[A-Z][a-z]+ \d{4}$/.test(canonicalEnvelope.coverLetter.date)
        && canonicalEnvelope.coverLetter.recipient === ''
        && canonicalEnvelope.coverLetter.salutation === 'Dear Acme Hiring Team,'
        && canonicalEnvelope.coverLetter.closing === 'Sincerely,'
        && canonicalEnvelope.coverLetter.signatureTitle === '',
      'Local AI derives the complete cover-letter envelope from the accepted résumé and selected job instead of trusting model-supplied fields');
      const renderedEnvelope = buildCoverLetterDocument({ letter: canonicalEnvelope.coverLetter });
      const expectedDateTime = `${canonicalEnvelope.coverLetter.date.slice(-4)}-${String([
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ].indexOf(canonicalEnvelope.coverLetter.date.split(' ')[0]) + 1).padStart(2, '0')}`;
      assert(renderedEnvelope.includes(`<time datetime="${expectedDateTime}">${canonicalEnvelope.coverLetter.date}</time>`),
        'Local AI keeps the app-authored month-year date and its machine-readable value in the cover-letter document');
      let summaryOnlyRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Software Engineer</span><span class="company">FliteX</span><p class="role-summary">Built flight-routing automation.</p></article></main>',
          coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { summaryOnlyRejected = true; }
      assert(summaryOnlyRejected,
        'the Local AI import path must reject a summary-only role instead of copying raw notes into a bullet');
      let missingArgumentRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), qualityReview: draftedQualityReview(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { missingArgumentRejected = /coverLetterArgument object/i.test(String(error?.message || error)); }
      assert(missingArgumentRejected,
        'Local AI import rejects a result without the non-rendered controlling-argument contract');
      let missingPrimaryRelationRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), qualityReview: draftedQualityReview(),
          coverLetterArgument: {
            ...validCoverLetterArgument(),
            primaryEvidence: {
              evidence: validCoverLetterArgument().primaryEvidence.evidence,
              evidenceRole: validCoverLetterArgument().primaryEvidence.evidenceRole,
            },
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { missingPrimaryRelationRejected = /primaryEvidence\.relationToThesis/i.test(String(error?.message || error)); }
      assert(missingPrimaryRelationRejected,
        'Local AI import requires the primary proof to state how it establishes the thesis');
      let invalidSecondaryRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), qualityReview: draftedQualityReview(),
          coverLetterArgument: {
            ...validCoverLetterArgument(),
            secondaryEvidence: {
              evidence: 'Another supported example with no declared relationship.',
              evidenceRole: 'Earlier engineering role',
              narrativeRole: 'primary',
              relationToPrimary: 'Unspecified',
            },
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { invalidSecondaryRejected = /narrativeRole is invalid/i.test(String(error?.message || error)); }
      assert(invalidSecondaryRejected,
        'Local AI import rejects an optional secondary proof without a permitted narrative role');
      let missingArgumentAttestationRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(),
          qualityReview: {
            resume: draftedQualityReview().resume,
            coverLetter: { decision: 'drafted', rationale: 'The cover letter is relevant, factual, and concise.' },
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { missingArgumentAttestationRejected = /controlling argument and minimum-sufficient evidence/i.test(String(error?.message || error)); }
      assert(missingArgumentAttestationRejected,
        'Local AI import requires the cover-letter quality review to attest to the controlling argument and minimum-sufficient evidence');
      let rejected = false;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><script>alert(1)</script></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { rejected = true; }
      assert(rejected, 'scripts in a Local AI result cannot enter the built application workspace');
      let emDashRejected = false;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Led the migration — reducing latency.</li></ul></article></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { emDashRejected = true; }
      assert(emDashRejected, 'an em dash in candidate copy cannot enter a Local AI application');
      let rangeAccepted = true;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Led a 3–5 engineer team from Mar 2022 – Present.</li></ul></article></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { rangeAccepted = false; }
      assert(rangeAccepted, 'date and numeric en-dash ranges remain valid candidate copy');
      let monthToMonthDateRangeAccepted = true;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Software Engineer, May 2023 – June 2026.</li></ul></article></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { monthToMonthDateRangeAccepted = false; }
      assert(monthToMonthDateRangeAccepted, 'month-to-month date ranges remain valid candidate copy');
      let missingReviewRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: validCoverLetterArgument(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { missingReviewRejected = true; }
      assert(missingReviewRejected, 'every Local AI result must record a quality disposition for both documents');
      let fitOnlyRationaleRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: validCoverLetterArgument(),
          qualityReview: {
            resume: { decision: 'drafted', rationale: 'The résumé fits on the required one-page target.' },
            coverLetter: draftedQualityReview().coverLetter,
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { fitOnlyRationaleRejected = true; }
      assert(fitOnlyRationaleRejected, 'page fit alone cannot serve as a quality-completion rationale');
      const structuralOverflowReview = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
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
      const linkedResultTarget = path.join(project.root, 'outside-result.json');
      await fs.promises.writeFile(linkedResultTarget, '{}', 'utf8');
      await fs.promises.unlink(path.join(queued.folder, 'result.json'));
      await fs.promises.symlink(linkedResultTarget, path.join(queued.folder, 'result.json'), process.platform === 'win32' ? 'file' : undefined);
      const linkedStatus = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(linkedStatus.status === 'invalid' && /regular file|link/i.test(linkedStatus.message),
        'a result.json symlink is rejected at the no-follow read boundary');
      const otherProject = await createCanvasProject();
      let crossCanvasRejected = false;
      try { await localApplicationStatus(queued.id, otherProject.canvasFilePath); } catch { crossCanvasRejected = true; }
      assert(crossCanvasRejected, 'a job id cannot be reopened from a different canvas directory');
      await fs.promises.rm(project.root, { recursive: true, force: true });
      await fs.promises.rm(otherProject.root, { recursive: true, force: true });
      return { status: status.status, linkedStatus: linkedStatus.status };
    },
  },
  {
    name: 'Local AI application: a cleaned-up job folder is a terminal polling state, not an IPC ENOENT',
    run: async () => {
      const project = await createCanvasProject();
      const queued = await queueLocalApplicationJob({ job: { title: 'Developer', company: 'Acme' }, careerData: 'Experience.', canvasFilePath: project.canvasFilePath });
      await fs.promises.rm(queued.folder, { recursive: true, force: true });
      const status = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(status.status === 'failed' && /no longer available|cleaned up/i.test(status.message),
        'a removed private job folder produces a terminal, actionable status instead of propagating ENOENT through the IPC handler');
      const cardSource = await fs.promises.readFile(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      assert(cardSource.includes("!['saved', 'failed'].includes(localApplication.status)"),
        'the card does not offer a folder-open action after the app reports that the folder is gone');
      await fs.promises.rm(project.root, { recursive: true, force: true });
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
      const validResumeMain = '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>';
      const result = {
        version: LOCAL_AI_APPLICATION_VERSION, jobId: queued.id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: draftedQualityReview(),
      };
      const resultText = `${JSON.stringify(result)}\n`;
      const canonicalResult = validateLocalApplicationResult(
        result,
        queued.id,
        project.root,
        { title: 'Developer', company: 'Acme' },
      );
      const documentSha256 = {
        resume: sha256(canonicalResult.resumeMainHtml),
        coverLetter: sha256(JSON.stringify(canonicalResult.coverLetter)),
      };
      await fs.promises.writeFile(path.join(queued.folder, 'result.json'), resultText, 'utf8');
      const ready = await localApplicationStatus(queued.id, project.canvasFilePath);
      assert(ready.status === 'completed' && ready.resultSha256 === sha256(resultText),
        'a completed Local AI status supplies the exact result hash so the renderer can wait for a stable final write');
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
          coverLetter: { decision: 'kept_diminishing_returns', rationale: 'No material improvement remains: one controlling argument still uses minimum-sufficient evidence.' },
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
        resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>More relevant evidence.</li></ul></article></section></main>',
        qualityReview: {
          resume: { decision: 'changed_materially', rationale: 'Replaced weaker material with more relevant and specifically supported résumé evidence.' },
          coverLetter: { decision: 'kept_diminishing_returns', rationale: 'No material improvement remains: one controlling argument still uses minimum-sufficient evidence.' },
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
