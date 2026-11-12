import { assert, fs, path } from '../test-dependencies.js';
import { buildHubHoverState, fileSupportedByHub } from '../../src/utils/hubNodeDrop.js';

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');

const doc = (id, filePath, filename) => ({
  id,
  type: 'document',
  position: { x: 0, y: 0 },
  data: { filePath, ...(filename ? { filename } : {}) },
});

const helper = (data = {}) => ({ id: 'helper-1', type: 'interviewhelper', position: { x: 0, y: 0 }, data });

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
    name: 'fileSupportedByHub applies the career-text rule to interviewhelper targets',
    run: () => {
      assert(fileSupportedByHub('interviewhelper', { filePath: '/a/career data.md', filename: 'career data.md' }) === true, '.md accepted');
      assert(fileSupportedByHub('interviewhelper', { filePath: '/a/notes.txt', filename: 'notes.txt' }) === true, '.txt accepted');
      assert(fileSupportedByHub('interviewhelper', { filePath: '/a/photo.pdf', filename: 'photo.pdf' }) === false, '.pdf refused');
      assert(fileSupportedByHub('interviewhelper', { filePath: '/a/photo.png', filename: 'photo.png' }) === false, '.png refused');
      // A renamed bundle is still a bundle: the real path decides.
      assert(fileSupportedByHub('interviewhelper', { filePath: '/a/Thing.app/', filename: 'career.md' }) === false, '.app path refused even when the file is named .md');
      assert(fileSupportedByHub('interviewhelper', { filePath: '/a/career.md', filename: 'Thing.app' }) === false, '.app display name refused');
      return { verified: 6 };
    },
  },
  {
    name: 'buildHubHoverState paints the career-data cue for an interviewhelper target',
    run: () => {
      sameVerdict(
        buildHubHoverState(helper({}), [doc('d1', '/a/career data.md')]),
        'accept', 'Use as career data', 'a .md document node accepts',
      );
      sameVerdict(
        buildHubHoverState(helper({}), [doc('d1', '/a/notes.txt')]),
        'accept', 'Use as career data', 'a .txt document node accepts',
      );
      sameVerdict(
        buildHubHoverState(helper({}), [doc('d1', '/a/career.md'), doc('d2', '/a/cv.pdf')]),
        'reject', 'Text files only (.txt, .md)', 'mixed .md+.pdf rejects',
      );
      sameVerdict(
        buildHubHoverState(helper({}), [doc('d1', '/a/career.md', 'Sneaky.app')]),
        'reject', 'Text files only (.txt, .md)', 'a disguised .app rejects',
      );
      sameVerdict(
        buildHubHoverState(helper({ locked: true }), [doc('d1', '/a/career.md')]),
        'reject', 'Locked', 'locked Helper rejects',
      );
      sameVerdict(
        buildHubHoverState(helper({}), [{ id: 't1', type: 'text', data: {} }]),
        'reject', 'Unsupported component', 'a non-document node keeps the generic reject',
      );
      // The Job Board cue must not have been re-labelled by the new branch.
      sameVerdict(
        buildHubHoverState({ id: 'board-1', type: 'jobboard', data: {} }, [doc('d1', '/a/career.md')]),
        'accept', 'Use for applications', 'jobboard label unchanged',
      );
      return { verified: 7 };
    },
  },
  {
    name: 'useDragCorrections routes file drags onto an interviewhelper as a career-files hub event',
    run: () => {
      const source = read('src/hooks/useDragCorrections.js');
      assert(/const HUB_DROP_TARGET_TYPES = new Set\(\['jobhub', 'sellhub'\]\);/.test(source),
        'hub type set still excludes interviewhelper (non-file drags are not intercepted)');
      const finder = scopeOf(source, 'function findHubDropTarget(', 'function findGroupDropTarget(');
      assert(/if \(filePayloadFromDraggedNodes\(dragSet\)\.length > 0\) \{/.test(finder),
        'interviewhelper is only resolved for a drag carrying file payloads');
      assert(/\(n\.type === 'jobboard' \|\| n\.type === 'interviewhelper'\) && n\.id !== dragged\.id/.test(finder),
        'the file-carrying loop resolves an interviewhelper that is not the dragged node');
      assert(finder.indexOf("n.type === 'interviewhelper'") > finder.indexOf('HUB_DROP_TARGET_TYPES.has(n.type)'),
        'jobhub/sellhub resolution keeps priority over interviewhelper');

      const stop = scopeOf(source, 'const onNodeDragStop = useCallback(', '// --- sub-canvas (group) absorption ---');
      const helperBranch = scopeOf(
        stop,
        "targetHub.type === 'interviewhelper' &&",
        'if (targetHub && filePayload.length > 0) {',
      );
      assert(/const verdict = buildHubHoverState\(targetHub, dragSet\);/.test(helperBranch),
        'the interviewhelper branch evaluates the hover verdict');
      assert(/const dropMode = 'career-files';/.test(helperBranch),
        'the interviewhelper branch uses mode career-files');
      assert(/filePayload\.filter\(file => fileSupportedByHub\('interviewhelper', file\)\)/.test(helperBranch),
        'accepted files are filtered by the interviewhelper career-text rule');
      assert(/document\.dispatchEvent\(new CustomEvent\('canvas-file-nodes-dropped-on-hub', \{\s*detail: \{\s*hubId: targetHub\.id,\s*hubType: targetHub\.type,\s*files: acceptedFiles,\s*mode: dropMode,/.test(helperBranch),
        'the branch dispatches the hub event carrying hubId/hubType/files/mode');
      assert(/if \(!verdict \|\| verdict\.kind !== 'accept'\) \{\s*restoreDragStartPositions\(draggedIds\);\s*EventLogger\.log\(`Rejected \$\{filePayload\.length\} document node\(s\) for interviewhelper/.test(helperBranch),
        'a rejected Helper drop snaps back and logs without dispatching');
      assert(/restoreDragStartPositions\(draggedIds\);\s*EventLogger\.log\(`Dropped \$\{acceptedFiles\.length\}\/\$\{filePayload\.length\} document node\(s\) onto \$\{targetHub\.type\}/.test(helperBranch),
        'an accepted Helper drop restores the dragged node positions instead of consuming them');
      assert(!/getHubFileDropMode|getHubDropRejectLabel/.test(helperBranch),
        'interviewhelper is not routed through the jobhub/sellhub lifecycle rules');
      assert(stop.indexOf("targetHub.type === 'interviewhelper' &&") < stop.indexOf('if (targetHub && filePayload.length > 0) {'),
        'the interviewhelper branch runs before the generic jobhub/sellhub branch');
      return { verified: true };
    },
  },
];
