import { assert, fs, path } from '../test-dependencies.js';
import { discardLocalAiJobsRecursively } from '../../src/utils/canvasInteractions.js';

export default [
  {
    name: 'Local AI deletion cleanup recursively withdraws removed job cards without touching retained locked branches',
    run: () => {
      const calls = [];
      const removed = [
        { id: 'root-card', type: 'jobcard', data: { localApplication: { id: 'root-job', canvasFilePath: '/tmp/root.json' } } },
        { id: 'legacy-card', type: 'jobcard', data: { localApplication: { id: 'legacy-job' } } },
        { id: 'locked-card', type: 'jobcard', data: { localApplication: { id: 'locked-job', canvasFilePath: '/tmp/locked.json' } } },
        {
          id: 'nested-group', type: 'group', data: {
            canvasData: { nodes: [
              { id: 'nested-card', type: 'jobcard', data: { localApplication: { id: 'nested-job', canvasFilePath: '/tmp/nested.json' } } },
            ] },
          },
        },
      ];
      const requested = discardLocalAiJobsRecursively(
        removed,
        new Set(['locked-card']),
        (args) => { calls.push(args); return { success: true }; },
      );
      assert(requested === 2,
        'only deleted Local AI cards with an owned saved-canvas job request cleanup');
      assert(JSON.stringify(calls) === JSON.stringify([
        { nodeId: 'root-card', jobId: 'root-job', canvasFilePath: '/tmp/root.json' },
        { nodeId: 'nested-card', jobId: 'nested-job', canvasFilePath: '/tmp/nested.json' },
      ]), 'cleanup covers nested canvases, preserves locked branches, and never invents a path for legacy state');

      const clearSource = fs.readFileSync(path.resolve('src/hooks/useCanvasActions.js'), 'utf8');
      const deleteSource = fs.readFileSync(path.resolve('src/hooks/useCanvasOSDeletion.js'), 'utf8');
      assert(clearSource.includes('discardLocalAiJobsRecursively(allNodes, lockedIds)'),
        'Clear explicitly cleans Local AI handoffs because it bypasses React Flow onNodesDelete');
      assert(deleteSource.includes('discardLocalAiJobsRecursively(deletedNodes)'),
        'normal React Flow deletion routes use the same cleanup helper');
      return { requested, jobIds: calls.map(({ jobId }) => jobId) };
    },
  },
];
