/**
 * Opens the person's own Chrome on a new claude.ai chat with the practice
 * starter already in the composer. Nothing is sent: the person picks the
 * model, presses Enter and switches to voice mode themselves. The tab is
 * brought to the front, unlike the background ChatGPT worker tabs.
 *
 * Same transport as the ChatGPT launcher: JXA against the person's Chrome by
 * process id (View → Developer → Allow JavaScript from Apple Events must be
 * on). The starter is inserted through execCommand, never put in a URL.
 */
import { isAppleEventsJsDisabledError, runUserChromeScript } from './browser/appleEvents.js';

export const CLAUDE_NEW_CHAT_URL = 'https://claude.ai/new';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const OPEN = `function run(argv) {
  const chrome = Application(Number(argv[0]));
  const targetUrl = argv[1];
  let w = null;
  for (const candidate of chrome.windows()) {
    if (candidate.mode() === 'normal') { w = candidate; break; }
  }
  let t = null;
  if (w) {
    w.tabs.push(chrome.Tab({ url: targetUrl }));
    t = w.tabs[w.tabs.length - 1];
    w.activeTabIndex = w.tabs.length;
  } else {
    w = chrome.Window().make();
    t = w.activeTab;
    t.url = targetUrl;
  }
  w.minimized = false;
  w.index = 1;
  chrome.activate();
  return String(w.id()) + ':' + String(t.id());
}`;
const EXEC = `function run(argv) {
  const chrome = Application(Number(argv[0]));
  const tab = chrome.windows.byId(Number(argv[1])).tabs.byId(Number(argv[2]));
  const value = tab.execute({ javascript: argv[3] });
  return value === undefined || value === null ? '' : String(value);
}`;
const FOCUS = `function run(argv) {
  const chrome = Application(Number(argv[0]));
  const w = chrome.windows.byId(Number(argv[1]));
  const target = String(argv[2]);
  const index = w.tabs().findIndex(tab => String(tab.id()) === target);
  if (index < 0) return 'missing';
  w.minimized = false;
  w.activeTabIndex = index + 1;
  w.index = 1;
  chrome.activate();
  return 'focused';
}`;

// Only bounded state comes back from the page; the starter text never does.
const EDITOR_SELECTOR = '[data-testid="chat-input"][contenteditable="true"], [contenteditable="true"][role="textbox"]';
const CLAUDE_ORIGIN = 'https://claude.ai';
const EDITOR = `(() => { const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
  return JSON.stringify({ ready: !!editor, path: location.pathname, origin: location.origin }); })()`;
const INSERT = starter => `(() => {
  if (location.origin !== ${JSON.stringify(CLAUDE_ORIGIN)}) return 'wrong_origin';
  const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
  if (!editor) return 'missing';
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, ${JSON.stringify(starter)});
  const text = [...editor.children].map(paragraph => paragraph.textContent).join('\\n');
  // 'mismatch:' alone means the editor is still empty (not attached yet).
  return text === ${JSON.stringify(starter)} ? 'match' : text.trim() === '' ? 'mismatch:' : 'mismatch';
})()`;

export function createPracticeChatLauncher({ run = runUserChromeScript, delay = sleep, now = Date.now, editorTimeoutMs = 25_000 } = {}) {
  const safeRun = async (script, args) => {
    try { return await run(script, args); } catch (error) {
      if (isAppleEventsJsDisabledError(error?.stderr || error?.message)) throw Object.assign(new Error('apple_events_js_off'), { code: 'apple_events_js_off' });
      throw error;
    }
  };
  const js = (tab, code) => safeRun(EXEC, [tab.windowId, tab.tabId, code]);
  const poll = async (read, accept, timeout) => {
    const until = now() + timeout;
    do { const value = await read(); if (accept(value)) return value; await delay(300); } while (now() < until);
    return null;
  };

  /** Opens claude.ai/new in front and leaves the starter in the composer. */
  async function launch({ prompt }) {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, reason: 'empty_prompt' };
    let tab;
    try {
      const ids = await safeRun(OPEN, [CLAUDE_NEW_CHAT_URL]);
      const [windowId, tabId] = String(ids).split(':');
      if (!/^\d+$/u.test(windowId || '') || !/^\d+$/u.test(tabId || '')) return { ok: false, reason: 'chrome_unavailable' };
      tab = { windowId, tabId };
    } catch (error) { return { ok: false, reason: error?.code === 'apple_events_js_off' ? 'apple_events_js_off' : 'chrome_unavailable' }; }
    const started = now();
    let state = null;
    try {
      state = await poll(async () => { try { return JSON.parse(await js(tab, EDITOR)); } catch { return null; } }, value => value?.origin === CLAUDE_ORIGIN && (value.ready === true || /\/login/u.test(value.path || '')), editorTimeoutMs);
    } catch (error) { return { ok: false, reason: error?.code === 'apple_events_js_off' ? 'apple_events_js_off' : 'chrome_unavailable', tab }; }
    if (!state) return { ok: false, reason: 'editor_timeout', tab };
    if (!state.ready) return { ok: false, reason: 'login_required', tab };
    // The composer element appears before its editor is attached; an insert
    // in that window is dropped and the composer stays empty. Retry while it
    // does, and treat any other outcome as final.
    let inserted = 'mismatch:';
    for (let attempt = 0; attempt < 6 && inserted.startsWith('mismatch:'); attempt += 1) {
      if (attempt) await delay(500);
      try { inserted = await js(tab, INSERT(prompt)); } catch { return { ok: false, reason: 'insert_failed', tab }; }
      if (inserted === 'mismatch:' && now() - started > editorTimeoutMs) break;
    }
    if (inserted !== 'match') return { ok: false, reason: inserted === 'missing' ? 'editor_missing' : inserted === 'wrong_origin' ? 'wrong_origin' : 'insert_mismatch', tab };
    try { await safeRun(FOCUS, [tab.windowId, tab.tabId]); } catch { /* the starter is in place; focus is best effort */ }
    return { ok: true, tab };
  }

  return Object.freeze({ launch });
}

export const PRACTICE_LAUNCH_NOTES = Object.freeze({
  apple_events_js_off: 'Chrome refuses scripting. Turn on View → Developer → Allow JavaScript from Apple Events in Chrome, then start practice again.',
  chrome_unavailable: 'Google Chrome could not be opened or scripted.',
  editor_timeout: 'claude.ai did not show its composer in time. Check the Chrome tab, then start practice again.',
  wrong_origin: 'The Chrome tab left claude.ai before the starter could be placed. Start practice again.',
  login_required: 'claude.ai asks you to sign in. Sign in in that Chrome tab, then start practice again.',
  editor_missing: 'The claude.ai composer disappeared before the starter could be placed.',
  insert_mismatch: 'The starter did not land in the claude.ai composer as expected. Clear the composer and start practice again.',
  insert_failed: 'The starter could not be placed in the claude.ai composer.',
  empty_prompt: 'There is nothing to practice yet.',
});
