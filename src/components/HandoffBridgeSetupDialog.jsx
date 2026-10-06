import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { updateModalCount } from './modalStack';
import { useHandoffBridgeStatus } from '../hooks/useHandoffBridgeStatus';
import {
  closeBridgeSetup,
  getBridgeUiState,
  openBridgePopover,
  openBridgeSetup,
  subscribeBridgeUi,
} from '../utils/handoffBridgeUiStore';
import {
  BRIDGE_SETUP_COPY,
  BRIDGE_UI_COPY,
  ipcErrorMessage,
  sanitizeTunnelLogLine,
} from '../utils/handoffBridgeCopy';
import { isValidHostname, isValidPluginName } from '../utils/handoffBridgeConfig';
import { openExternalUrl } from '../utils/openExternal';
import { sanitizeBridgeLabel } from '../utils/handoffBridgeQueue';
import { TIMINGS } from '../utils/timings';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Keep this order tied to the renderer status contract, rather than object
// enumeration. New progress fields must not silently relabel a completed step.
const LINK_PROGRESS_KEYS = Object.freeze([
  'discoveryFetched',
  'authorizeRequested',
  'approved',
  'tokenIssued',
  'toolsListed',
]);
const PAIRING_CODE = /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/i;
const COPY_TARGET = Object.freeze({
  PLUGIN_NAME: 'plugin-name',
  SERVER_URL: 'server-url',
  PAIRING_CODE: 'pairing-code',
});

function bridgeApi() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}
function externalDispatcher() {
  try { return bridgeApi()?.openExternal; } catch { return null; }
}
function browserOpen() {
  try { return globalThis.window?.open; } catch { return null; }
}
function safeResult(result) {
  try {
    if (!result || typeof result !== 'object') return { success: true, lines: [] };
    if (result.success === false) return { success: false, code: typeof result.code === 'string' ? result.code : 'INTERNAL', lines: [] };
    return { success: true, lines: Array.isArray(result.lines) ? result.lines : [] };
  } catch {
    return { success: false, code: 'INTERNAL', lines: [] };
  }
}
function safePairingResult(result) {
  const base = safeResult(result);
  if (base.success === false) return base;
  try {
    const expiresAt = Number.isFinite(result?.expiresAt) && result.expiresAt > Date.now()
      ? result.expiresAt
      : null;
    const pairingCode = expiresAt && typeof result?.pairingCode === 'string' && PAIRING_CODE.test(result.pairingCode)
      ? result.pairingCode.toUpperCase()
      : null;
    // A successful Open pairing response is useful only as the complete,
    // short-lived capability tuple. Fail closed if a malformed preload/main
    // implementation returns a partial success, then cancel it below.
    if (!expiresAt || !pairingCode) return { success: false, code: 'INTERNAL', lines: [] };
    return { ...base, expiresAt, pairingCode };
  } catch {
    return { success: false, code: 'INTERNAL', lines: [] };
  }
}
function invoke(api, method, payload) {
  try {
    const fn = api?.[method];
    if (typeof fn !== 'function') return Promise.resolve({ success: false, code: 'UNAVAILABLE' });
    return Promise.resolve(payload === undefined ? fn.call(api) : fn.call(api, payload)).then(safeResult, () => ({ success: false, code: 'INTERNAL', lines: [] }));
  } catch {
    return Promise.resolve({ success: false, code: 'INTERNAL' });
  }
}
function invokePairing(api) {
  try {
    const fn = api?.handoffBridgeOpenPairing;
    if (typeof fn !== 'function') return Promise.resolve({ success: false, code: 'UNAVAILABLE' });
    return Promise.resolve(fn.call(api)).then(safePairingResult, () => ({ success: false, code: 'INTERNAL' }));
  } catch {
    return Promise.resolve({ success: false, code: 'INTERNAL' });
  }
}

function CheckRow({ complete, children }) {
  return (
    <li className={'flex items-start gap-1.5 ' + (complete ? 'text-emerald-300' : 'text-white/45')}>
      {complete
        ? <Check size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
        : <span className="mt-1 h-2 w-2 shrink-0 rounded-full border border-current" aria-hidden="true" />}
      {children}
    </li>
  );
}

function focusableElements(container) {
  if (!container) return [];
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(element => (
    element instanceof HTMLElement
    && !element.hasAttribute('disabled')
    && element.getClientRects().length > 0
  ));
}

export function HandoffBridgeSetupDialog() {
  const status = useHandoffBridgeStatus();
  const { seq: statusSequence } = status;
  const ui = useSyncExternalStore(subscribeBridgeUi, getBridgeUiState, getBridgeUiState);
  const [notice, setNotice] = useState('');
  const [logLines, setLogLines] = useState([]);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [pairingOpening, setPairingOpening] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState(null);
  const hostnameRef = useRef(null);
  const pluginNameRef = useRef(null);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const mountedRef = useRef(true);
  const enableRequestRef = useRef(0);
  const pairingWasOpenRef = useRef(false);
  const pairingRequestRef = useRef(0);
  const pairingOpeningRef = useRef(false);
  const pairingOwnedRef = useRef(false);
  const setupWasVisibleRef = useRef(false);
  const statusSeqRef = useRef(statusSequence);
  const copyFeedbackTimerRef = useRef(null);
  const copyRequestRef = useRef(0);
  const copy = BRIDGE_SETUP_COPY;
  const visible = Boolean(ui.setup) && status.availability.ok;
  const requestedStep = ui.setup?.step || 1;
  const tunnelPrerequisitesSaved = status.setup.hostnameOk
    && status.setup.binaryApproved
    && status.setup.credentialsOk;
  const binaryApproved = status.setup.binaryApproved || status.tunnel.binary?.approved;
  const binarySelected = binaryApproved || Boolean(status.tunnel.binary);
  const binarySummary = status.tunnel.binary?.version
    ? sanitizeBridgeLabel(status.tunnel.binary.version)
    : binarySelected ? copy.binarySelected : copy.noBinary;
  const credentialsSummary = status.tunnel.tunnelId
    ? sanitizeBridgeLabel(status.tunnel.tunnelId)
    : status.setup.credentialsOk ? copy.credentialsSelected : copy.noCredentials;
  const tunnelReady = status.enabled && status.setup.tunnelReachable;
  const enablePending = enabling && !status.enabled;
  const visibleEnableError = !status.enabled ? enableError?.message || '' : '';
  const linkReady = status.enabled && status.setup.linked;
  const canAccessStep = target => target <= 2
    || (target === 3 && tunnelReady)
    || (target === 4 && tunnelReady && linkReady);
  const step = canAccessStep(requestedStep)
    ? requestedStep
    : requestedStep === 4 && tunnelReady ? 3 : 2;
  const nextStep = Math.min(4, step + 1);
  const canAdvance = step === 4 || canAccessStep(nextStep);
  const canStartChat = status.enabled
    && status.serving === 'live'
    && !status.paused
    && tunnelReady
    && linkReady;
  const pluginNameForChatGpt = status.config.pluginName || copy.suggestedPluginName;
  // The expiry effect owns visible lifetime. The copy handler independently
  // checks wall time so a background-throttled timer cannot make a stale code
  // usable during the first event-loop turn after wake.
  const activePairing = pairing;

  const clearEnableFeedback = useCallback(() => {
    enableRequestRef.current += 1;
    setEnabling(false);
    setEnableError(null);
  }, []);

  const cancelOwnedPairing = useCallback(() => {
    if (!pairingOwnedRef.current) return false;
    pairingOwnedRef.current = false;
    void invoke(bridgeApi(), 'handoffBridgeCancelPairing');
    return true;
  }, []);

  const clearCopyFeedback = useCallback(() => {
    copyRequestRef.current += 1;
    if (copyFeedbackTimerRef.current !== null) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    setCopiedTarget(null);
  }, []);

  const showCopyFeedback = useCallback((target, requestId) => {
    if (requestId !== copyRequestRef.current) return;
    if (copyFeedbackTimerRef.current !== null) clearTimeout(copyFeedbackTimerRef.current);
    setCopiedTarget(target);
    copyFeedbackTimerRef.current = setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      if (mountedRef.current && requestId === copyRequestRef.current) setCopiedTarget(null);
    }, TIMINGS.FEEDBACK_MS);
  }, []);

  const dismissSetup = useCallback(() => {
    clearEnableFeedback();
    clearCopyFeedback();
    cancelOwnedPairing();
    pairingWasOpenRef.current = false;
    pairingRequestRef.current += 1;
    pairingOpeningRef.current = false;
    setPairingOpening(false);
    setPairing(null);
    closeBridgeSetup();
  }, [cancelOwnedPairing, clearCopyFeedback, clearEnableFeedback]);

  useEffect(() => {
    if (!visible) return undefined;
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, [visible]);

  useEffect(() => {
    // Main publishes enabled/starting before the Enable IPC resolves.  Do not
    // clear that request's token on the transient snapshot: its later failure
    // must still be able to render after main returns to the saved off state.
    // Once an Enable response failed, its error must outlive the preceding
    // optimistic enabled snapshot until the user retries, changes setup, or
    // closes the dialog. Main can publish the final saved-off snapshot after
    // that response; clearing here would hide the actionable error exactly
    // when it becomes renderable.
    if (visible && (enabling || enableError || !status.enabled)) return undefined;
    // Defer the feedback reset so it follows the status/visibility update
    // rather than synchronously cascading another render from this effect.
    const timer = setTimeout(clearEnableFeedback, 0);
    return () => clearTimeout(timer);
  }, [clearEnableFeedback, enableError, enabling, status.enabled, visible]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      cancelOwnedPairing();
      copyRequestRef.current += 1;
      if (copyFeedbackTimerRef.current !== null) {
        clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
      mountedRef.current = false;
      pairingWasOpenRef.current = false;
      pairingRequestRef.current += 1;
      pairingOpeningRef.current = false;
    };
  }, [cancelOwnedPairing]);

  useEffect(() => {
    if (visible) {
      setupWasVisibleRef.current = true;
      return;
    }
    if (!setupWasVisibleRef.current) return;
    setupWasVisibleRef.current = false;
    // The setup UI can be hidden by its external store as well as its own X,
    // overlay and Escape controls. Treat every such hide as a close for the
    // pairing this renderer started, without touching another window's pair.
    cancelOwnedPairing();
    clearCopyFeedback();
    pairingWasOpenRef.current = false;
    pairingRequestRef.current += 1;
    pairingOpeningRef.current = false;
    setPairingOpening(false);
    setPairing(null);
  }, [cancelOwnedPairing, clearCopyFeedback, visible]);

  useEffect(() => {
    statusSeqRef.current = statusSequence;
  }, [statusSequence]);

  useEffect(() => {
    if (status.link.pairing.open) {
      pairingWasOpenRef.current = true;
      return;
    }
    // A direct response can arrive before its status publication. Only clear
    // it after this dialog has actually observed a live pairing turn closed.
    if (pairingWasOpenRef.current || (pairing?.code && statusSequence > pairing.afterSeq)) {
      pairingOwnedRef.current = false;
      pairingWasOpenRef.current = false;
      pairingRequestRef.current += 1;
      pairingOpeningRef.current = false;
      setPairingOpening(false);
      setPairing(null);
    }
  }, [pairing?.afterSeq, pairing?.code, status.link.pairing.open, statusSequence]);

  useEffect(() => {
    if (!pairing?.expiresAt) return undefined;
    const delay = Math.max(0, pairing.expiresAt - Date.now());
    const timer = setTimeout(() => {
      cancelOwnedPairing();
      pairingRequestRef.current += 1;
      pairingOpeningRef.current = false;
      setPairingOpening(false);
      setPairing(null);
    }, delay);
    return () => clearTimeout(timer);
  }, [cancelOwnedPairing, pairing]);

  useEffect(() => {
    if (!visible) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      else document.querySelector('[data-handoff-bridge-trigger]')?.focus();
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissSetup();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissSetup, visible]);

  const trapFocus = useCallback(event => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    const elements = focusableElements(dialog);
    if (!dialog || !elements.length) {
      event.preventDefault();
      dialog?.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const call = useCallback(async (method, payload) => {
    const result = await invoke(bridgeApi(), method, payload);
    if (mountedRef.current) {
      setNotice(result?.success === false ? ipcErrorMessage(result.code) : BRIDGE_UI_COPY.saved);
    }
    return result;
  }, []);

  const prepareFirstWorkerPlan = useCallback(async () => {
    const result = await invoke(bridgeApi(), 'handoffBridgeStartWorkerPool');
    if (!mountedRef.current) return result;
    if (result?.success === false) {
      setNotice(ipcErrorMessage(result.code));
      return result;
    }
    // The panel owns the one-at-a-time clipboard controls for every unique
    // starter, including the one-worker plan. Close setup rather than leaving
    // a plan hidden behind this modal.
    closeBridgeSetup();
    openBridgePopover();
    return result;
  }, []);

  const mutateSetup = useCallback(async (method, payload) => {
    clearEnableFeedback();
    return call(method, payload);
  }, [call, clearEnableFeedback]);

  const saveAddress = useCallback(async () => {
    const hostname = hostnameRef.current?.value || '';
    const pluginName = pluginNameRef.current?.value || '';
    if (!isValidHostname(hostname) || !isValidPluginName(pluginName)) {
      setNotice(BRIDGE_SETUP_COPY.invalid);
      return;
    }
    const patch = { hostname, pluginName };
    await mutateSetup('handoffBridgeSaveConfig', { patch });
  }, [mutateSetup]);

  const enableBridge = useCallback(async () => {
    if (enabling || status.enabled || !tunnelPrerequisitesSaved) return;
    const requestId = enableRequestRef.current + 1;
    enableRequestRef.current = requestId;
    setEnabling(true);
    setEnableError(null);
    setNotice('');
    const result = await invoke(bridgeApi(), 'handoffBridgeSetEnabled', { enabled: true });
    if (!mountedRef.current || requestId !== enableRequestRef.current) return;
    if (result?.success === false) {
      setEnabling(false);
      setEnableError({ message: ipcErrorMessage(result.code) });
      return;
    }
    setEnabling(false);
    setEnableError(null);
  }, [enabling, status.enabled, tunnelPrerequisitesSaved]);

  const openPlugins = useCallback(async () => {
    const result = await openExternalUrl('https://chatgpt.com/plugins', {
      dispatcher: externalDispatcher(),
      fallback: browserOpen(),
    });
    if (!result.ok && mountedRef.current) setNotice(BRIDGE_UI_COPY.externalLinkFailure);
  }, []);

  const showTunnelLog = useCallback(async () => {
    const result = await invoke(bridgeApi(), 'handoffBridgeGetTunnelLog');
    if (!mountedRef.current) return;
    if (result?.success === false) {
      setNotice(ipcErrorMessage(result.code));
      return;
    }
    setLogLines(Array.isArray(result?.lines)
      ? result.lines.map(sanitizeTunnelLogLine).filter(Boolean).slice(0, 20)
      : []);
  }, []);

  const copyValue = useCallback(async (value, target) => {
    const requestId = copyRequestRef.current + 1;
    copyRequestRef.current = requestId;
    if (copyFeedbackTimerRef.current !== null) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    setCopiedTarget(null);
    setNotice('');
    try {
      if (typeof value !== 'string' || !value || typeof navigator?.clipboard?.writeText !== 'function') throw new Error('unavailable');
      await navigator.clipboard.writeText(value);
      if (mountedRef.current && requestId === copyRequestRef.current) showCopyFeedback(target, requestId);
    } catch {
      if (mountedRef.current && requestId === copyRequestRef.current) {
        setCopiedTarget(null);
        setNotice(ipcErrorMessage('CLIPBOARD_FAILED'));
      }
    }
  }, [showCopyFeedback]);

  const copyServerUrl = useCallback(() => copyValue(status.config.mcpUrl, COPY_TARGET.SERVER_URL), [copyValue, status.config.mcpUrl]);

  const openPairing = useCallback(async () => {
    // React may not commit a disabled button between the two click events of
    // a fast double-click. Keep a synchronous guard as well, so the second
    // event cannot turn the first successful open into a BUSY result and hide
    // its only renderer-local code.
    if (pairingOpeningRef.current) return { success: false, code: 'BUSY' };
    pairingOpeningRef.current = true;
    pairingOwnedRef.current = true;
    setPairingOpening(true);
    // A new attempt never leaves an older code visible, including a failed
    // attempt. The native sheet remains main-owned and opens as before.
    const requestId = pairingRequestRef.current + 1;
    pairingRequestRef.current = requestId;
    setPairing(null);
    const result = await invokePairing(bridgeApi());
    if (!mountedRef.current || requestId !== pairingRequestRef.current) {
      // Dismiss/cancel may race an admitted main-process open. A late success
      // must be closed even though this renderer will never display its code.
      if (result?.success !== false) void invoke(bridgeApi(), 'handoffBridgeCancelPairing');
      return result;
    }
    pairingOpeningRef.current = false;
    setPairingOpening(false);
    if (result?.success === false) {
      cancelOwnedPairing();
      setNotice(ipcErrorMessage(result.code));
      return result;
    }
    if (result?.pairingCode && result.expiresAt) setPairing({
      code: result.pairingCode,
      expiresAt: result.expiresAt,
      // A false snapshot that predates this click is stale relative to this
      // response. Any later false sequence conclusively closes its code even
      // if a coalesced main publication hid the intervening open state.
      afterSeq: statusSeqRef.current,
    });
    setNotice(BRIDGE_UI_COPY.saved);
    return result;
  }, [cancelOwnedPairing]);

  const cancelPairing = useCallback(() => {
    pairingOwnedRef.current = false;
    pairingWasOpenRef.current = false;
    pairingRequestRef.current += 1;
    pairingOpeningRef.current = false;
    setPairingOpening(false);
    setPairing(null);
    void call('handoffBridgeCancelPairing');
  }, [call]);

  const copyPairingCode = useCallback(() => {
    if (!pairing?.code || pairing.expiresAt <= Date.now()) {
      cancelOwnedPairing();
      pairingRequestRef.current += 1;
      setPairing(null);
      return Promise.resolve();
    }
    return copyValue(pairing.code, COPY_TARGET.PAIRING_CODE);
  }, [cancelOwnedPairing, copyValue, pairing]);

  if (!visible || typeof document === 'undefined') return null;

  const goToStep = target => {
    if (canAccessStep(target)) openBridgeSetup(target);
  };
  const missingTunnelPrerequisites = [
    !status.setup.binaryApproved && (binarySelected ? copy.approveBinaryFirst : copy.chooseAndApproveBinaryFirst),
    !status.setup.credentialsOk && copy.chooseCredentialsFirst,
    !status.setup.hostnameOk && copy.saveAddressFirst,
  ].filter(Boolean);
  const tunnelProgressMessage = missingTunnelPrerequisites.length > 0
    ? missingTunnelPrerequisites.join(' ')
    : !status.enabled && status.autoStart && !status.setup.consentCurrent
      ? BRIDGE_UI_COPY.renewConsentToStart
    : !status.enabled
      ? copy.turnOnBridgeFirst
      : !tunnelReady
        ? copy.waitForTunnel
        : null;
  const lockedNextMessage = step === 2 && !tunnelReady
    ? tunnelProgressMessage
    : step === 3 && !linkReady
      ? copy.completeLinkFirst
      : null;
  const tunnel = (
    <div className="space-y-3">
      <p>{copy.tunnelLead}</p>
      <div className="rounded bg-black/20 p-2 text-[11px]">
        <p>{copy.binary}: {binarySummary}{binarySelected ? ` · ${binaryApproved ? copy.approved : copy.notApproved}` : ''}</p>
        <p>{copy.credentials}: {credentialsSummary}</p>
        {status.tunnel.credentialsMode === 'too-open' && <p className="mt-1 text-amber-200">{copy.credentialsTooOpen}</p>}
        {status.tunnel.certPemPresent && <p className="mt-1 text-amber-200">{copy.certPresent}</p>}
      </div>
      <div className="flex min-w-0 flex-wrap gap-2">
        <button type="button" className="bridge-button-secondary" onClick={() => void mutateSetup('handoffBridgeChooseBinary')}>{copy.chooseBinary}</button>
        <button type="button" className="bridge-button-secondary" onClick={() => void mutateSetup('handoffBridgeApproveBinary')}>{copy.approveBinary}</button>
        <button type="button" className="bridge-button-secondary" disabled={!status.setup.binaryApproved} onClick={() => void mutateSetup('handoffBridgeChooseCredentials')}>{copy.chooseCredentials}</button>
      </div>
      <label className="block min-w-0 text-xs text-white/70">
        {copy.publicAddress}
        <input ref={hostnameRef} aria-label={copy.publicAddress} defaultValue={status.config.hostname || ''} placeholder={copy.hostnamePlaceholder} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-white" />
      </label>
      <details>
        <summary className="text-xs text-white/70">{copy.advanced}</summary>
        <label className="mt-2 block min-w-0 text-xs text-white/70">
          {copy.pluginName}
          <input ref={pluginNameRef} aria-label={copy.pluginName} defaultValue={status.config.pluginName || copy.defaultPluginName} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-white" />
        </label>
        <label className="mt-2 flex items-start gap-2 text-[11px] text-white/70">
          <input
            type="checkbox"
            checked={status.config.telemetryInBugReports}
            onChange={() => void mutateSetup('handoffBridgeSaveConfig', {
              patch: { telemetryInBugReports: !status.config.telemetryInBugReports },
            })}
          />
          {copy.includeDiagnostics}
        </label>
      </details>
      <p className="text-[11px] text-white/45">{copy.status}: {copy.tunnelStates[status.tunnel.state] || copy.tunnelStates.unknown}</p>
      <div className="flex min-w-0 flex-wrap gap-2">
        <button type="button" className="bridge-button-secondary" onClick={saveAddress}>{copy.saveAddress}</button>
        {tunnelPrerequisitesSaved && !status.enabled && (
          <button
            type="button"
            className="bridge-button-primary"
            disabled={enablePending}
            aria-busy={enablePending || undefined}
            onClick={() => void enableBridge()}
          >
            {enablePending ? copy.turningOnBridge : copy.turnOnBridge}
          </button>
        )}
        <button type="button" className="bridge-button-secondary" disabled={!status.enabled} onClick={() => void call('handoffBridgeRestartTunnel')}>{copy.restartTunnel}</button>
        <button type="button" className="bridge-button-secondary" onClick={() => void showTunnelLog()}>{copy.showLog}</button>
      </div>
      {logLines.length > 0 && (
        <section aria-label={copy.tunnelLog} className="rounded bg-black/20 p-2 text-[11px] text-white/55">
          <h3 className="mb-1 font-medium text-white/75">{copy.tunnelLog}</h3>
          <ul>{logLines.map((line, index) => <li key={line + '-' + index}>{line}</li>)}</ul>
        </section>
      )}
      {logLines.length === 0 && <p className="text-[11px] text-white/40">{copy.noTunnelLog}</p>}
      <p className="rounded bg-black/20 p-2 text-[11px] text-white/45">{copy.commandPreview}</p>
      <details className="text-[11px] text-white/45">
        <summary>{copy.noTunnel}</summary>
        <p className="mt-2">{copy.tunnelCommands}</p>
        <ol className="mt-2 list-decimal pl-4">{copy.tunnelCommandList.map(command => <li key={command}><code>{command}</code></li>)}</ol>
        <p className="mt-2">{copy.zoneChecklist}</p>
      </details>
    </div>
  );
  const plugin = (
    <div className="space-y-3">
      <p>{copy.pairingLead}</p>
      <div className="flex min-w-0 flex-wrap gap-2">
        <button type="button" className="bridge-button-secondary" disabled={!tunnelReady || pairingOpening || Boolean(activePairing?.code) || status.link.pairing.open} aria-busy={pairingOpening || undefined} onClick={() => void openPairing()}>{copy.openPairing}</button>
        <button type="button" className="bridge-button-secondary" onClick={openPlugins}>{copy.openChatGpt}</button>
        <button type="button" className="bridge-button-secondary" disabled={!status.link.pairing.open && !activePairing?.code} onClick={cancelPairing}>{copy.cancelPairing}</button>
      </div>
      <div className="rounded bg-black/20 p-2 text-[11px] text-white/55">
        <p>{copy.suggestedPluginNameLead}</p>
        <button type="button" aria-label={copy.copyPluginName} className="mt-1 break-all text-left text-sky-200 underline decoration-sky-200/40 underline-offset-2" onClick={() => void copyValue(pluginNameForChatGpt, COPY_TARGET.PLUGIN_NAME)}>
          <code>{pluginNameForChatGpt}</code>
          {copiedTarget === COPY_TARGET.PLUGIN_NAME && (
            <span role="status" data-copy-feedback-for={COPY_TARGET.PLUGIN_NAME} className="ml-2 inline-flex items-center gap-1 whitespace-nowrap text-emerald-300 no-underline">
              <Check size={12} aria-hidden="true" /> {copy.pluginNameCopied}
            </span>
          )}
        </button>
      </div>
      <ul className="space-y-1 text-[11px]">{copy.progressItems.map((item, index) => <CheckRow key={item} complete={Boolean(status.link.progress[LINK_PROGRESS_KEYS[index]])}>{item}</CheckRow>)}</ul>
      <ol className="list-decimal space-y-1 pl-5 text-white/55">{copy.pluginSteps.map(item => <li key={item}>{item}</li>)}</ol>
      <button type="button" aria-label={copy.copyServerUrl} disabled={!status.config.mcpUrl} className="block w-full break-all rounded bg-black/30 p-2 text-left text-[11px] text-sky-200 disabled:cursor-not-allowed disabled:text-white/45" onClick={() => void copyServerUrl()}>
        <code>{status.config.mcpUrl || copy.serverUnavailable}</code>
        {copiedTarget === COPY_TARGET.SERVER_URL && (
          <span role="status" data-copy-feedback-for={COPY_TARGET.SERVER_URL} className="ml-2 inline-flex items-center gap-1 whitespace-nowrap text-emerald-300">
            <Check size={12} aria-hidden="true" /> {copy.serverUrlCopied}
          </span>
        )}
      </button>
      {activePairing?.code && (
        <div className="rounded bg-black/20 p-2 text-[11px] text-white/55">
          <p>{copy.pairingCode}</p>
          <button type="button" aria-label={copy.copyPairingCode} className="mt-1 text-left text-sky-200 underline decoration-sky-200/40 underline-offset-2" onClick={() => void copyPairingCode()}>
            <code>{activePairing.code}</code>
            {copiedTarget === COPY_TARGET.PAIRING_CODE && (
              <span role="status" data-copy-feedback-for={COPY_TARGET.PAIRING_CODE} className="ml-2 inline-flex items-center gap-1 whitespace-nowrap text-emerald-300 no-underline">
                <Check size={12} aria-hidden="true" /> {copy.pairingCodeCopied}
              </span>
            )}
          </button>
          <p className="mt-1">{copy.pairingCodeWarning}</p>
          <p>{copy.pairingCodeExpiry}</p>
        </div>
      )}
      <p className="text-[11px] text-white/45">{copy.earlyBlock}</p>
      <p className="text-[11px] text-white/45">{copy.reconnect}</p>
    </div>
  );
  const firstChat = (
    <div className="space-y-3">
      <p>{copy.firstChat}</p>
      <button type="button" disabled={!canStartChat} className="bridge-button-primary" onClick={() => void prepareFirstWorkerPlan()}>{BRIDGE_UI_COPY.startWorkerPool}</button>
      {!canStartChat && <p className="text-[11px] text-amber-200">{linkReady ? copy.bridgeMustBeReady : copy.completeLinkFirst}</p>}
    </div>
  );
  const body = step === 1
    ? <><p>{copy.overview}</p><p className="text-white/50">{copy.requirements}</p></>
    : step === 2 ? tunnel
      : step === 3 ? plugin
        : firstChat;
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
        onMouseDown={event => {
          if (event.target === event.currentTarget) dismissSetup();
        }}
      >
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="handoff-bridge-setup-title"
          tabIndex={-1}
          onKeyDown={trapFocus}
          className="w-[min(560px,calc(100vw-2rem))] min-w-0 max-h-[85vh] overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900 p-5 shadow-2xl"
        >
          <header className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="handoff-bridge-setup-title" className="text-base font-semibold text-white">{copy.title}</h2>
              <p className="text-xs text-white/45">{copy.steps[step - 1]}</p>
            </div>
            <button type="button" onClick={dismissSetup} aria-label={copy.close} className="bridge-icon-button"><X size={18} /></button>
          </header>
          <div className="mt-4 flex gap-1">
            {copy.steps.map((item, index) => {
              const target = index + 1;
              const accessible = canAccessStep(target);
              return (
                <button
                  type="button"
                  key={item}
                  disabled={!accessible}
                  onClick={() => goToStep(target)}
                  className={'h-1.5 flex-1 rounded ' + (target <= step ? 'bg-sky-400' : 'bg-white/15')}
                  aria-label={copy.goTo(item)}
                  aria-current={target === step ? 'step' : undefined}
                />
              );
            })}
          </div>
          <div className="mt-5 min-w-0 space-y-3 break-words text-sm leading-relaxed text-white/75">
            {body}
            {lockedNextMessage && <p className="text-[11px] text-amber-200">{lockedNextMessage}</p>}
            {(notice || visibleEnableError) && <p role="status" className="text-xs text-amber-200">{notice || visibleEnableError}</p>}
          </div>
          <footer className="mt-6 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => goToStep(Math.max(1, step - 1))} disabled={step === 1} className="bridge-button-secondary"><ChevronLeft size={14} /> {copy.back}</button>
            {step < 4 ? (
              <button type="button" disabled={!canAdvance} onClick={() => goToStep(nextStep)} className="bridge-button-primary">{copy.next} <ChevronRight size={14} /></button>
            ) : (
              <button type="button" onClick={dismissSetup} className="bridge-button-primary"><Check size={14} /> {copy.finish}</button>
            )}
          </footer>
        </section>
      </div>
    </>,
    document.body,
  );
}
