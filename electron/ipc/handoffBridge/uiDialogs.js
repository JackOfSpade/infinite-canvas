import electronPkg from 'electron';

const MAX_CONFIRM_TEXT = 60;
const MAX_NOTICE_QUEUE = 8;
const fallbackHostname = value => typeof value === 'string'
  && value.length <= 253 && value === value.toLowerCase() && !value.endsWith('.')
  && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$/.test(value);
const UNSAFE_TEXT = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]`, 'g');
const UNSAFE_TEXT_TEST = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]`);
const cleanText = value => String(value ?? '')
  .replace(UNSAFE_TEXT, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_CONFIRM_TEXT);
const canvasName = value => cleanText(String(value || '').split('/').filter(Boolean).pop() || 'this canvas');
const safeCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 50 ? value : 0;
const safeMinutes = value => Number.isFinite(value) && value >= 0 ? Math.min(24 * 60, Math.floor(value)) : 0;
const formatPairingCode = value => `${value.slice(0, 5)}-${value.slice(5)}`;
const safePath = value => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && /^[\x20-\x7e]+$/.test(value) && !UNSAFE_TEXT_TEST.test(value) ? value : null;
const safeSignature = value => ['ad-hoc signed', 'Developer ID signed', 'other signed', 'unsigned'].includes(value) ? value : 'unavailable';
const expiryClock = value => {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon';
};

function accepted(answer) { return answer === true || answer?.response === 1 || answer?.accepted === true || answer?.ok === true; }

/**
 * Native sheets are deliberately a tiny port.  Renderer values never become
 * sheet text; callers supply only disk-derived descriptions or fixed kinds.
 */
export function createHandoffBridgeDialogs({
  dialog = electronPkg.dialog,
  getCanvasWindows = () => [],
  describeForConfirm = async () => ({ ok: false, items: [] }),
  validateHostname = fallbackHostname,
} = {}) {
  let busy = false;
  let drainingNotices = false;
  let activeNoticeKind = null;
  const notices = [];
  const windows = () => {
    try { return (getCanvasWindows() || []).filter(window => !window?.isDestroyed?.()); } catch { return []; }
  };
  const parentFor = sender => windows().find(window => window?.webContents?.id === sender?.id) || null;
  const isValidHostname = value => {
    try { return validateHostname(value) === true; } catch { return false; }
  };
  async function drainNotices() {
    if (drainingNotices || busy) return;
    drainingNotices = true;
    try {
      while (!busy && notices.length) {
        const next = notices.shift();
        if (!next?.parentWindow || next.parentWindow.isDestroyed?.()) continue;
        busy = true;
        activeNoticeKind = next.kind;
        try {
          await dialog?.showMessageBox?.(next.parentWindow, {
            type: 'info', buttons: ['Close'], defaultId: 0, cancelId: 0,
            title: 'Handoff bridge', message: next.message,
          });
        } catch { /* a notice is informational and cannot change bridge state */ }
        finally { activeNoticeKind = null; busy = false; }
      }
    } finally {
      drainingNotices = false;
      if (!busy && notices.length) void drainNotices();
    }
  }
  async function ask(sender, kind, details = {}) {
    const parentWindow = parentFor(sender);
    if (!parentWindow) return { ok: false, code: 'NO_WINDOW' };
    if (busy) return { ok: false, code: 'BUSY' };
    const templates = {
      enable: { title: 'Let ChatGPT fetch your AI handoffs while this app is open?', message: 'Let ChatGPT fetch your AI handoffs while this app is open?', detail: '' },
      hostname: { title: 'Change bridge address?', message: 'Change the bridge address?', detail: '' },
      linkBreak: { title: 'Change bridge address?', message: 'Change the bridge address?', detail: '' },
      restart: { title: 'Serve these released jobs to ChatGPT again?', message: 'Serve these released jobs to ChatGPT again?', detail: '' },
      resume: { title: 'Resume Handoff bridge?', message: 'Resume Handoff bridge?', detail: 'ChatGPT can receive released work again.' },
      release: { title: 'Release work to ChatGPT?', message: 'Release selected work to ChatGPT?', detail: '' },
      releasePush: { title: 'Release scoring work to ChatGPT?', message: 'Release scoring work to ChatGPT?', detail: 'ChatGPT can receive the selected scoring work.' },
      revoke: { title: 'Revoke ChatGPT access?', message: 'Revoke ChatGPT access?', detail: 'ChatGPT will need to be linked again.' },
      forget: { title: 'Forget Handoff bridge setup?', message: 'Forget Handoff bridge setup?', detail: 'This turns off the bridge and removes its setup.' },
      pairing: { title: 'Open pairing?', message: 'Open ChatGPT pairing?', detail: 'A code will be shown in a native window. Do not share your screen while it is open.' },
      scoring: { title: 'Let ChatGPT handle job-scoring handoffs too?', message: 'Let ChatGPT handle job-scoring handoffs too?', detail: 'These can be dozens or hundreds of prompts in one run. Each contains job listings and the information used to rate them.' },
      autoStart: { title: 'Turn on the bridge when the app starts?', message: 'Turn on the bridge when the app starts?', detail: 'The tunnel and ChatGPT link can start when this app opens. Nothing is served until you confirm the released jobs.' },
      autoRelease: { title: 'Release new application handoffs automatically?', message: 'Release new application handoffs automatically?', detail: 'Only a job created by this app after this launch is released automatically.' },
      sourcePolicy: { title: 'Reduce source checks?', message: 'Reduce source-network checks?', detail: 'This weakens a protection against use from another network.' },
      limits: { title: 'Increase bridge limits?', message: 'Increase or turn off a bridge limit?', detail: 'This can keep work available to ChatGPT for longer.' },
      binaryApproval: { title: 'Approve cloudflared copy?', message: 'Approve this cloudflared copy?', detail: '' },
      networkCheck: { title: 'Turn off pairing network check?', message: 'Turn off the pairing network check?', detail: 'The pairing code remains required, but this removes an extra local-network check.' },
    };
    const base = templates[kind];
    if (!base) return { ok: false, code: 'INVALID' };
    let title = base.title;
    let message = base.message;
    let detail = base.detail;
    if (kind === 'enable') {
      const hostname = isValidHostname(details.hostname) ? details.hostname : null;
      const idlePauseHours = Math.floor(safeMinutes(details.idlePauseMinutes) / 60);
      const rows = Array.isArray(details.items) ? details.items.slice(0, 10) : [];
      const names = rows.map(item => [cleanText(item?.title), cleanText(item?.company)].filter(Boolean).join(' — ')).filter(Boolean);
      if (details.long === false) {
        title = 'Turn on the ChatGPT bridge?';
        message = 'Turn on the ChatGPT bridge?';
        detail = 'ChatGPT will be able to fetch your released handoffs until you turn it off or quit the app.';
      } else if (!hostname) return { ok: false, code: 'INVALID' };
      else {
        detail = [
          `While the bridge is on, an ordinary ChatGPT chat that you start can ask this app for the prompts of your pending handoffs and send back the answers. It reaches this Mac through your Cloudflare tunnel at ${hostname}. What ChatGPT receives is exactly the text the AI handoff dock would ask you to copy: job listings, your career data and your drafts. That text travels from this Mac through Cloudflare to ChatGPT; Cloudflare can technically read it in transit and ChatGPT keeps the chat in your history (delete it there). What stays in your hands: you start every ChatGPT chat yourself; you can Pause or Revoke at any time; quitting the app turns the bridge off and ends every chat, and after a restart nothing is served until you confirm the released jobs again.${idlePauseHours > 0 ? ` If you take no action here for ${idlePauseHours} hours the bridge pauses serving (the tunnel and the link stay up) until you press Resume.` : ''} The copy/paste dock keeps working the whole time. macOS may ask whether this app can send notifications.`,
          names.length ? `Released jobs (${names.length}):\n${names.join('\n')}` : '',
        ].filter(Boolean).join('\n\n');
      }
    }
    if ((kind === 'hostname' || kind === 'linkBreak')) {
      const hostname = isValidHostname(details.hostname) ? details.hostname : null;
      if (!hostname) return { ok: false, code: 'INVALID' };
      detail = `The tunnel and probes will contact ${hostname}.`;
    }
    if (kind === 'release') {
      const rows = Array.isArray(details.items) ? details.items : [];
      const names = rows.slice(0, 10).map(item => [cleanText(item.title), cleanText(item.company)].filter(Boolean).join(' — ')).filter(Boolean);
      const destination = isValidHostname(details.hostname) ? details.hostname : null;
      detail = [
        `${safeCount(rows.length)} released ${safeCount(rows.length) === 1 ? 'job' : 'jobs'}:`,
        names.join('\n'),
        `Canvas: ${canvasName(details.canvasFilePath)}`,
        destination ? `Destination: ${destination}` : '',
        'Your career file, listing and drafts go to ChatGPT through Cloudflare.',
      ].filter(Boolean).join('\n');
    }
    if (kind === 'restart') {
      const count = safeCount(details.releasedCount || details.items?.length);
      const names = (Array.isArray(details.items) ? details.items : []).slice(0, 10)
        .map(item => [cleanText(item?.title), cleanText(item?.company)].filter(Boolean).join(' — ')).filter(Boolean);
      detail = [
        count ? `${count} released ${count === 1 ? 'job' : 'jobs'} will be available to the new chat.` : '',
        names.join('\n'),
        'Earlier bridge chats cannot continue after a restart.',
      ].filter(Boolean).join('\n');
    }
    if (kind === 'resume' && details.reason === 'anomaly') {
      const count = safeCount(details.count);
      const minutes = safeMinutes(details.minutes);
      const at = Number.isFinite(Number(details.at)) ? new Date(Number(details.at)).toLocaleString() : 'recently';
      detail = `This bridge paused after ${count || 'several'} unexpected ${count === 1 ? 'call' : 'calls'}${minutes ? ` in the last ${minutes} minutes` : ''}, at ${at}. ChatGPT can receive released work again.`;
    }
    if (kind === 'binaryApproval') {
      const version = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.]{1,20})?$/.test(details.version || '') ? details.version : 'unavailable';
      const digest = /^[a-f0-9]{64}$/.test(details.sha256 || '') ? details.sha256 : null;
      const sourcePath = safePath(details.sourcePath || details.path);
      const size = Number.isSafeInteger(details.size) && details.size >= 0 && details.size <= 256 * 1024 * 1024 ? `${details.size} bytes` : 'unavailable';
      detail = [
        `Source: ${sourcePath || 'unavailable'}`,
        `Version: ${version}`,
        `Size: ${size}`,
        `SHA-256: ${digest ? digest.slice(0, 12) : 'unavailable'}`,
        `Signature: ${safeSignature(details.signature)}`,
        'This pin detects that the file changed; it cannot prove the file is genuine cloudflared: the Homebrew build is ad-hoc signed with no Team ID',
      ].join('\n');
    }
    busy = true;
    try {
      const result = await dialog?.showMessageBox?.(parentWindow, {
        type: 'question', buttons: kind === 'binaryApproval' ? ['Cancel', 'Approve'] : kind === 'enable' ? ['Cancel', 'Turn on'] : ['Cancel', 'Continue'], defaultId: 0, cancelId: 0,
        title, message, detail,
      });
      return { ok: accepted(result), code: accepted(result) ? null : 'DECLINED' };
    } catch { return { ok: false, code: 'DECLINED' }; } finally { busy = false; void drainNotices(); }
  }
  async function choose(sender, kind) {
    const parentWindow = parentFor(sender);
    if (!parentWindow) return { ok: false, code: 'NO_WINDOW' };
    if (busy) return { ok: false, code: 'BUSY' };
    busy = true;
    try {
      const result = await dialog?.showOpenDialog?.(parentWindow, { properties: ['openFile'], title: kind === 'credentials' ? 'Choose credentials file' : 'Choose cloudflared' });
      const filePath = result?.canceled ? null : result?.filePaths?.[0];
      return typeof filePath === 'string' ? { ok: true, filePath } : { ok: false, code: 'DECLINED' };
    } catch { return { ok: false, code: 'DECLINED' }; } finally { busy = false; void drainNotices(); }
  }
  async function showCode({ parentWindow, code, expiresAt, signal, onShown } = {}) {
    if (!parentWindow || parentWindow.isDestroyed?.()) return { ok: false, code: 'NO_WINDOW' };
    if (busy) return { ok: false, code: 'BUSY' };
    if (typeof code !== 'string' || !/^[2-9A-HJ-NP-Z]{10}$/i.test(code)) return { ok: false, code: 'INVALID' };
    if (typeof dialog?.showMessageBox !== 'function') return { ok: false, code: 'DECLINED' };
    busy = true;
    try {
      const pending = dialog.showMessageBox(parentWindow, {
        type: 'info', buttons: ['Cancel pairing'], defaultId: 0, cancelId: 0,
        title: 'ChatGPT pairing code', message: `Pairing code: ${formatPairingCode(code)}`, detail: `This pairing window expires at ${expiryClock(expiresAt)}.\nOnly approve if you just started linking from ChatGPT.\nNever share this code.`,
        signal,
      });
      // Electron has accepted the native-sheet request at this point. The
      // callback carries no pairing code and lets pairing.js emit its closed
      // open/close ledger pair only for a sheet that actually became live.
      try { onShown?.(); } catch { /* diagnostics cannot affect the sheet */ }
      const result = await pending;
      return { ok: true, response: result?.response ?? 0 };
    } catch { return { ok: false, code: 'DECLINED' }; } finally { busy = false; void drainNotices(); }
  }
  function showNotice({ parentWindow, kind, clientKind } = {}) {
    if (!parentWindow || parentWindow.isDestroyed?.()) return { ok: false, code: 'NO_WINDOW' };
    const messages = {
      'link-requested': 'ChatGPT is requesting access to the Handoff bridge.',
      linked: 'ChatGPT is linked to the Handoff bridge.',
      'pairing-closed': 'ChatGPT pairing was closed.',
    };
    if (!Object.hasOwn(messages, kind)) return { ok: false, code: 'INVALID' };
    // clientKind is an OAuth enum only; it deliberately never replaces any
    // part of the fixed native message.
    void clientKind;
    // Notices are informational, so queue them behind a pairing code sheet
    // instead of losing the link-requested notice while that sheet is open.
    // A valid authorize flood can produce many identical consent callbacks;
    // never let those callbacks allocate an unbounded main-process queue.
    if (activeNoticeKind === kind || notices.some(entry => entry.kind === kind)) return { ok: true };
    if (notices.length >= MAX_NOTICE_QUEUE) return { ok: true };
    notices.push({ parentWindow, kind, message: messages[kind] });
    void drainNotices();
    return { ok: true };
  }
  return Object.freeze({ ask, choose, showCode, showNotice, parentFor, isBusy: () => busy, describeForConfirm });
}

export default createHandoffBridgeDialogs;
