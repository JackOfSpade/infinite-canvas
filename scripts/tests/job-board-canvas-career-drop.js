import { assert, fs, path } from '../test-dependencies.js';
import {
  approveJobBoardCareerOverride,
  beginJobBoardCareerOverride,
  failJobBoardCareerOverride,
  jobBoardCareerDropVerdict,
} from '../../src/utils/jobBoardCareerOverride.js';
import { buildHubHoverState, fileSupportedByHub } from '../../src/utils/hubNodeDrop.js';

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');
const SNAPSHOT = 'a'.repeat(64);

function compilingBoard() {
  const record = beginJobBoardCareerOverride({}, {
    nodeId: 'board-1',
    filePaths: ['/tmp/cv.md'],
    fileNames: ['cv.md'],
  });
  assert(record?.pending?.status === 'compiling', 'begin helper must yield a compiling pending record');
  return { jobBoardCareerOverride: record };
}

function approvedBoard() {
  const board = compilingBoard();
  const record = approveJobBoardCareerOverride(board, {
    careerSnapshotId: SNAPSHOT,
    manualAiRunId: board.jobBoardCareerOverride.pending.manualAiRunId,
  });
  assert(record?.approved?.careerSnapshotId === SNAPSHOT, 'approve helper must yield an approved record');
  return { jobBoardCareerOverride: record };
}

function failedBoard() {
  const board = compilingBoard();
  const record = failJobBoardCareerOverride(board, {
    manualAiRunId: board.jobBoardCareerOverride.pending.manualAiRunId,
    error: 'boom',
  });
  assert(record?.pending?.status === 'failed', 'fail helper must yield a failed pending record');
  return { jobBoardCareerOverride: record };
}

const doc = (id, filePath, filename) => ({
  id,
  type: 'document',
  position: { x: 0, y: 0 },
  data: { filePath, ...(filename ? { filename } : {}) },
});

const board = (data = {}) => ({ id: 'board-1', type: 'jobboard', position: { x: 0, y: 0 }, data });

function sameVerdict(actual, kind, label, message) {
  assert(actual && actual.kind === kind && actual.label === label,
    `${message} (got ${JSON.stringify(actual)})`);
}

function scopeOf(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `could not locate ${startMarker}`);
  return source.slice(start, end);
}

export default [
  {
    name: 'jobBoardCareerDropVerdict accepts an idle or approved Board and rejects every busy/recoverable/locked state',
    run: () => {
      sameVerdict(jobBoardCareerDropVerdict({}), 'accept', 'Use for applications', 'empty Board accepts');
      sameVerdict(jobBoardCareerDropVerdict(approvedBoard()), 'accept', 'Use for applications', 'approved Board accepts a replacement');
      // Without a local run id a live compile reads as interrupted.
      sameVerdict(jobBoardCareerDropVerdict(compilingBoard()), 'reject', 'Finish current career data first', 'pending compile rejects');
      sameVerdict(jobBoardCareerDropVerdict(failedBoard()), 'reject', 'Retry or discard first', 'failed compile rejects');
      sameVerdict(jobBoardCareerDropVerdict({ locked: true }), 'reject', 'Locked', 'locked Board rejects');
      sameVerdict(jobBoardCareerDropVerdict({ ...approvedBoard(), locked: true }), 'reject', 'Locked', 'lock wins over approved');
      return { verified: 6 };
    },
  },
  {
    name: 'fileSupportedByHub applies the career-text rule to jobboard targets',
    run: () => {
      assert(fileSupportedByHub('jobboard', { filePath: '/a/cv.md', filename: 'cv.md' }) === true, '.md accepted');
      assert(fileSupportedByHub('jobboard', { filePath: '/a/cv.txt', filename: 'cv.txt' }) === true, '.txt accepted');
      assert(fileSupportedByHub('jobboard', { filePath: '/a/photo.png', filename: 'photo.png' }) === false, '.png refused');
      assert(fileSupportedByHub('jobboard', { filePath: '/a/cv.md', filename: 'Thing.app' }) === false, '.app display name refused');
      assert(fileSupportedByHub('jobboard', { filePath: '/a/Thing.app/', filename: 'cv.md' }) === false, '.app path refused');
      return { verified: 5 };
    },
  },
  {
    name: 'buildHubHoverState gives a jobboard target the career override verdict',
    run: () => {
      sameVerdict(buildHubHoverState(board({}), [doc('d1', '/a/cv.md')]), 'accept', 'Use for applications', '.md doc on idle Board accepts');
      sameVerdict(
        buildHubHoverState(board({}), [doc('d1', '/a/cv.md'), doc('d2', '/a/photo.png')]),
        'reject', 'Text files only (.txt, .md)', 'mixed text/image selection rejects',
      );
      sameVerdict(
        buildHubHoverState(board({}), [doc('d1', '/a/cv.md', 'Sneaky.app')]),
        'reject', 'Text files only (.txt, .md)', '.app-named file rejects',
      );
      sameVerdict(buildHubHoverState(board({ locked: true }), [doc('d1', '/a/cv.md')]), 'reject', 'Locked', 'locked Board rejects');
      sameVerdict(buildHubHoverState(board(failedBoard()), [doc('d1', '/a/cv.md')]), 'reject', 'Retry or discard first', 'failed Board rejects');
      // Must not crash with no file payload.
      const empty = buildHubHoverState(board({}), [{ id: 't1', type: 'text', data: {} }]);
      assert(empty?.kind === 'reject', 'non-file payload never accepts');
      // jobhub labels unchanged.
      sameVerdict(buildHubHoverState({ id: 'h', type: 'jobhub', data: {} }, [doc('d1', '/a/cv.md')]), 'accept', 'Use as resume', 'jobhub label unchanged');
      return { verified: 7 };
    },
  },
  {
    name: 'useDragCorrections routes file drags onto a jobboard as a career-override hub event',
    run: () => {
      const source = read('src/hooks/useDragCorrections.js');
      assert(/const HUB_DROP_TARGET_TYPES = new Set\(\['jobhub', 'sellhub'\]\);/.test(source), 'hub type set unchanged');
      const finder = scopeOf(source, 'function findHubDropTarget(', 'function findGroupDropTarget(');
      assert(/if \(filePayloadFromDraggedNodes\(dragSet\)\.length > 0\) \{/.test(finder)
        && /n\.type === 'jobboard'/.test(finder),
        'jobboard is only resolved for a drag carrying file payloads');
      assert(finder.indexOf("n.type === 'jobboard'") > finder.indexOf('HUB_DROP_TARGET_TYPES.has(n.type)'),
        'jobhub/sellhub resolution keeps priority over jobboard');
      const stop = scopeOf(source, 'const onNodeDragStop = useCallback(', '// --- sub-canvas (group) absorption ---');
      assert(/if \(targetHub && targetHub\.type === 'jobboard' && filePayload\.length > 0\) \{/.test(stop), 'jobboard drop branch exists');
      const boardBranch = scopeOf(stop, "targetHub.type === 'jobboard' &&", 'if (targetHub && filePayload.length > 0) {');
      assert(/const verdict = buildHubHoverState\(targetHub, dragSet\);/.test(boardBranch), 'branch evaluates the hover verdict');
      assert(/const dropMode = 'career-override';/.test(boardBranch), 'branch uses mode career-override');
      assert(/hubType: targetHub\.type,/.test(boardBranch), 'dispatch takes hubType from the target');
      assert(!/getHubFileDropMode|getHubDropRejectLabel/.test(boardBranch), 'jobboard is not routed through hub lifecycle rules');
      assert(/restoreDragStartPositions\(draggedIds\);\s*EventLogger\.log\(`Rejected \$\{filePayload\.length\} document node\(s\) for jobboard/.test(boardBranch),
        'a rejected Board drop snaps back and logs');
      const gate = 'HUB_DROP_TARGET_TYPES.has(node.type)';
      const drag = scopeOf(source, 'const onNodeDrag = useCallback(', 'const onNodeDragStop = useCallback(');
      assert(drag.includes(gate) && stop.includes(gate), 'gate string stays in onNodeDrag and onNodeDragStop');
      return { verified: true };
    },
  },
  {
    name: 'JobBoardNode compiles a career override from a canvas document-node drop and paints the accept cue',
    run: () => {
      const source = read('src/nodes/JobBoardNode.jsx');
      const match = source.match(/useEffect\(\(\) => \{\s*const handler = \(e\) => \{([\s\S]*?)\};\s*document\.addEventListener\('canvas-file-nodes-dropped-on-hub', handler\);\s*return \(\) => document\.removeEventListener\('canvas-file-nodes-dropped-on-hub', handler\);/);
      assert(match, 'Board registers and removes a canvas-file-nodes-dropped-on-hub listener');
      const body = match[1];
      assert(/e\.detail\?\.hubId !== id \|\| e\.detail\?\.hubType !== 'jobboard'\) return;/.test(body), 'listener checks hubId and hubType === jobboard');
      assert(/void compileCareerOverride\(\{\s*filePaths: files\.map\(file => file\.filePath\),/.test(body), 'listener calls compileCareerOverride with file paths');
      assert(/dragHover=\{data\.dragHover \|\| null\} dropsBlocked=\{data\.dragHover\?\.kind !== 'accept'\}/.test(source),
        'HubContainer receives dragHover and only unblocks for an accept verdict');
      return { verified: true };
    },
  },
];
