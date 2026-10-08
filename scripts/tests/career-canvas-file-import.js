import { assert, fs, path } from '../test-dependencies.js';
import {
  canvasCareerImportCandidates,
  careerCanvasImportAdmissionSucceeded,
  reconcileCareerCanvasFileSelections,
  selectedCareerCanvasFiles,
  toggleCareerCanvasFileSelection,
} from '../../src/utils/careerCanvasFileImport.js';
import { isAppBundlePathOrName } from '../../src/utils/hubNodeDrop.js';

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');

export default [
  {
    name: 'accessible canvas career import enumerates only compatible file cards on the current canvas level',
    run: () => {
      const source = read('src/nodes/JobSearchNode.jsx');
      assert(
        /const canvasNodes = useStore\(useCallback\(\(state\) => state\.nodes, \[\]\)\);/.test(source)
          && /canvasCareerImportCandidates\(canvasNodes\)/.test(source)
          && /canvasCareerImportCandidates\(getNodes\(\)\)/.test(source),
        'the picker must read the active React Flow level, filter through the same jobhub file policy, and re-resolve that active level on confirmation',
      );
      return { currentLevelOnly: true };
    },
  },
  {
    name: 'accessible canvas career import has an explicit no-file, one-file, and multi-file selection UI',
    run: () => {
      const source = read('src/components/CareerCanvasFileImportDialog.jsx');
      assert(
        /No compatible file cards are on this canvas level/.test(source)
          && /type="checkbox"/.test(source)
          && /checked=\{checked\}/.test(source)
          && /aria-label=\{`Select \$\{file\.filename\} at \$\{file\.filePath\}`\}/.test(source)
          && /title=\{file\.filePath\}/.test(source)
          && /selectedCount === 1 \? 'Import 1 file' : `Import \$\{selectedCount\} files`/.test(source)
          && /disabled=\{importDisabled \|\| selectedCount === 0\}/.test(source),
        'the dialog must explain an empty canvas, expose a real checkbox for every candidate, disambiguate duplicate names by path, pluralize the confirmation, and require an explicit selection',
      );
      return { emptyOneManyCovered: true };
    },
  },
  {
    name: 'accessible canvas career import candidate and consent helpers reject disguised apps and stale relinks',
    run: () => {
      const safe = { id: 'safe', type: 'document', data: { filename: 'Work Experience.md', filePath: '/career/Work Experience.md' } };
      const disguisedBundle = { id: 'bundle', type: 'document', data: { filename: 'notes.md', filePath: '/Applications/Resume Tool.app/' } };
      const candidates = canvasCareerImportCandidates([safe, disguisedBundle]);
      const selected = toggleCareerCanvasFileSelection([], candidates[0]);
      const relinked = [{ ...safe, data: { ...safe.data, filePath: '/career/Replaced Experience.md' } }];
      const afterRelink = canvasCareerImportCandidates(relinked);
      assert(candidates.length === 1 && candidates[0].nodeId === 'safe'
        && selected.length === 1
        && reconcileCareerCanvasFileSelections(selected, afterRelink).length === 0
        && selectedCareerCanvasFiles(afterRelink, selected).length === 0
        && isAppBundlePathOrName('Foo.app ')
        && isAppBundlePathOrName('Foo.app/')
        && isAppBundlePathOrName('Foo.app\\')
        && !isAppBundlePathOrName('Foo.app-not-a-bundle'),
      'a display-name-disguised .app is excluded, and a same-id path replacement loses its prior consent');
      return { disguisedBundleRejected: true, relinkDeselected: true };
    },
  },
  {
    name: 'accessible canvas career import shares the exact document-node ingress and compiler-first path',
    run: () => {
      const source = read('src/nodes/JobSearchNode.jsx');
      assert(
        /const acceptCanvasDocumentCareerFiles = useCallback\(\(files, source\) =>/.test(source)
          && /return acceptCareerFiles\([\s\S]*?droppedFiles\.map\(file => file\.filePath\)[\s\S]*?droppedFiles\.map\(file => file\.filename\)[\s\S]*?\) === true;/.test(source)
          && /acceptCanvasDocumentCareerFiles\(e\.detail\?\.files \|\| \[\], 'Document-node drop'\)/.test(source)
          && /acceptCanvasDocumentCareerFiles\(selectedFiles, 'Canvas-file import'\)/.test(source),
        'both pointer drop and accessible confirmation must converge on one ingress which alone calls acceptCareerFiles',
      );
      assert(
        /data\.locked\s*\? 'locked'/.test(source)
          && /dropLockReason/.test(source)
          && /PROCESSING_STATES\.includes\(currentHubState\)/.test(source),
        'the shared ingress must retain locked, initial-drop, and processing fences');
      return { sharedIngress: true };
    },
  },
  {
    name: 'accessible canvas career import closes only after the one synchronous career admission wins',
    run: () => {
      const source = read('src/nodes/JobSearchNode.jsx');
      assert(
        /if \(initialDropAcceptedRef\.current \|\| dropLockReason \|\| processingRunsRef\.current\.active\)[\s\S]*?return false;/.test(source)
          && /if \(valid\.length === 0\)[\s\S]*?return false;/.test(source)
          && /initialDropAcceptedRef\.current = true;[\s\S]*?return true;/.test(source)
          && /return acceptCareerFiles\([\s\S]*?\) === true;/.test(source)
          && /careerCanvasImportAdmissionSucceeded\([\s\S]*?acceptCanvasDocumentCareerFiles\(selectedFiles, 'Canvas-file import'\)[\s\S]*?\)\) \{\s*setCanvasFileImportOpen\(false\);/.test(source),
        'the first synchronous admission claims the latch and may close the dialog; rejected or concurrent second clicks cannot report success',
      );
      return { doubleAdmissionCannotClose: true };
    },
  },
  {
    name: 'accessible canvas career import uses a strict boolean admission receipt under repeated confirmation',
    run: () => {
      let claimed = false;
      const attemptAdmission = () => {
        if (claimed) return false;
        claimed = true;
        return true;
      };
      const first = careerCanvasImportAdmissionSucceeded(attemptAdmission());
      const second = careerCanvasImportAdmissionSucceeded(attemptAdmission());
      assert(first === true && second === false
        && careerCanvasImportAdmissionSucceeded(undefined) === false
        && careerCanvasImportAdmissionSucceeded('true') === false,
      'only the first claimed synchronous admission may close the chooser; false, absent, and truthy non-boolean replies remain open');
      return { firstCloses: first, repeatedDoesNotClose: !second };
    },
  },
  {
    name: 'accessible canvas career import binds consent to both card identity and its exact current path',
    run: () => {
      const nodeSource = read('src/nodes/JobSearchNode.jsx');
      const dialogSource = read('src/components/CareerCanvasFileImportDialog.jsx');
      assert(
        /toggleCareerCanvasFileSelection\(current, file\)/.test(nodeSource)
          && /selectedCareerCanvasFiles\(liveFiles, selectedCanvasFileSelections\)/.test(nodeSource)
          && /reconcileCareerCanvasFileSelections\(current, canvasCareerFiles\)/.test(nodeSource)
          && /sameCareerCanvasFileSelection\(selection, file\)/.test(dialogSource),
        'a checked card must carry its exact filePath through both live confirmation and rendering, so a relinked same-id card is deselected and cannot be imported without a new click',
      );
      return { relinkRequiresFreshSelection: true };
    },
  },
  {
    name: 'accessible canvas career import dialog is semantic, keyboard-safe, and returns focus',
    run: () => {
      const source = read('src/components/CareerCanvasFileImportDialog.jsx');
      assert(
        /role="dialog"/.test(source)
          && /aria-modal="true"/.test(source)
          && /useEscapeToClose/.test(source)
          && /const trapFocus = useCallback/.test(source)
          && /previousFocusRef\.current = document\.activeElement/.test(source)
          && /previous\.focus\(\)/.test(source),
        'the dialog must be announced as modal, close on Escape, trap Tab, and restore the invoking control focus');
      return { accessibleModal: true };
    },
  },
];
