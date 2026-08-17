import { assert, fs, path, LOCAL_AI_APPLICATION_VERSION, localApplicationStatus, queueLocalApplicationJob, validateLocalApplicationResult } from '../test-dependencies.js';

export default [
  {
    name: 'Local AI application: queued handoff is app-owned and supplies a strict routine',
    run: async () => {
      const queued = await queueLocalApplicationJob({
        job: { title: 'Developer', company: 'Acme', snippet: 'Build reliable systems.' },
        careerData: 'Built reliable systems with measurable outcomes.', additionalNotes: 'Prefer a concise letter.',
      });
      assert(queued.status === 'queued' && /^[a-f0-9-]{36}$/i.test(queued.id), 'queue creates a UUID-backed Local AI job');
      const [manifest, input, prompt] = await Promise.all([
        fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'),
        fs.promises.readFile(path.join(queued.folder, 'input.json'), 'utf8'),
        fs.promises.readFile(path.join(queued.folder, 'CLAUDE_CODE_PROMPT.md'), 'utf8'),
      ]);
      assert(JSON.parse(manifest).status === 'queued' && JSON.parse(input).jobId === queued.id,
        'job manifest and input are tied to the exact queued job id');
      assert(prompt.includes('result.json') && prompt.includes('Do not edit this application’s source code'),
        'routine constrains Claude Code to one result file instead of project edits');
      await fs.promises.rm(queued.folder, { recursive: true, force: true });
      return { id: queued.id };
    },
  },
  {
    name: 'Local AI application: result contract rejects unsafe résumé markup',
    run: () => {
      const id = '123e4567-e89b-42d3-a456-426614174000';
      const good = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        resumeMainHtml: '<main class="page"><section class="section">Evidence</section></main>',
        coverLetter: { paragraphs: ['A concise factual letter.'] },
      }, id);
      assert(good.coverLetter.paragraphs.length === 1, 'valid structured output is normalized');
      let rejected = false;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', resumeMainHtml: '<main class="page"><script>alert(1)</script></main>' }, id);
      } catch { rejected = true; }
      assert(rejected, 'scripts in a Local AI result cannot enter the built application workspace');
      return { rejected };
    },
  },
  {
    name: 'Local AI application: status treats malformed result.json as invalid without importing it',
    run: async () => {
      const queued = await queueLocalApplicationJob({ job: { title: 'Developer', company: 'Acme' }, careerData: 'Experience.' });
      await fs.promises.writeFile(path.join(queued.folder, 'result.json'), '{bad json', 'utf8');
      const status = await localApplicationStatus(queued.id);
      assert(status.status === 'invalid' && /JSON|Unexpected/i.test(status.message),
        'bad result JSON is surfaced as an actionable invalid state');
      await fs.promises.rm(queued.folder, { recursive: true, force: true });
      return { status: status.status };
    },
  },
];
