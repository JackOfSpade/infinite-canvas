import { assert, fs, path } from '../test-dependencies.js';

export default [
  {
    name: 'job workflow documentation: bounded shown-history replaces the retired applied-jobs proposal',
    run: () => {
      const root = process.cwd();
      const design = fs.readFileSync(path.join(root, 'docs', 'resume-achievement-mining-design.md'), 'utf8');
      const diagnostics = fs.readFileSync(path.join(root, 'scripts', 'tests', 'job-diagnostics.js'), 'utf8');

      assert(design.includes('## 6. Part D — Search history and disposable application hierarchies')
        && design.includes('canvas-scoped `<canvas>.jobs-history.csv` sidecar')
        && design.includes('search → score → hierarchy → bundle → manual submission → delete the hierarchy')
        && design.includes('A questionable match must re-show a listing'),
      'the design document must describe the implemented, bounded shown-history workflow');
      assert(!design.includes('electron/ipc/appliedJobs.js')
        && !design.includes('src/utils/locationIdentity.js')
        && !design.includes('mark-job-applied')
        && !design.includes('unmark-job-applied'),
      'the design document must not direct future work to retired applied-jobs implementation paths');
      assert(!fs.existsSync(path.join(root, 'electron', 'ipc', 'appliedJobs.js'))
        && !fs.existsSync(path.join(root, 'src', 'utils', 'locationIdentity.js')),
      'retired applied-jobs implementation files must stay absent while the history-based workflow is canonical');
      assert(diagnostics.includes("'LOCAL_AI_APPLICATION_ROUTINE.md'")
        && !diagnostics.includes('CLAUDE_CODE_ROUTINE.md'),
      'job diagnostics must validate the canonical, provider-neutral Local AI routine');
      return { history: 'canvas-scoped', routine: 'provider-neutral' };
    },
  },
];
