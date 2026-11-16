// The generated Application.html editor keeps its own snapshot undo/redo
// history because script rewrites of a panel (Sync, the autosave restore,
// skill-decision toggles) strand the browser's native contenteditable undo.
// jsdom cannot type, so these suites mutate the panel DOM and dispatch input
// events carrying an inputType, exactly what a browser has done by the time
// the editor's input listener runs. Every fixture is synthetic.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildResumeDocument, embedApplicationSyncConfig } from '../../electron/ipc/resumeHtml.js';
import { applicationSyncConfig } from '../../electron/ipc/applicationSync.js';

const LETTER = {
  name: 'Sample Person',
  contact: ['sample@example.test'],
  salutation: 'Dear Hiring Team,',
  closing: 'Sincerely,',
  paragraphs: ['First synthetic letter paragraph.'],
};
const RESUME_MAIN = '<main class="page"><header class="resume-header"><h1 class="name">Sample Person</h1><p class="contact">sample@example.test</p></header><section class="section"><p>Generated résumé line.</p></section></main>';
const BUNDLE = { company: 'Sample Co', candidateName: 'Sample Person', jobUrl: 'https://example.test/job', jobMarkdown: '# Job\n' };
const BASELINE_LINE = 'Generated résumé line.';
const workspaceHtml = docId => buildResumeDocument({
  resumeMainHtml: RESUME_MAIN, coverLetter: LETTER, variantAttrs: '', docId, downloadBundle: BUNDLE,
});
const syncedHtml = docId => {
  const html = workspaceHtml(docId);
  return embedApplicationSyncConfig(html, applicationSyncConfig('a'.repeat(64), { html }));
};

const open = (html, beforeParse) => {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://application-editor-undo.local/Application.html',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.addEventListener('error', event => errors.push(event.error?.message || event.message));
      window.fetch = async () => ({ ok: true, json: async () => ({ success: true, htmlSha256: 'a'.repeat(64) }) });
      window.CSS = { supports: () => true };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.document.fonts = { ready: Promise.resolve(), check: () => true, load: async () => [], status: 'loaded', forEach() {} };
      Object.defineProperty(window, 'print', { value() {} });
      if (beforeParse) beforeParse(window);
    },
  });
  return { dom, errors, document: dom.window.document };
};

const panelFor = (document, kind) => document.querySelector(`[data-ic-document-panel="${kind}"] main`);
const editToggle = document => document.getElementById('ic-edit-toggle');
const history = dom => dom.window.icEditHistory;
const depthOf = (dom, kind) => {
  const depth = history(dom).depth(kind);
  return { past: depth.past, future: depth.future };
};
const textNodeOf = panel => panel.querySelector('.section p') || panel.querySelector('p');
const lineOf = panel => textNodeOf(panel)?.textContent ?? '';
const dispatchInput = (dom, panel, inputType) => {
  const { window } = dom;
  let event;
  if (typeof window.InputEvent === 'function') {
    event = new window.InputEvent('input', { bubbles: true, cancelable: true, inputType });
    if (event.inputType !== inputType) Object.defineProperty(event, 'inputType', { configurable: true, value: inputType });
  } else {
    event = new window.Event('input', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'inputType', { configurable: true, value: inputType });
  }
  panel.dispatchEvent(event);
};
const placeCaret = (dom, panel, offset) => {
  try {
    const selection = dom.window.getSelection();
    const range = dom.window.document.createRange();
    const element = textNodeOf(panel);
    range.setStart(element.firstChild, Math.min(offset, element.textContent.length));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // jsdom's Selection support is partial; caret assertions are conditional.
  }
};
const mutateText = (dom, panel, text, inputType = 'insertFromPaste') => {
  let target = textNodeOf(panel);
  if (!target) {
    target = dom.window.document.createElement('p');
    panel.appendChild(target);
  }
  target.textContent = text;
  placeCaret(dom, panel, 3);
  dispatchInput(dom, panel, inputType);
};
const keydown = (dom, target, init) => {
  const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const noPageErrors = errors => assert.deepEqual(errors, [], `the page script must not throw: ${errors.join(' | ')}`);

export default [
  {
    name: 'undo walks 30 separate edits back to the baseline markup and redo replays them',
    run() {
      const { dom, errors, document } = open(workspaceHtml('undo-depth-a'));
      try {
        noPageErrors(errors);
        editToggle(document).click();
        const panel = panelFor(document, 'resume');
        const baselineHtml = panel.innerHTML;
        assert.equal(lineOf(panel), BASELINE_LINE);
        for (let index = 1; index <= 30; index += 1) mutateText(dom, panel, `Pasted line ${index}`);
        const finalHtml = panel.innerHTML;
        assert.equal(lineOf(panel), 'Pasted line 30');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 31, future: 0 });
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(lineOf(panel), 'Pasted line 29');
        const selection = dom.window.getSelection();
        assert.ok(selection && selection.rangeCount === 1, 'undo restores a selection');
        assert.equal(selection.anchorNode.nodeValue, 'Pasted line 29', 'undo restores the caret into the restored markup');
        assert.equal(selection.anchorOffset, 3);
        for (let index = 0; index < 29; index += 1) assert.equal(history(dom).undo('resume'), true);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 1, future: 30 });
        assert.equal(panel.innerHTML, baselineHtml, 'undo must restore the exact baseline markup');
        assert.equal(lineOf(panel), BASELINE_LINE);
        assert.equal(selection.anchorNode, panel, 'a baseline without a selection puts the caret at the end of the panel');
        assert.equal(selection.anchorOffset, panel.childNodes.length);
        assert.equal(history(dom).undo('resume'), false, 'undo at the baseline is a no-op');
        for (let index = 0; index < 30; index += 1) assert.equal(history(dom).redo('resume'), true);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 31, future: 0 });
        assert.equal(panel.innerHTML, finalHtml, 'redo must replay the final markup');
        assert.equal(lineOf(panel), 'Pasted line 30');
        assert.equal(history(dom).redo('resume'), false, 'redo at the top is a no-op');
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'typing coalesces inside 1000 ms while other input kinds and later keystrokes record their own steps',
    run() {
      const { dom, errors, document } = open(workspaceHtml('undo-coalesce-b'));
      try {
        noPageErrors(errors);
        editToggle(document).click();
        const panel = panelFor(document, 'resume');
        let clock = 1000;
        dom.window.Date.now = () => clock;
        mutateText(dom, panel, 'Typed 1', 'insertText');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 2, future: 0 });
        clock = 1200;
        mutateText(dom, panel, 'Typed 2', 'insertText');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 2, future: 0 }, 'a keystroke under a second later must coalesce');
        clock = 1600;
        mutateText(dom, panel, 'Typed 3', 'deleteContentBackward');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 3, future: 0 }, 'a different input kind records its own step');
        clock = 3000;
        mutateText(dom, panel, 'Typed 4', 'insertText');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 4, future: 0 }, 'typing after the 1000 ms window records a new step');
        clock = 3100;
        mutateText(dom, panel, 'Pasted after typing', 'insertFromPaste');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 5, future: 0 }, 'paste always records its own step');
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(lineOf(panel), 'Typed 4');
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(lineOf(panel), 'Typed 3');
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(lineOf(panel), 'Typed 2');
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(lineOf(panel), BASELINE_LINE, 'the coalesced typing run undoes as one step');
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'Sync rewriting the panel keeps the edits made before it undoable',
    run: async () => {
      const { dom, errors, document } = open(syncedHtml('undo-sync-c'));
      try {
        noPageErrors(errors);
        const syncButton = document.getElementById('ic-sync-btn');
        assert.equal(syncButton.disabled, false, 'a fresh unsynced page offers Sync');
        editToggle(document).click();
        const panel = panelFor(document, 'resume');
        for (let index = 1; index <= 4; index += 1) mutateText(dom, panel, `Before sync ${index}`);
        syncButton.click();
        await new Promise(resolve => dom.window.setTimeout(resolve, 20));
        assert.equal(panel.getAttribute('contenteditable'), null, 'Sync leaves edit mode');
        assert.equal(lineOf(panel), 'Before sync 4', 'the synced rewrite preserves the text');
        assert.ok(history(dom).depth('resume').past >= 5, 'the pre-Sync edits are still in the stack');
        assert.equal(history(dom).undo('resume'), true, 'undo still works after Sync rewrote the panel');
        assert.match(lineOf(panel), /^Before sync [34]$/u, 'the first undo lands on a pre-Sync edit even if Sync replaced the nodes');
        let undos = 1;
        while (history(dom).undo('resume')) undos += 1;
        assert.ok(undos >= 4, `undo must walk back through the pre-Sync edits, reached ${undos}`);
        assert.equal(lineOf(panel), BASELINE_LINE, 'undo reaches the baseline captured before Sync');
        assert.equal(panel.textContent.includes('Before sync'), false);
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'a new edit after undo clears the redo stack',
    run() {
      const { dom, errors, document } = open(workspaceHtml('undo-redo-d'));
      try {
        noPageErrors(errors);
        editToggle(document).click();
        const panel = panelFor(document, 'resume');
        for (const text of ['First edit', 'Second edit', 'Third edit']) mutateText(dom, panel, text);
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(history(dom).undo('resume'), true);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 2, future: 2 });
        mutateText(dom, panel, 'New branch');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 3, future: 0 }, 'a new recorded edit must clear redo');
        assert.equal(history(dom).redo('resume'), false);
        assert.equal(lineOf(panel), 'New branch');
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'the résumé and cover-letter panels keep independent histories',
    run() {
      const { dom, errors, document } = open(workspaceHtml('undo-panels-e'));
      try {
        noPageErrors(errors);
        editToggle(document).click();
        const resumePanel = panelFor(document, 'resume');
        for (let index = 1; index <= 3; index += 1) mutateText(dom, resumePanel, `Resume ${index}`);
        document.querySelector('[data-ic-document-tab="cover"]').click();
        editToggle(document).click();
        const coverPanel = panelFor(document, 'cover');
        for (let index = 1; index <= 3; index += 1) mutateText(dom, coverPanel, `Letter ${index}`);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 4, future: 0 });
        assert.deepEqual(depthOf(dom, 'cover'), { past: 4, future: 0 });
        const coverMarkup = coverPanel.innerHTML;
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(lineOf(resumePanel), 'Resume 2');
        assert.equal(lineOf(coverPanel), 'Letter 3', 'undoing the résumé must not touch the cover letter');
        assert.equal(coverPanel.innerHTML, coverMarkup);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 3, future: 1 });
        assert.deepEqual(depthOf(dom, 'cover'), { past: 4, future: 0 });
        assert.equal(history(dom).undo('cover'), true);
        assert.equal(lineOf(coverPanel), 'Letter 2');
        assert.equal(lineOf(resumePanel), 'Resume 2', 'undoing the letter must not touch the résumé');
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'history keys are claimed inside an editable panel but never in a textarea, select or elsewhere',
    run() {
      const { dom, errors, document } = open(workspaceHtml('undo-targets-f'));
      try {
        noPageErrors(errors);
        editToggle(document).click();
        const panel = panelFor(document, 'resume');
        mutateText(dom, panel, 'Panel edit');
        const panelMarkup = panel.innerHTML;
        const textarea = document.getElementById('ic-edit-notes-resume');
        assert.ok(textarea, 'the edit-notes textarea must render');
        assert.equal(keydown(dom, textarea, { key: 'z', metaKey: true }).defaultPrevented, false,
          'the notes textarea keeps the browser undo');
        assert.equal(keydown(dom, document.body, { key: 'z', ctrlKey: true }).defaultPrevented, false,
          'a key event outside both panels is never intercepted');
        const select = document.querySelector('select');
        if (select) {
          assert.equal(keydown(dom, select, { key: 'z', ctrlKey: true }).defaultPrevented, false,
            'a select keeps the browser behaviour');
        }
        assert.equal(panel.innerHTML, panelMarkup, 'keys outside the panel must not change its markup');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 2, future: 0 });
        assert.equal(keydown(dom, panel, { key: 'z', metaKey: true }).defaultPrevented, true);
        assert.equal(lineOf(panel), BASELINE_LINE);
        assert.equal(keydown(dom, panel, { key: 'y', ctrlKey: true }).defaultPrevented, true);
        assert.equal(lineOf(panel), 'Panel edit');
        assert.equal(keydown(dom, panel, { key: 'z', metaKey: true }).defaultPrevented, true);
        assert.equal(keydown(dom, panel, { key: 'z', metaKey: true, shiftKey: true }).defaultPrevented, true);
        assert.equal(lineOf(panel), 'Panel edit');
        const beforeInput = new dom.window.Event('beforeinput', { bubbles: true, cancelable: true });
        Object.defineProperty(beforeInput, 'inputType', { value: 'historyUndo' });
        panel.dispatchEvent(beforeInput);
        assert.equal(beforeInput.defaultPrevented, true, 'beforeinput historyUndo is handled by the editor');
        assert.equal(lineOf(panel), BASELINE_LINE);
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'the per-panel depth cap drops the oldest states at 500 entries',
    run() {
      const { dom, errors, document } = open(workspaceHtml('undo-cap-g'));
      try {
        noPageErrors(errors);
        editToggle(document).click();
        const panel = panelFor(document, 'resume');
        for (let index = 1; index <= 600; index += 1) mutateText(dom, panel, `Line ${index}`);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 500, future: 0 });
        let undos = 0;
        while (history(dom).undo('resume')) undos += 1;
        assert.equal(undos, 499, 'a 500-entry stack offers 499 undo steps');
        assert.equal(lineOf(panel), 'Line 101', 'the oldest state kept is the first one after the dropped baseline');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 1, future: 499 });
      } finally { dom.window.close(); }
    },
  },
  {
    name: 'undo rewrites the autosave slot after the debounce without recording a new entry',
    run: async () => {
      const docId = 'undo-autosave-h';
      const { dom, errors, document } = open(workspaceHtml(docId));
      try {
        noPageErrors(errors);
        const storageKey = `ic-edit:${docId}`;
        editToggle(document).click();
        const panel = panelFor(document, 'resume');
        assert.equal(dom.window.localStorage.getItem(storageKey), null);
        mutateText(dom, panel, 'Autosaved edit');
        await new Promise(resolve => dom.window.setTimeout(resolve, 650));
        const saved = dom.window.localStorage.getItem(storageKey);
        assert.ok(saved && saved.includes('Autosaved edit'), 'the edit autosaves after the debounce');
        assert.deepEqual(depthOf(dom, 'resume'), { past: 2, future: 0 });
        assert.equal(history(dom).undo('resume'), true);
        assert.equal(lineOf(panel), BASELINE_LINE);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 1, future: 1 }, 'applying a state records no new entry');
        await new Promise(resolve => dom.window.setTimeout(resolve, 650));
        const afterUndo = dom.window.localStorage.getItem(storageKey);
        assert.notEqual(afterUndo, saved, 'undo rewrites the autosave slot');
        assert.ok(afterUndo && afterUndo.includes(BASELINE_LINE), 'the slot now holds the undone markup');
        assert.equal(afterUndo.includes('Autosaved edit'), false);
        assert.deepEqual(depthOf(dom, 'resume'), { past: 1, future: 1 }, 'the autosave side effect records nothing');
      } finally { dom.window.close(); }
    },
  },
];
