import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';
import {
  CAREER_TEXT_EXTENSIONS,
  careerFileNotTextError,
  careerTextRefusalMessage,
  isCareerTextFileName,
} from '../../src/utils/careerTextFiles.js';
import { buildHubHoverState, fileSupportedByHub } from '../../src/utils/hubNodeDrop.js';
import { canvasCareerImportCandidates } from '../../src/utils/careerCanvasFileImport.js';

const doc = (id, filePath, filename = filePath.split('/').pop()) => ({ id, type: 'document', data: { filePath, filename } });

export default [
  {
    name: 'career text files: only .txt and .md are career data, judged by the real path',
    run: () => {
      assert(JSON.stringify(CAREER_TEXT_EXTENSIONS) === JSON.stringify(['.txt', '.md']));
      for (const name of ['resume.txt', 'Resume.MD', '/Users/x/Work Experience.md', 'notes.v2.txt']) {
        assert(isCareerTextFileName(name), `${name} is career text`);
      }
      for (const name of ['resume.pdf', 'resume.docx', 'notes.markdown', 'notes.text', 'scan.png', 'README', '.md', 'resume.md.pdf', 'Thing.app', '']) {
        assert(!isCareerTextFileName(name), `${name} is not career text`);
      }
      const jobhub = file => fileSupportedByHub('jobhub', file);
      assert(jobhub({ filePath: '/a/resume.md', filename: 'resume.md' }));
      assert(!jobhub({ filePath: '/a/resume.pdf', filename: 'resume.md' }), 'an edited display name cannot disguise a PDF');
      assert(!jobhub({ filePath: '/a/Notes.app', filename: 'Notes.md' }));
    },
  },
  {
    name: 'career text files: drag cue refuses a whole selection that holds any non-text file',
    run: () => {
      const hub = { id: 'hub', type: 'jobhub', data: {} };
      assert(buildHubHoverState(hub, [doc('a', '/x/a.md'), doc('b', '/x/b.txt')]).kind === 'accept');
      const mixed = buildHubHoverState(hub, [doc('a', '/x/a.md'), doc('b', '/x/resume.pdf')]);
      assert(mixed.kind === 'reject' && mixed.label === 'Text files only (.txt, .md)', JSON.stringify(mixed));
      assert(buildHubHoverState(hub, [doc('b', '/x/resume.pdf')]).kind === 'reject');
      const candidates = canvasCareerImportCandidates([doc('a', '/x/a.md'), doc('b', '/x/resume.pdf'), doc('c', '/x/c.txt')]);
      assert(candidates.map(file => file.nodeId).join() === 'a,c', 'the canvas-file chooser lists only text files');
    },
  },
  {
    name: 'career text files: every refusal names the file and what to fix',
    run: () => {
      const error = careerFileNotTextError('resume.pdf', 'extension');
      assert(error.code === 'CAREER_FILE_NOT_TEXT' && error.reason === 'extension'
        && error.message === 'resume.pdf can\'t be used as career data: it is not a .txt or .md file.');
      assert(careerFileNotTextError('x.md', 'made-up').reason === 'unreadable', 'an unknown reason degrades to unreadable');
      for (const reason of ['sensitive', 'unreadable', 'too_large', 'encoding', 'hidden_chars', 'hidden_markdown', 'code_block', 'markdown', 'empty']) {
        const message = careerTextRefusalMessage('notes.md', reason);
        assert(message.startsWith('notes.md can\'t be used as career data: ') && message.length > 50, `${reason}: ${message}`);
      }
    },
  },
  {
    name: 'career text files: the Job Search drop, picker, and canvas import all use the one text rule',
    run: () => {
      const source = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      assert(source.includes("import { CAREER_TEXT_ONLY_MESSAGE, isCareerTextFileName } from '../utils/careerTextFiles';"));
      assert(/!isCareerTextFileName\(p\)/.test(source), 'admission refuses a non-text path');
      assert(source.includes('accept=".txt,.md,text/plain,text/markdown"'), 'the Mac file picker offers only text files');
      assert(!/PDF, DOCX/.test(source), 'no copy still invites PDF or Word files');
      const jobs = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      assert(jobs.includes("throw careerFileNotTextError(name, 'extension')"), 'the main process refuses non-text files too');
    },
  },
];
