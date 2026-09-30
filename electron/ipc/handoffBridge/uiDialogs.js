import electronPkg from 'electron';

const MAX_CONFIRM_TEXT = 60;
// The configured ChatGPT plugin name, as the controller passes it from config.
// Same shape rule as isValidPluginName in src/utils/handoffBridgeConfig.js (this
// module may import only siblings and electron), and the same fallback wording
// as bridgePluginRef in the renderer copy.
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const pluginRef = value => (typeof value === 'string' && PLUGIN_NAME_PATTERN.test(value) ? value : 'the Infinite Canvas plugin');
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
const formatDurationMinutes = value => {
  if (!Number.isSafeInteger(value) || value <= 0) return '';
  const days = Math.floor(value / (24 * 60));
  const afterDays = value % (24 * 60);
  const hours = Math.floor(afterDays / 60);
  const minutes = afterDays % 60;
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(' ');
};
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
  const windows = () => {
    try { return (getCanvasWindows() || []).filter(window => !window?.isDestroyed?.()); } catch { return []; }
  };
  const parentFor = sender => windows().find(window => window?.webContents?.id === sender?.id) || null;
  const isValidHostname = value => {
    try { return validateHostname(value) === true; } catch { return false; }
  };
  async function ask(sender, kind, details = {}) {
    const parentWindow = parentFor(sender);
    if (!parentWindow) return { ok: false, code: 'NO_WINDOW' };
    if (busy) return { ok: false, code: 'BUSY' };
    const templates = {
      enable: { title: 'Turn on ChatGPT bridge', message: 'Allow ChatGPT to fetch released handoffs?', detail: '' },
      disable: { title: 'Turn off ChatGPT bridge', message: 'Stop serving released work to ChatGPT?', detail: 'This ends active bridge chats. You can turn the bridge on again later.' },
      linkBreak: { title: 'Change bridge address', message: 'Use this address and reconnect ChatGPT?', detail: '' },
      restart: { title: 'Copy a starter for a new ChatGPT chat', message: 'Make these released jobs available to it?', detail: '' },
      resume: { title: 'Resume bridge serving', message: 'Let ChatGPT receive released work again?', detail: 'Released work can be served again.' },
      release: { title: 'Release work to ChatGPT', message: 'Share the selected jobs with ChatGPT?', detail: '' },
      releasePush: { title: 'Release scoring work', message: 'Let ChatGPT handle selected scoring work?', detail: 'ChatGPT can receive the selected scoring work.' },
      forget: { title: 'Forget bridge setup', message: 'Turn off the bridge and remove its setup?', detail: 'This clears this app’s bridge setup and revokes ChatGPT access. The Cloudflare tunnel, ChatGPT plugin, and existing ChatGPT history are not deleted.' },
      scoring: { title: 'Add job-scoring handoffs', message: 'Let ChatGPT handle job-scoring work too?', detail: 'One run can contain dozens or hundreds of prompts with job listings and the information used to rate them.' },
      marketplace: { title: 'Add marketplace pricing handoffs', message: 'Let ChatGPT handle marketplace pricing work too?', detail: 'This can send listing details and the pricing comparisons used to price them.' },
      autoStart: { title: 'Start bridge with the app', message: 'Turn on the bridge when this app opens?', detail: 'The tunnel and ChatGPT link can start, but nothing is served until you confirm the released jobs.' },
      autoRelease: { title: 'Automatically release new handoffs', message: 'Release new application handoffs automatically?', detail: 'Only jobs created by this app after this launch are released automatically.' },
      sourcePolicy: { title: 'Reduce source checks', message: 'Reduce source-network checks?', detail: 'This weakens protection against use from another network.' },
      limits: { title: 'Increase bridge limits', message: 'Increase or turn off a bridge limit?', detail: 'This can leave work available to ChatGPT longer.' },
      binaryApproval: { title: 'Approve cloudflared copy', message: 'Approve this cloudflared copy?', detail: '' },
      networkCheck: { title: 'Turn off pairing network check', message: 'Allow pairing without the local-network check?', detail: 'The pairing code is still required, but this removes protection against pairing from another network.' },
    };
    const base = templates[kind];
    if (!base) return { ok: false, code: 'INVALID' };
    let title = base.title;
    let message = base.message;
    let detail = base.detail;
    if (kind === 'enable') {
      // Repeat enables never open a native sheet. Reject the obsolete short
      // form so no caller can accidentally restore that routine popup.
      if (details.long === false) return { ok: false, code: 'INVALID' };
      const hostname = isValidHostname(details.hostname) ? details.hostname : null;
      const idlePauseLabel = formatDurationMinutes(details.idlePauseMinutes);
      const rows = Array.isArray(details.items) ? details.items.slice(0, 10) : [];
      const names = rows.map(item => [cleanText(item?.title), cleanText(item?.company)].filter(Boolean).join(' — ')).filter(Boolean);
      if (!hostname) return { ok: false, code: 'INVALID' };
      else {
        detail = [
          [
            'Only ChatGPT chats you start can fetch released handoffs and return answers.',
            `Job listings, your career data, and drafts pass through Cloudflare at ${hostname} to ChatGPT. Cloudflare and ChatGPT can read this data; ChatGPT stores the chat.`,
            `Pause or Revoke anytime. Quitting ends active chats. After a restart, confirm released jobs again.${idlePauseLabel ? ` After ${idlePauseLabel} without action, serving pauses until Resume; the tunnel and link stay up.` : ''}`,
          ].join('\n\n'),
          names.length ? `Released jobs (${names.length}):\n${names.join('\n')}` : '',
        ].filter(Boolean).join('\n\n');
      }
    }
    if (kind === 'linkBreak') {
      const hostname = isValidHostname(details.hostname) ? details.hostname : null;
      if (!hostname) return { ok: false, code: 'INVALID' };
      detail = `Changing to ${hostname} breaks the current ChatGPT link. Reconnect it afterward.`;
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
        'ChatGPT receives your career data, job listings, and drafts through Cloudflare.',
      ].filter(Boolean).join('\n');
    }
    if (kind === 'restart') {
      const count = safeCount(details.releasedCount || details.items?.length);
      const names = (Array.isArray(details.items) ? details.items : []).slice(0, 10)
        .map(item => [cleanText(item?.title), cleanText(item?.company)].filter(Boolean).join(' — ')).filter(Boolean);
      detail = [
        count ? `${count} released ${count === 1 ? 'job' : 'jobs'} will be available to the new chat.` : '',
        names.join('\n'),
        'Chats from before the restart have ended.',
        `Next: paste it into a new ChatGPT chat with ${pluginRef(details.pluginName)} selected.`,
      ].filter(Boolean).join('\n');
    }
    if (kind === 'resume' && details.reason === 'anomaly') {
      const count = safeCount(details.count);
      const minutes = safeMinutes(details.minutes);
      const at = Number.isFinite(Number(details.at)) ? new Date(Number(details.at)).toLocaleString() : 'recently';
      detail = `The bridge paused after ${count || 'several'} unexpected ${count === 1 ? 'call' : 'calls'}${minutes ? ` in ${minutes} minutes` : ''}, at ${at}. Resuming lets ChatGPT receive released work again.`;
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
      const affirmative = {
        enable: 'Turn on', disable: 'Turn off', linkBreak: 'Change address', restart: 'Copy starter', resume: 'Resume',
        release: 'Release', releasePush: 'Release', forget: 'Forget setup', binaryApproval: 'Approve', scoring: 'Add scoring', marketplace: 'Add marketplace',
        autoStart: 'Turn on at launch', autoRelease: 'Release automatically', sourcePolicy: 'Reduce checks', limits: 'Increase limit', networkCheck: 'Turn off check',
      };
      const result = await dialog?.showMessageBox?.(parentWindow, {
        type: 'question', buttons: ['Cancel', affirmative[kind] || 'Continue'], defaultId: 0, cancelId: 0,
        title, message, detail,
      });
      return { ok: accepted(result), code: accepted(result) ? null : 'DECLINED' };
    } catch { return { ok: false, code: 'DECLINED' }; } finally { busy = false; }
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
    } catch { return { ok: false, code: 'DECLINED' }; } finally { busy = false; }
  }
  async function showCode({ parentWindow, code, expiresAt, signal, onShown } = {}) {
    if (!parentWindow || parentWindow.isDestroyed?.()) return { ok: false, code: 'NO_WINDOW' };
    if (busy) return { ok: false, code: 'BUSY' };
    if (typeof code !== 'string' || !/^[2-9A-HJ-NP-Z]{10}$/i.test(code)) return { ok: false, code: 'INVALID' };
    if (typeof dialog?.showMessageBox !== 'function') return { ok: false, code: 'DECLINED' };
    busy = true;
    try {
      const pending = dialog.showMessageBox(parentWindow, {
        type: 'info', buttons: ['Continue in setup', 'Cancel pairing'], defaultId: 0, cancelId: 1,
        title: 'ChatGPT pairing code', message: `Pairing code: ${formatPairingCode(code)}`, detail: `Expires at ${expiryClock(expiresAt)}.\nOnly approve if you just started linking from ChatGPT.\nNever share this code.`,
        signal,
      });
      // Electron has accepted the native-sheet request at this point. The
      // callback carries no pairing code and lets pairing.js emit its closed
      // open/close ledger pair only for a sheet that actually became live.
      try { onShown?.(); } catch { /* diagnostics cannot affect the sheet */ }
      const result = await pending;
      // This is an adapter-local capability, not a renderer value. Pairing
      // recognizes only literal true, so a missing or unfamiliar response
      // remains the safe cancellation path.
      return { ok: true, keepOpen: result?.response === 0 };
    } catch { return { ok: false, code: 'DECLINED' }; } finally { busy = false; }
  }
  function showNotice({ parentWindow, kind, clientKind } = {}) {
    if (!parentWindow || parentWindow.isDestroyed?.()) return { ok: false, code: 'NO_WINDOW' };
    if (!['link-requested', 'linked', 'pairing-closed'].includes(kind)) return { ok: false, code: 'INVALID' };
    // Pairing progress is already visible in the setup UI, and the pairing
    // code sheet carries the actionable warning. Keep this optional port for
    // the pairing state machine, but never stack an informational sheet.
    void clientKind;
    return { ok: true };
  }
  return Object.freeze({ ask, choose, showCode, showNotice, parentFor, isBusy: () => busy, describeForConfirm });
}

export default createHandoffBridgeDialogs;
