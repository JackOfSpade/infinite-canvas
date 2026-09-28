import crypto from 'node:crypto';
import { CONSTANTS } from './constants.js';
import { createProbeAuthenticator, probeOwnEgress } from './egressProbe.js';

const RENEWAL_WINDOW_MS = 30 * 60_000;
const HINT_INTERVAL_MS = 60_000;
const PAIRING_CLOSE_REASONS = new Set(['linked', 'denied', 'expired', 'cancelled', 'locked', 'replaced', 'restart', 'revoked']);
const safeClientKind = value => value === 'cimd' ? value : 'unknown';
const safeCloseReason = value => {
  if (PAIRING_CLOSE_REASONS.has(value)) return value;
  if (value === 'link_replaced' || value === 'replaced') return 'replaced';
  if (value === 'code_reuse' || value === 'refresh_reuse' || value === 'token_revoked_by_client' || value === 'link_revoked') return 'revoked';
  return 'cancelled';
};
// node:crypto intentionally has no isIP; retaining this compact parser here
// avoids adding node:net to pairing.js, whose import boundary is frozen.
function familyOf(value) {
  if (typeof value !== 'string' || value.length > 128) return 0;
  const octets = value.split('.');
  if (octets.length === 4 && octets.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return 4;
  return /^[0-9a-f:]+$/i.test(value) && value.includes(':') ? 6 : 0;
}

function v6Prefix(address) {
  const input = String(address).toLowerCase();
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some(part => !/^[0-9a-f]{1,4}$/.test(part)) || right.some(part => !/^[0-9a-f]{1,4}$/.test(part)) || left.length + right.length > 8) return null;
  const words = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return words.length === 8 ? words.slice(0, 4).map(word => word.padStart(4, '0')).join(':') : null;
}

export function normaliseEgressAddress(address) {
  const raw = typeof address === 'string' ? address.trim() : '';
  // http.js intentionally passes its bounded IPv6 /64 bucket between policy
  // modules. It carries the same pairing comparison information as the raw
  // address, but accept no other CIDR form here.
  const value = /^[0-9a-f:]+\/64$/i.test(raw) ? raw.slice(0, -3) : raw;
  const family = familyOf(value);
  if (family === 4) return Object.freeze({ family, value });
  const prefix = family === 6 ? v6Prefix(value) : null;
  return prefix ? Object.freeze({ family, value: prefix }) : null;
}

export function ownEgressMatches(left, right) {
  const a = normaliseEgressAddress(left); const b = normaliseEgressAddress(right);
  return Boolean(a && b && a.family === b.family && a.value === b.value);
}

function safeTime(now) {
  try { const value = Number(now()); return Number.isFinite(value) && value >= 0 ? value : 0; } catch { return 0; }
}

/**
 * Pairing policy is separate from OAuth parsing. OAuth owns code hashes and
 * transactions; this object owns the native-sheet lifetime, local egress
 * observations and the intentionally narrow reconnect hint.
 */
export function createPairingOrchestrator({
  oauth = {},
  egressProbe = probeOwnEgress,
  now = Date.now,
  request,
  lookup,
  randomBytes = crypto.randomBytes,
  showCode = async () => undefined,
  showNotice = async () => undefined,
  hint = () => undefined,
  onState = () => undefined,
  // Composition owns the concrete audit/logger sinks. These callbacks receive
  // only closed, code-free lifecycle facts after a native sheet is actually
  // shown; no remote authorize path can invoke either one.
  onOpened = () => undefined,
  onClosed = () => undefined,
  timers = globalThis,
  authenticator = createProbeAuthenticator({ randomBytes, now }),
} = {}) {
  let windowState = null;
  let ownEgress = [];
  let renewalAt = null;
  let lastHintAt = -Infinity;
  let expiryTimer = null;
  // A pairing open has two asynchronous parts (the dual-family probe and the
  // native sheet).  Keep an identity, rather than a boolean, so Cancel can
  // invalidate a stalled probe without allowing that old completion to create
  // a fresh OAuth code or sheet later.
  let opening = null;

  const emit = () => { try { onState(status()); } catch { /* state publication is best effort */ } };
  const fresh = () => windowState && windowState.expiresAt > safeTime(now);
  const closeOAuthPairing = () => { try { oauth.closePairing?.(); } catch { /* close remains local */ } };
  const clear = (reason, { announce = true, closeOAuth = true } = {}) => {
    if (!windowState) return false;
    const current = windowState;
    const parentWindow = current.parentWindow;
    if (expiryTimer !== null) {
      try { timers?.clearTimeout?.(expiryTimer); } catch { /* expiry is already closing */ }
      expiryTimer = null;
    }
    try { windowState.abort?.abort(); } catch { /* already closed */ }
    windowState = null;
    if (closeOAuth) closeOAuthPairing();
    if (current.live === true) {
      // A code is never included in this callback. A matching close is emitted
      // exactly once for each real sheet, including cancellation and expiry.
      try { onClosed(safeCloseReason(reason)); } catch { /* ledger logging is best effort */ }
    }
    // `linked` has its own positive notice.  Showing a close notice as well
    // would train a user to dismiss two contradictory sheets.
    if (announce) try { void showNotice({ parentWindow, kind: 'pairing-closed', reason }); } catch { /* notices are optional */ }
    emit();
    return true;
  };
  const trimOwnEgress = () => {
    const stamp = safeTime(now);
    ownEgress = ownEgress.filter(entry => entry.expiresAt > stamp);
  };

  function status() {
    trimOwnEgress();
    return Object.freeze({
      open: Boolean(fresh()),
      expiresAt: fresh() ? windowState.expiresAt : null,
      ownEgressFresh: ownEgress.length > 0,
    });
  }

  function recordOwnEgress({ header, address } = {}) {
    try { if (authenticator?.verify?.(header) !== true) return false; } catch { return false; }
    const normalized = normaliseEgressAddress(address);
    if (!normalized) return false;
    const expiresAt = safeTime(now) + CONSTANTS.OWN_EGRESS_TTL_MS;
    ownEgress = ownEgress.filter(entry => entry.family !== normalized.family);
    ownEgress.push({ ...normalized, expiresAt });
    emit();
    return true;
  }

  function networkMatches(address) {
    trimOwnEgress();
    const normalized = normaliseEgressAddress(address);
    return Boolean(normalized && ownEgress.some(entry => entry.family === normalized.family && entry.value === normalized.value));
  }

  function pairingGate(req = {}) {
    if (!fresh()) return false;
    const source = req?.headers?.['cf-connecting-ip'] ?? req?.source ?? req?.ip;
    // The code remains required even when this tripwire is turned off. This
    // gate only controls the optional same-network check.
    return windowState.networkCheck !== 'enforce' || networkMatches(String(source || '').trim());
  }

  function markLive(expiresAt) {
    if (!windowState || windowState.expiresAt !== expiresAt || windowState.live === true) return false;
    windowState.live = true;
    try { onOpened(); } catch { /* ledger logging is best effort */ }
    return true;
  }

  async function open({ hostname, parentWindow = null, networkCheck = 'enforce' } = {}) {
    if (windowState && !fresh()) clear('expired');
    if (opening || fresh()) return Object.freeze({ ok: false, code: 'BUSY', ...(fresh() ? { expiresAt: windowState.expiresAt } : {}) });
    if (!parentWindow || parentWindow.isDestroyed?.()) return Object.freeze({ ok: false, code: 'NO_WINDOW' });
    // Opening a pairing window is confirmed exactly once by the IPC/native
    // dialog layer. A second confirmation here could present two sheets for
    // one click and made the result depend on composition.
    const gate = Object.freeze({});
    opening = gate;
    try {
      const probe = await egressProbe({ hostname, request, lookup, authenticator });
      if (opening !== gate) return Object.freeze({ ok: false, code: 'NOT_READY' });
      trimOwnEgress();
      if (!probe?.ok || ownEgress.length === 0) return Object.freeze({ ok: false, code: 'TUNNEL_NOT_READY' });
      if (parentWindow.isDestroyed?.()) return Object.freeze({ ok: false, code: 'NO_WINDOW' });
      let code;
      try { code = oauth.openPairing?.(); } catch { code = null; }
      // OAuth owns the canonical human-facing XXXXX-XXXXX value.  The native
      // dialog port receives compact symbols only and formats them itself.
      if (typeof code !== 'string' || !/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/i.test(code)) {
        // A malformed OAuth port must never leave a hidden live pairing code.
        closeOAuthPairing();
        return Object.freeze({ ok: false, code: 'NOT_READY' });
      }
      if (opening !== gate) {
        closeOAuthPairing();
        return Object.freeze({ ok: false, code: 'NOT_READY' });
      }
      code = code.replace('-', '').toUpperCase();
      const pairingCode = `${code.slice(0, 5)}-${code.slice(5)}`;
      const expiresAt = safeTime(now) + CONSTANTS.PAIRING_TTL_MS;
      const abort = typeof AbortController === 'function' ? new AbortController() : null;
      // Do not start the expiry clock merely because an adapter accepted a
      // method call.  The dialog port must synchronously acknowledge that it
      // submitted a real, parented native sheet.  This keeps a missing/busy
      // adapter from leaving an OAuth code, Activity fact, test hook, or timer
      // alive in the background.
      windowState = { expiresAt, networkCheck: networkCheck === 'off' ? 'off' : 'enforce', abort, parentWindow, live: false };
      let shownResult;
      try {
        // Code travels to the main-owned dialog port and back to the direct,
        // user-initiated open call only. It is deliberately absent from state
        // snapshots, logger, activity and every other publication channel.
        // The native sheet can explicitly hand this live pairing back to setup;
        // do not wait for its promise here, because OAuth must receive browser
        // requests while the sheet is visible or after it continues in setup.
        shownResult = showCode({ parentWindow, code, expiresAt, signal: abort?.signal, onShown: () => markLive(expiresAt) });
      } catch {
        clear('cancelled', { announce: false });
        return Object.freeze({ ok: false, code: 'DECLINED' });
      }
      if (windowState?.expiresAt !== expiresAt || windowState.live !== true) {
        // An adapter that resolves/rejects later without the synchronous
        // acknowledgement cannot prove a sheet exists.  Consume its eventual
        // rejection so a bad injected port cannot make an unhandled promise,
        // but never let that later completion resurrect the pairing state.
        try { Promise.resolve(shownResult).catch(() => undefined); } catch { /* non-thenable adapters are already inert */ }
        clear('cancelled', { announce: false });
        return Object.freeze({ ok: false, code: 'NOT_READY' });
      }
      try {
        if (typeof timers?.setTimeout !== 'function') throw new TypeError('timer unavailable');
        expiryTimer = timers.setTimeout(() => { if (windowState?.expiresAt === expiresAt) clear('expired'); }, CONSTANTS.PAIRING_TTL_MS);
        expiryTimer?.unref?.();
      } catch {
        clear('expired', { announce: false });
        return Object.freeze({ ok: false, code: 'NOT_READY' });
      }
      Promise.resolve(shownResult).then(
        // Only the trusted native dialog adapter can explicitly dismiss its
        // sheet while keeping the code armed for the setup panel. Any older,
        // failed, cancelled, or otherwise ambiguous adapter result fails
        // closed by cancelling the pairing.
        result => { if (fresh() && result?.keepOpen !== true) clear('cancelled'); },
        () => { if (fresh()) clear('cancelled'); },
      );
      emit();
      return Object.freeze({ ok: true, expiresAt, pairingCode });
    } catch {
      return Object.freeze({ ok: false, code: 'TUNNEL_NOT_READY' });
    } finally {
      if (opening === gate) opening = null;
    }
  }

  function cancel(reason = 'cancelled') {
    const wasOpening = opening !== null;
    opening = null;
    return clear(reason) || wasOpening ? Object.freeze({ ok: true }) : Object.freeze({ ok: false, code: 'NOT_READY' });
  }

  // OAuth invokes this only for its two terminal browser-side outcomes.  It
  // deliberately does not call back into OAuth: OAuth already cleared its
  // code/transactions, and this side only owns the native timer/sheet.
  function onOAuthPairingClosed(reason) {
    if (reason !== 'denied' && reason !== 'locked') return false;
    opening = null;
    return clear(reason, { closeOAuth: false });
  }

  function onConsentRequested({ clientKind } = {}) {
    if (!fresh()) return false;
    // clientKind is an OAuth enum, not client_name or a redirect supplied by a
    // remote client. The dialog adapter supplies fixed wording around it.
    try { void showNotice({ parentWindow: windowState.parentWindow, kind: 'link-requested', clientKind: safeClientKind(clientKind) }); } catch { /* isolated */ }
    return true;
  }

  function onLinked({ clientKind } = {}) {
    const parentWindow = windowState?.parentWindow || null;
    clear('linked', { announce: false, closeOAuth: false });
    try { void showNotice({ parentWindow, kind: 'linked', clientKind: safeClientKind(clientKind) }); } catch { /* isolated */ }
    return true;
  }

  function onDisconnected({ reason } = {}) {
    const knownRenewal = reason === 'refresh_expired' || reason === 'invalid_grant';
    if (knownRenewal) renewalAt = safeTime(now);
    if (reason === 'code_reuse' || reason === 'refresh_reuse' || reason === 'restart' || reason === 'replaced' || reason === 'link_replaced') clear(reason);
  }

  function maybeHint({ source, linkState, knownFamily = false } = {}) {
    const stamp = safeTime(now);
    if (linkState !== 'needs-renewal' || !knownFamily || renewalAt === null || stamp - renewalAt > RENEWAL_WINDOW_MS || !networkMatches(source) || stamp - lastHintAt < HINT_INTERVAL_MS) return false;
    lastHintAt = stamp;
    try { hint({ kind: 'reconnect' }); } catch { /* hints are non-authoritative */ }
    return true;
  }

  function tick() { if (windowState && !fresh()) clear('expired'); trimOwnEgress(); return status(); }
  return Object.freeze({ open, cancel, close: cancel, tick, status, pairingGate, recordOwnEgress, networkMatches, onOAuthPairingClosed, onConsentRequested, onLinked, onDisconnected, maybeHint, probeAuthenticator: authenticator });
}

export default createPairingOrchestrator;
