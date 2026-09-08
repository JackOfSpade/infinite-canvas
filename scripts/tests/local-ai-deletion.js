import { assert, collectOrphanTextDocumentPaths, collectRemainingTextDocumentPaths, collectSurvivingRepresentedPaths, collectTrashEligiblePaths, fs, path } from '../test-dependencies.js';

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
  {
    name: 'Deleting a duplicate document never offers to trash its surviving local file',
    run: () => {
      const deletedDocument = {
        id: 'deleted-doc', type: 'document', data: { filePath: '/work/shared.md' },
      };
      const survivingDuplicate = {
        id: 'surviving-doc', type: 'document', data: { filePath: '/work/shared.md' },
      };
      assert(collectTrashEligiblePaths([deletedDocument], [deletedDocument, survivingDuplicate]).length === 0,
        'the pre-commit React Flow node snapshot must not make a deleted duplicate eligible for trash while another ID represents the same file');
      assert(collectSurvivingRepresentedPaths([deletedDocument], [deletedDocument, survivingDuplicate]).join(',') === '/work/shared.md',
        'the main-process trash guard receives the surviving duplicate as a defense-in-depth protected path');
      assert(collectTrashEligiblePaths([deletedDocument], []).join(',') === '/work/shared.md',
        'the last document reference remains eligible for the existing trash-or-keep prompt');

      const deletedFolder = {
        id: 'deleted-folder',
        type: 'group',
        data: {
          filePath: '/work/project',
          canvasData: {
            nodes: [{ id: 'nested-deleted', type: 'document', data: { filePath: '/work/project/notes.md' } }],
          },
        },
      };
      const nestedSurvivor = {
        id: 'nested-survivor', type: 'document', data: { filePath: '/work/project/kept.md' },
      };
      assert(collectTrashEligiblePaths([deletedFolder], [deletedFolder, nestedSurvivor]).length === 0,
        'a folder candidate is suppressed when a separately represented surviving document is known to live beneath it');
      const windowsFolder = { id: 'windows-folder', type: 'group', data: { filePath: 'C:\\work\\project' } };
      const windowsDescendant = { id: 'windows-child', type: 'document', data: { filePath: 'C:\\work\\project\\kept.md' } };
      assert(collectTrashEligiblePaths([windowsFolder], [windowsFolder, windowsDescendant]).length === 0,
        'folder protection recognizes a proper Windows path descendant without treating a sibling prefix as a child');

      const nestedDuplicate = {
        id: 'nested-duplicate', type: 'document', data: { filePath: '/work/shared.md' },
      };
      const nestedGroup = {
        id: 'surviving-group', type: 'group', data: { canvasData: { nodes: [nestedDuplicate] } },
      };
      assert(collectTrashEligiblePaths([deletedDocument], [deletedDocument, nestedGroup, nestedDuplicate]).length === 0,
        'the timing-independent ignored-ID scan also protects a duplicate represented inside a nested canvas');
      return { duplicateProtection: true, folderDescendantProtection: true };
    },
  },
  {
    name: 'Text orphan preflight targets only the last document representation',
    run: () => {
      const deleted = {
        id: 'delete-md', type: 'document', data: { filePath: '/work/shared.md' },
      };
      const duplicate = {
        id: 'keep-md', type: 'document', data: { filePath: '/work/shared.md' },
      };
      assert(collectOrphanTextDocumentPaths([deleted], [deleted, duplicate]).length === 0
        && collectRemainingTextDocumentPaths([deleted], [deleted, duplicate]).join(',') === '/work/shared.md',
      'a surviving duplicate must skip the destructive orphan settlement path');
      assert(collectOrphanTextDocumentPaths([deleted], [deleted]).join(',') === '/work/shared.md',
        'the final markdown representation is the only document path eligible for settlement');
      const nested = {
        id: 'deleted-group', type: 'group', data: { canvasData: { nodes: [deleted] } },
      };
      assert(collectOrphanTextDocumentPaths([nested], [nested, duplicate]).length === 0,
        'a nested deleted document is also protected by a surviving duplicate outside its group');
      return { lastReferenceOnly: true };
    },
  },
];
