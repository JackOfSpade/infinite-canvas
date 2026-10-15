import { isAppleEventsJsDisabledError, runChromeAppleScript } from '../browser/appleEvents.js';
import crypto from 'node:crypto';

const CHAT_URL = 'https://chatgpt.com/';
const CHAT_ID = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9-]{8,})\/?(?:[?#].*)?$/;
const HANDOFF_CODE = /^HANDOFF-[2-9A-HJ-NP-Z]{6}$/i;
const UPLOAD_CHUNK_BYTES = 48 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const OPEN = `on run argv
  set previousApp to path to frontmost application
  try
  tell application "Google Chrome"
    set wid to item 1 of argv
    set targetUrl to item 2 of argv
    set previousWindowId to 0
    if (count of windows) > 0 then set previousWindowId to id of front window
    if wid is "0" then
      set w to make new window
      set t to active tab of w
      set URL of t to targetUrl
    else
      try
        set w to first window whose id is (wid as integer)
        set t to make new tab at end of tabs of w with properties {URL:targetUrl}
      on error
        set w to make new window
        set t to active tab of w
        set URL of t to targetUrl
      end try
    end if
    set resultIds to (id of w as string) & ":" & (id of t as string)
    if previousWindowId is not 0 and previousWindowId is not (id of w) then set index of (first window whose id is previousWindowId) to 1
  end tell
  on error errText number errNumber
    tell application (previousApp as text) to activate
    error errText number errNumber
  end try
  tell application (previousApp as text) to activate
  return resultIds
end run`;
const EXEC = `on run argv
  tell application "Google Chrome"
    set w to first window whose id is (item 1 of argv as integer)
    set t to first tab of w whose id is (item 2 of argv as integer)
    return execute t javascript (item 3 of argv)
  end tell
end run`;
const URL = `on run argv
  tell application "Google Chrome"
    set w to first window whose id is (item 1 of argv as integer)
    set t to first tab of w whose id is (item 2 of argv as integer)
    return URL of t
  end tell
end run`;
const CLOSE = `on run argv
  tell application "Google Chrome"
    set w to first window whose id is (item 1 of argv as integer)
    close (first tab of w whose id is (item 2 of argv as integer))
  end tell
end run`;

// The in-page code returns only bounded state. Starter text is never returned,
// logged, put in a URL, or sent to a renderer.
const EDITOR = `(() => { const editor = document.querySelector('form [contenteditable="true"][role="textbox"]');
  return JSON.stringify({ready: !!editor, empty: (editor?.innerText || '').trim() === '', url: location.href,
    attachments: document.querySelectorAll('form button[aria-label^="Remove "]').length}); })()`;
const INIT_UPLOAD = id => `(() => { window.__icBridgeUploads ||= Object.create(null);
  window.__icBridgeUploads[${JSON.stringify(id)}] = []; return 'ready'; })()`;
const APPEND_UPLOAD = (id, chunk) => `(() => { const b = window.__icBridgeUploads?.[${JSON.stringify(id)}];
  if (!Array.isArray(b)) return 'missing'; b.push(${JSON.stringify(chunk)}); return 'appended'; })()`;
const ABORT_UPLOAD = id => `(() => { if (window.__icBridgeUploads) delete window.__icBridgeUploads[${JSON.stringify(id)}]; return 'cleared'; })()`;
const COMMIT_UPLOAD = (id, name, mime) => `(() => {
  const b = window.__icBridgeUploads?.[${JSON.stringify(id)}];
  const input = [...document.querySelectorAll('form input[type="file"]')]
    .find(e => e.multiple && e.accept === '');
  if (!Array.isArray(b) || !input) return 'missing';
  try {
    const raw = atob(b.join(''));
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], ${JSON.stringify(name)}, {type:${JSON.stringify(mime)}}));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
    return 'attached';
  } catch { return 'failed'; }
  finally { delete window.__icBridgeUploads[${JSON.stringify(id)}]; }
})()`;
const UPLOAD_STATE = names => `(() => {
  const expected = ${JSON.stringify(names)};
  const actual = [...document.querySelectorAll('form button[aria-label^="Remove "]')]
    .map(e => e.getAttribute('aria-label').slice(7));
  const progress = document.querySelectorAll('form [role="progressbar"]').length;
  const unmatched = actual.slice();
  const named = expected.every(name => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const index = unmatched.findIndex(display => display === name
      || (display.startsWith(stem + '(') && display.endsWith(')' + ext)
        && /^[1-9][0-9]*$/.test(display.slice(stem.length + 1, display.length - ext.length - 1))));
    if (index < 0) return false;
    unmatched.splice(index, 1);
    return true;
  });
  return JSON.stringify({complete: actual.length === expected.length
    && named && progress === 0, progress});
})()`;
const INSERT = starter => `(() => {
  const editor = document.querySelector('form [contenteditable="true"][role="textbox"]');
  if (!editor) return 'missing';
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, ${JSON.stringify(starter)});
  const text = [...editor.children].map(paragraph => paragraph.textContent).join('\\n');
  return text === ${JSON.stringify(starter)} ? 'match' : 'mismatch';
})()`;
const OPEN_MODEL = `(() => {
  const b = document.querySelector('form button[aria-label="Select ChatGPT model"]');
  if (!b) return 'missing';
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true}));
  return 'opened';
})()`;
const MENU_OPEN = `(() => !!document.querySelector('[role="menu"]'))()`;
const READ_MODEL = `(() => {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) return JSON.stringify({error:'menu_missing'});
  const models = [...menu.querySelectorAll('[role="menuitemradio"]')];
  const enabled = models.filter(e => e.getAttribute('aria-disabled') !== 'true' && !e.hasAttribute('disabled'));
  const checked = models.filter(e => e.getAttribute('aria-checked') === 'true');
  const name = item => (item?.innerText || '').split('\\n')[0].trim();
  const slider = menu.querySelector('[data-model-picker-power-slider] [role="slider"]');
  const sliderRoot = slider?.closest('[aria-disabled]');
  const ticks = [...menu.querySelectorAll('[data-model-picker-power-slider] [data-selected]')];
  const selectedTick = ticks.at(Number(slider?.getAttribute('aria-valuenow')));
  const label = (menu.querySelector('[data-model-picker-view-toggle]')?.innerText || '').trim();
  return JSON.stringify({model: checked.length === 1 ? name(checked[0]) : null,
    topModel: enabled.length ? name(enabled[0]) : null,
    topSelected: enabled.length > 0 && checked.length === 1 && enabled[0] === checked[0],
    min: Number(slider?.getAttribute('aria-valuemin')), max: Number(slider?.getAttribute('aria-valuemax')),
    now: Number(slider?.getAttribute('aria-valuenow')), label,
    sliderReady: !!slider && !!menu.querySelector('[data-model-picker-power-slider]'),
    locked: sliderRoot?.getAttribute('aria-disabled') === 'true'
      || selectedTick?.getAttribute('aria-disabled') === 'true'
      || selectedTick?.getAttribute('data-locked') === 'true'});
})()`;
const READ_BLOCKER = `(() => {
  const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const alerts = [...document.querySelectorAll('[role="alert"],[role="status"]')]
    .filter(visible).some(e => /limit reached|limit exceeded|you.ve reached.{0,60}limit|(?:usage|daily|weekly|rate|pro)\\s+limit\\s+(?:reached|exceeded|used up)|(?:no|0%)\\s+usage remaining|pro effort unavailable/i.test((e.innerText || '').slice(0,500)));
  return JSON.stringify({blocked: dialogs.length > 0 || alerts});
})()`;
const CLOSE_BLOCKER = `(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  if (dialog) dialog.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}));
  return 'closed';
})()`;
const SELECT_TOP_MODEL = `(() => {
  const menu = document.querySelector('[role="menu"]');
  const item = [...(menu?.querySelectorAll('[role="menuitemradio"]') || [])]
    .find(e => e.getAttribute('aria-disabled') !== 'true' && !e.hasAttribute('disabled'));
  if (!item) return 'missing';
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) item.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true}));
  return 'selected';
})()`;
const MOVE_EFFORT = direction => `(() => {
  const slider = document.querySelector('[role="menu"] [data-model-picker-power-slider]');
  if (!slider) return 'missing';
  const key = ${JSON.stringify(direction === 'right' ? 'ArrowRight' : 'ArrowLeft')};
  slider.dispatchEvent(new KeyboardEvent('keydown', {key, code:key, bubbles:true, cancelable:true}));
  return 'moved';
})()`;
const CLOSE_MENU = `(() => {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) return 'missing';
  menu.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}));
  return 'closed';
})()`;
const MENU_CLOSED = `(() => !document.querySelector('[role="menu"]'))()`;
const OPEN_PROFILE = `(() => {
  const b = document.querySelector('button[aria-label="Open profile menu"]');
  if (!b) return 'missing';
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true}));
  return 'opened';
})()`;
const READ_PROFILE = `(() => {
  const menu = document.querySelector('[role="menu"]');
  if (!menu) return JSON.stringify({error:'profile_missing'});
  const rows = [...menu.querySelectorAll('[role="menuitem"],a,button')].map(e => (e.innerText||'').trim()).filter(Boolean);
  const signedIn = rows.some(s => /^(log out|sign out)$/i.test(s));
  if (!signedIn) return JSON.stringify({error:'profile_unverified'});
  const displayName = (menu.querySelector('span.truncate')?.innerText || '').trim().slice(0,80);
  menu.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}));
  return JSON.stringify({signedIn, displayName});
})()`;
const SEND = `(() => {
  const editor = document.querySelector('form [contenteditable="true"][role="textbox"]');
  const button = document.querySelector('form button[aria-label="Send"]');
  if (!editor || !button || button.disabled) return 'unavailable';
  button.click(); return 'clicked';
})()`;
const EMPTY = `(() => JSON.stringify({empty: (document.querySelector('form [contenteditable="true"][role="textbox"]')?.innerText || '').trim() === ''}))()`;
const DIAGNOSE = pluginName => `(() => {
  const agent = [...document.querySelectorAll('[data-chatgpt-agent-turn-start]')].at(-1);
  const content = (agent?.parentElement?.parentElement?.innerText || '').slice(-4000);
  const lower = content.toLowerCase();
  const plugin = ${JSON.stringify(pluginName)}.toLowerCase();
  let reason = 'none';
  // ChatGPT can also hold the message behind a modal "Connect <plugin>" /
  // "Reconnect" consent screen instead of replying, so check visible dialogs.
  const visible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const connectDialog = [...document.querySelectorAll('[role="dialog"]')].filter(visible)
    .some(e => {
      const text = (e.innerText || '').slice(0, 600).toLowerCase();
      return (text.startsWith('connect ' + plugin) || text.startsWith('reconnect ' + plugin))
        || (text.includes(plugin) && /\\b(?:connect|reconnect)\\b/.test(text) && /connectors? may introduce risk|permissions always respected|connection has expired/.test(text));
    });
  if (connectDialog) reason = 'reconnect_required';
  else if (/reconnect.{0,70}(?:infinite canvas|plugin)|connection has expired/i.test(content)) reason = 'reconnect_required';
  else if (/(?:usage|daily|weekly|rate|pro)\\s+limit|limit reached|you.ve reached.{0,60}limit|try again tomorrow/i.test(content)) reason = 'usage_limit';
  else if ((lower.includes(plugin) || lower.includes('plugin'))
    && /not connected|not available|cannot find|can't find|don.t have access|not installed|unknown tool|don.t have that tool/i.test(content)) reason = 'plugin_missing';
  else if (/can.t help with this request|violates (?:our )?usage policies|blocked for safety/i.test(content)) reason = 'safety_block';
  return JSON.stringify({reason, assistantPresent: !!agent});
})()`;

export function createChatLauncher({ run = runChromeAppleScript, delay = sleep, onState = () => {}, now = Date.now } = {}) {
  let windowId = null;
  let sequence = Promise.resolve();
  let lastStart = -Infinity;
  const tabs = new Map();
  const chatIds = new Map();
  const usedIds = new Set();
  let proUnavailableDay = null;
  const localDay = () => new Date(now()).toDateString();
  const state = (owner, stage, reason = null) => { try { onState(owner, stage, reason); } catch { /* status is optional */ } };
  const safeRun = async (script, args) => {
    try { return await run(script, args); }
    catch (error) {
      if (isAppleEventsJsDisabledError(error?.stderr || error?.message)) throw Object.assign(new Error('apple_events_js_off'), { code: 'apple_events_js_off' });
      throw Object.assign(new Error('chrome_unavailable'), { code: 'chrome_unavailable' });
    }
  };
  const js = (tab, code) => safeRun(EXEC, [tab.windowId, tab.tabId, code]);
  const upload = async (tab, attachments) => {
    const names = [];
    for (const attachment of attachments) {
      const name = attachment?.name;
      const bytes = attachment?.bytes;
      const mime = typeof attachment?.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mime)
        ? attachment.mime : 'application/octet-stream';
      if (typeof name !== 'string' || !name || name.length > 180
        || [...name].some(char => char === '/' || char === '\\' || char.charCodeAt(0) < 32)
        || names.includes(name) || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES) {
        return { ok: false, reason: 'attachment_invalid' };
      }
      names.push(name);
      const id = crypto.randomUUID();
      if (await js(tab, INIT_UPLOAD(id)) !== 'ready') return { ok: false, reason: 'attachment_upload_failed' };
      let committed = false;
      try {
        for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
          const chunk = Buffer.from(bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES)).toString('base64');
          if (await js(tab, APPEND_UPLOAD(id, chunk)) !== 'appended') {
            return { ok: false, reason: 'attachment_upload_failed' };
          }
        }
        if (await js(tab, COMMIT_UPLOAD(id, name, mime)) !== 'attached') {
          return { ok: false, reason: 'attachment_upload_failed' };
        }
        committed = true;
      } finally {
        if (!committed) try { await js(tab, ABORT_UPLOAD(id)); } catch { /* tab failure */ }
      }
    }
    const settled = await poll(async () => {
      try { return JSON.parse(await js(tab, UPLOAD_STATE(names))).complete === true; } catch { return false; }
    }, Boolean, 60_000);
    return settled ? { ok: true } : { ok: false, reason: 'attachment_upload_timeout' };
  };
  const poll = async (read, accept, timeout) => {
    const until = now() + timeout;
    do { const value = await read(); if (accept(value)) return value; await delay(250); } while (now() < until);
    return null;
  };
  const readMenu = async tab => {
    const raw = await poll(() => js(tab, READ_MODEL), value => value.includes('"topModel"'), 10_000);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const configureModelAndEffort = async (tab, application) => {
    const opened = await poll(() => js(tab, OPEN_MODEL), value => value === 'opened', 10_000);
    if (!opened) return { ok: false, reason: 'model_menu_missing' };
    let menu = await readMenu(tab);
    if (!menu?.topModel || !menu.sliderReady) {
      // ChatGPT can replace the picker while the editor settles after a long
      // insertion. Reopen once after the first bounded read has failed.
      if (await js(tab, MENU_OPEN) !== 'true') await js(tab, OPEN_MODEL);
      menu = await readMenu(tab);
    }
    if (!menu?.topModel || !menu.sliderReady || !Number.isInteger(menu.min)
      || !Number.isInteger(menu.max) || menu.max <= menu.min || !Number.isInteger(menu.now)) {
      return { ok: false, reason: 'model_menu_missing' };
    }
    if (!menu.topSelected) {
      if (await js(tab, SELECT_TOP_MODEL) !== 'selected') return { ok: false, reason: 'model_selection_failed' };
      await delay(250);
      if (await js(tab, MENU_OPEN) !== 'true' && await js(tab, OPEN_MODEL) !== 'opened') return { ok: false, reason: 'model_selection_failed' };
      menu = await readMenu(tab);
      if (!menu?.topSelected) return { ok: false, reason: 'model_selection_failed' };
    }
    // The observed five-position control reserves its rightmost position for
    // Pro effort. A shorter control has no separate Pro position to skip.
    let target = application && proUnavailableDay === localDay() ? menu.max - 1
      : application || menu.max - menu.min + 1 < 5 ? menu.max : menu.max - 1;
    if (target < menu.min) return { ok: false, reason: 'effort_unavailable' };
    let fallback = application && target < menu.max;
    for (let step = 0; step < 8 && menu.now !== target; step += 1) {
      const before = menu.now;
      if (await js(tab, MOVE_EFFORT(target > before ? 'right' : 'left')) !== 'moved') return { ok: false, reason: 'effort_unavailable' };
      const next = await poll(() => readMenu(tab), value => value?.now !== before, 1500);
      if (!next) {
        if (application && target === menu.max) { target = menu.max - 1; fallback = true; proUnavailableDay = localDay(); continue; }
        return { ok: false, reason: 'effort_unavailable' };
      }
      menu = next;
    }
    await delay(150);
    menu = await readMenu(tab);
    if (application && target === menu?.max) {
      let blocked = menu.locked === true;
      try { blocked ||= JSON.parse(await js(tab, READ_BLOCKER)).blocked === true; } catch { blocked = true; }
      if (blocked) {
        await js(tab, CLOSE_BLOCKER);
        const dismissed = await poll(async () => {
          try { return JSON.parse(await js(tab, READ_BLOCKER)).blocked !== true; } catch { return false; }
        }, Boolean, 3000);
        if (!dismissed) return { ok: false, reason: 'effort_unavailable' };
        proUnavailableDay = localDay();
        fallback = true;
        target = menu.max - 1;
        if (await js(tab, MENU_OPEN) !== 'true') await js(tab, OPEN_MODEL);
        menu = await readMenu(tab);
        if (!menu?.sliderReady || target < menu.min) return { ok: false, reason: 'effort_unavailable' };
        for (let step = 0; step < 8 && menu.now !== target; step += 1) {
          const before = menu.now;
          if (await js(tab, MOVE_EFFORT('left')) !== 'moved') return { ok: false, reason: 'effort_unavailable' };
          menu = await poll(() => readMenu(tab), value => value?.now !== before, 1500);
          if (!menu) return { ok: false, reason: 'effort_unavailable' };
        }
      }
    }
    if (!menu || menu.now !== target || !menu.topSelected || !menu.label) return { ok: false, reason: 'effort_unavailable' };
    try { if (JSON.parse(await js(tab, READ_BLOCKER)).blocked) return { ok: false, reason: 'effort_unavailable' }; }
    catch { return { ok: false, reason: 'effort_unavailable' }; }
    if (await js(tab, CLOSE_MENU) !== 'closed') return { ok: false, reason: 'model_menu_missing' };
    if (!await poll(() => js(tab, MENU_CLOSED), value => value === 'true', 3000)) return { ok: false, reason: 'model_menu_missing' };
    return { ok: true, observed: { model: menu.model, effort: menu.label, effortPosition: menu.now, effortMax: menu.max, fallback } };
  };
  const launch = async ({ owner, starter, continueChat = false, application = false, attachments = [], attachmentHandoffCode = null } = {}) => {
    if (!owner || typeof starter !== 'string' || !starter) return { ok: false, reason: 'invalid_launch' };
    if (!Array.isArray(attachments) || (attachments.length > 0 && !HANDOFF_CODE.test(attachmentHandoffCode || ''))
      || (attachments.length === 0 && attachmentHandoffCode != null)) return { ok: false, reason: 'attachment_invalid' };
    const message = attachments.length > 0
      ? `${starter} The files attached to this chat belong only to handoff ${attachmentHandoffCode.toUpperCase()}. Use them for that handoff, never another handoff.`
      : starter;
    const task = async () => {
      const remaining = 2500 - (now() - lastStart);
      if (remaining > 0) await delay(remaining);
      lastStart = now();
      state(owner, 'opening');
      let tab = continueChat ? tabs.get(owner) : null;
      let sendAttempted = false;
      const recordedId = continueChat ? chatIds.get(owner) : null;
      if (continueChat && !recordedId) return { ok: false, reason: 'tab_not_owned' };
      try {
        if (continueChat && tab) {
          try {
            const currentUrl = await safeRun(URL, [tab.windowId, tab.tabId]);
            if (currentUrl.match(CHAT_ID)?.[1] !== recordedId) return { ok: false, reason: 'chat_changed' };
          } catch { tabs.delete(owner); tab = null; }
        }
        if (!tab) {
          const targetUrl = continueChat ? `${CHAT_URL}c/${recordedId}` : CHAT_URL;
          const ids = (await safeRun(OPEN, [windowId || '0', targetUrl])).split(':');
          if (ids.length !== 2 || !ids.every(id => /^\d+$/.test(id))) return { ok: false, reason: 'tab_open_failed' };
          tab = { windowId: ids[0], tabId: ids[1], chatId: recordedId };
          windowId = ids[0];
          tabs.set(owner, tab);
        }
        const ready = await poll(() => js(tab, EDITOR).then(value => { try { return JSON.parse(value); } catch { return null; } }), value => value?.ready && (continueChat ? CHAT_ID.test(value.url) : value.url === CHAT_URL), 30_000);
        if (!ready) return { ok: false, reason: 'editor_timeout' };
        if (ready.attachments !== 0) return { ok: false, reason: 'attachment_draft_present' };
        if (continueChat && ready.url.match(CHAT_ID)?.[1] !== tab.chatId) return { ok: false, reason: 'chat_changed' };
        if (continueChat && ready.empty !== true) return { ok: false, reason: 'editor_not_empty' };
        state(owner, 'checking');
        if (await js(tab, INSERT(message)) !== 'match') return { ok: false, reason: 'insert_mismatch' };
        const configured = await configureModelAndEffort(tab, application);
        if (!configured.ok) return configured;
        const observed = configured.observed;
        if (await js(tab, OPEN_PROFILE) !== 'opened') return { ok: false, reason: 'account_unknown' };
        const profileRead = await poll(() => js(tab, READ_PROFILE), value => value.includes('"signedIn":true'), 3000);
        if (!profileRead) return { ok: false, reason: 'account_unknown' };
        const account = JSON.parse(profileRead);
        if (account.signedIn !== true) return { ok: false, reason: 'account_unknown' };
        tab.accountName = typeof account.displayName === 'string' && account.displayName.length <= 80 ? account.displayName : '';
        if (attachments.length > 0) {
          const uploaded = await upload(tab, attachments);
          if (!uploaded.ok) return uploaded;
          tab.attachmentHandoffCode = attachmentHandoffCode.toUpperCase();
        }
        // Settings were selected and read back before the click.
        if (await js(tab, SEND) !== 'clicked') return { ok: false, reason: 'send_unavailable' };
        sendAttempted = true;
        const landed = await poll(async () => {
          const url = await safeRun(URL, [tab.windowId, tab.tabId]);
          const id = url.match(CHAT_ID)?.[1];
          return id && (continueChat ? id === tab.chatId : !usedIds.has(id)) && JSON.parse(await js(tab, EMPTY)).empty ? id : null;
        }, Boolean, 30_000);
        if (!landed) return { ok: false, reason: 'send_not_confirmed', sendAttempted };
        tab.chatId = landed;
        chatIds.set(owner, landed);
        tab.observed = observed;
        usedIds.add(landed);
        state(owner, 'sent');
        return { ok: true, chatId: landed, observed };
      } catch (error) {
        return { ok: false, reason: error?.code || 'chrome_unavailable', sendAttempted };
      }
    };
    const result = sequence.then(task, task);
    sequence = result.then(() => undefined, () => undefined);
    const outcome = await result;
    if (!outcome.ok) state(owner, 'failed', outcome.reason);
    return outcome;
  };
  const close = async owner => {
    chatIds.delete(owner);
    const tab = tabs.get(owner);
    if (!tab) return false;
    tabs.delete(owner);
    if (![...tabs.values()].some(item => item.windowId === tab.windowId)) windowId = null;
    try { await safeRun(CLOSE, [tab.windowId, tab.tabId]); return true; } catch { return false; }
  };
  const rekey = (before, after) => {
    if ((!tabs.has(before) && !chatIds.has(before)) || tabs.has(after) || chatIds.has(after)) return false;
    if (tabs.has(before)) { tabs.set(after, tabs.get(before)); tabs.delete(before); }
    if (chatIds.has(before)) { chatIds.set(after, chatIds.get(before)); chatIds.delete(before); }
    return true;
  };
  const closeAll = async () => {
    await sequence;
    return Promise.all([...new Set([...tabs.keys(), ...chatIds.keys()])].map(close));
  };
  const diagnose = async (owner, pluginName = 'Infinite Canvas') => {
    const tab = tabs.get(owner);
    if (!tab) return { reason: 'tab_not_owned', assistantPresent: false };
    try {
      const value = JSON.parse(await js(tab, DIAGNOSE(pluginName)));
      return { reason: ['none', 'reconnect_required', 'usage_limit', 'plugin_missing', 'safety_block'].includes(value?.reason)
        ? value.reason : 'none', assistantPresent: value?.assistantPresent === true };
    } catch { return { reason: 'chrome_unavailable', assistantPresent: false }; }
  };
  const javascriptReady = async owner => {
    const tab = tabs.get(owner);
    if (!tab) return false;
    try { return await js(tab, "'ready'") === 'ready'; } catch { return false; }
  };
  return Object.freeze({ launch, close, closeAll, rekey, owns: owner => tabs.has(owner) || chatIds.has(owner),
    markProUnavailable: () => { proUnavailableDay = localDay(); },
    diagnose, javascriptReady, accountName: owner => tabs.get(owner)?.accountName || '',
    observation: owner => tabs.get(owner)?.observed || null,
    scripts: Object.freeze({ OPEN, EXEC, URL, CLOSE }) });
}
