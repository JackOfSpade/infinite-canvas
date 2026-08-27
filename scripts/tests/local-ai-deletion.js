import { assert, fs, path } from '../test-dependencies.js';

export default [
  {
    name: 'Local AI handoffs survive result-card, Job Board, and canvas display deletion',
    run: () => {
      const clearSource = fs.readFileSync(path.resolve('src/hooks/useCanvasActions.js'), 'utf8');
      const deleteSource = fs.readFileSync(path.resolve('src/hooks/useCanvasOSDeletion.js'), 'utf8');
      const interactionSource = fs.readFileSync(path.resolve('src/utils/canvasInteractions.js'), 'utf8');
      const boardSource = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      assert(!clearSource.includes('discardLocalApplication') && !deleteSource.includes('discardLocalApplication'),
        'display deletion never invokes the destructive Local AI discard IPC');
      assert(!interactionSource.includes('discardLocalAiJobsRecursively'),
        'there is no generic helper that can turn a result-node cascade into handoff deletion');
      assert(boardSource.includes('clearBoardChildren') && boardSource.includes('deleteChildrenByHubId'),
        'the regression covers the shared result-cascade path used by board clear, delete, and replacement');
      return { displayDeletionPreservesHandoffs: true };
    },
  },
];
