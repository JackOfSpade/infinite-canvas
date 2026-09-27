import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { updateModalCount } from './modalStack';
import { useHandoffBridgeStatus } from '../hooks/useHandoffBridgeStatus';
import {
  closeBridgeSetup,
  getBridgeUiState,
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

function invoke(api, method, payload) {
  const fn = api?.[method];
  if (typeof fn !== 'function') return Promise.resolve({ success: false, code: 'UNAVAILABLE' });
  try {
    return Promise.resolve(payload === undefined ? fn.call(api) : fn.call(api, payload));
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
  const ui = useSyncExternalStore(subscribeBridgeUi, getBridgeUiState, getBridgeUiState);
  const [notice, setNotice] = useState('');
  const [pendingAddress, setPendingAddress] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [enabling, setEnabling] = useState(false);
  const [enableRequestSequence, setEnableRequestSequence] = useState(null);
  const [enableError, setEnableError] = useState(null);
  const hostnameRef = useRef(null);
  const pluginNameRef = useRef(null);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const mountedRef = useRef(true);
  const copy = BRIDGE_SETUP_COPY;
  const visible = Boolean(ui.setup) && status.availability.ok;
  const requestedStep = ui.setup?.step || 1;
  const { seq: statusSequence } = status;
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
  const enablePending = enabling
    && !status.enabled
    && statusSequence <= (enableRequestSequence ?? statusSequence);
  const visibleEnableError = enableError?.sequence >= statusSequence ? enableError.message : '';
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

  useEffect(() => {
    if (!visible) return undefined;
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, [visible]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      if (event.key === 'Escape' && !pendingAddress) {
        event.preventDefault();
        closeBridgeSetup();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingAddress, visible]);

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
    const result = await invoke(globalThis.window?.electronAPI, method, payload);
    if (mountedRef.current) {
      setNotice(result?.success === false ? ipcErrorMessage(result.code) : BRIDGE_UI_COPY.saved);
    }
    return result;
  }, []);

  const saveAddress = useCallback(async () => {
    const hostname = hostnameRef.current?.value || '';
    const pluginName = pluginNameRef.current?.value || '';
    if (!isValidHostname(hostname) || !isValidPluginName(pluginName)) {
      setNotice(BRIDGE_SETUP_COPY.invalid);
      return;
    }
    const patch = { hostname, pluginName };
    const result = await call('handoffBridgeSaveConfig', { patch });
    if (result?.success === false && result.code === 'LINK_WOULD_BREAK' && mountedRef.current) {
      setPendingAddress(patch);
    }
  }, [call]);

  const enableBridge = useCallback(async () => {
    const awaitingMain = enabling
      && !status.enabled
      && statusSequence <= (enableRequestSequence ?? statusSequence);
    if (awaitingMain || status.enabled || !tunnelPrerequisitesSaved) return;
    setEnableRequestSequence(statusSequence);
    setEnabling(true);
    setEnableError(null);
    setNotice('');
    const result = await invoke(globalThis.window?.electronAPI, 'handoffBridgeSetEnabled', { enabled: true });
    if (!mountedRef.current) return;
    if (result?.success === false) {
      setEnabling(false);
      setEnableError({ message: ipcErrorMessage(result.code), sequence: statusSequence });
      return;
    }
  }, [enableRequestSequence, enabling, status.enabled, statusSequence, tunnelPrerequisitesSaved]);

  const openPlugins = useCallback(async () => {
    const result = await openExternalUrl('https://chatgpt.com/plugins', {
      dispatcher: globalThis.window?.electronAPI?.openExternal,
      fallback: globalThis.window?.open,
    });
    if (!result.ok && mountedRef.current) setNotice(BRIDGE_UI_COPY.externalLinkFailure);
  }, []);

  const showTunnelLog = useCallback(async () => {
    const result = await invoke(globalThis.window?.electronAPI, 'handoffBridgeGetTunnelLog');
    if (!mountedRef.current) return;
    if (result?.success === false) {
      setNotice(ipcErrorMessage(result.code));
      return;
    }
    setLogLines(Array.isArray(result?.lines)
      ? result.lines.map(sanitizeTunnelLogLine).filter(Boolean).slice(0, 20)
      : []);
  }, []);

  const copyServerUrl = useCallback(async () => {
    try {
      const url = status.config.mcpUrl;
      if (!url || typeof navigator?.clipboard?.writeText !== 'function') throw new Error('unavailable');
      await navigator.clipboard.writeText(url);
      if (mountedRef.current) setNotice(BRIDGE_UI_COPY.copied);
    } catch {
      if (mountedRef.current) setNotice(ipcErrorMessage('CLIPBOARD_FAILED'));
    }
  }, [status.config.mcpUrl]);

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
        <button type="button" className="bridge-button-secondary" onClick={() => void call('handoffBridgeChooseBinary')}>{copy.chooseBinary}</button>
        <button type="button" className="bridge-button-secondary" onClick={() => void call('handoffBridgeApproveBinary')}>{copy.approveBinary}</button>
        <button type="button" className="bridge-button-secondary" disabled={!status.setup.binaryApproved} onClick={() => void call('handoffBridgeChooseCredentials')}>{copy.chooseCredentials}</button>
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
        <button type="button" className="bridge-button-secondary" disabled={!tunnelReady} onClick={() => void call('handoffBridgeOpenPairing')}>{copy.openPairing}</button>
        <button type="button" className="bridge-button-secondary" onClick={openPlugins}>{copy.openChatGpt}</button>
        <button type="button" className="bridge-button-secondary" disabled={!status.config.mcpUrl} onClick={() => void copyServerUrl()}>{copy.copyServerUrl}</button>
        <button type="button" className="bridge-button-secondary" disabled={!status.link.pairing.open} onClick={() => void call('handoffBridgeCancelPairing')}>{copy.cancelPairing}</button>
      </div>
      <ul className="space-y-1 text-[11px]">{copy.progressItems.map((item, index) => <CheckRow key={item} complete={Boolean(status.link.progress[LINK_PROGRESS_KEYS[index]])}>{item}</CheckRow>)}</ul>
      <ol className="list-decimal space-y-1 pl-5 text-white/55">{copy.pluginSteps.map(item => <li key={item}>{item}</li>)}</ol>
      <code className="block break-all rounded bg-black/30 p-2 text-[11px] text-sky-200">{status.config.mcpUrl || copy.serverUnavailable}</code>
      <p className="text-[11px] text-white/45">{copy.earlyBlock}</p>
      <p className="text-[11px] text-white/45">{copy.reconnect}</p>
    </div>
  );
  const firstChat = (
    <div className="space-y-3">
      <p>{copy.firstChat}</p>
      <button type="button" disabled={!canStartChat} className="bridge-button-primary" onClick={() => void call('handoffBridgeNewChat')}>{BRIDGE_UI_COPY.startChat}</button>
      {!canStartChat && <p className="text-[11px] text-amber-200">{linkReady ? copy.bridgeMustBeReady : copy.completeLinkFirst}</p>}
    </div>
  );
  const body = step === 1
    ? <><p>{copy.overview}</p><p className="text-white/50">{copy.requirements}</p></>
    : step === 2 ? tunnel
      : step === 3 ? plugin
        : firstChat;
  const addressConfirm = pendingAddress ? (
    <ConfirmDialog
      title={BRIDGE_UI_COPY.confirmAddressTitle}
      message={BRIDGE_UI_COPY.confirmAddressMessage}
      confirmLabel={BRIDGE_UI_COPY.confirmAddress}
      cancelLabel={BRIDGE_UI_COPY.keepAddress}
      onConfirm={() => {
        const patch = pendingAddress;
        setPendingAddress(null);
        void call('handoffBridgeSaveConfig', { patch, confirmBreak: true });
      }}
      onCancel={() => setPendingAddress(null)}
    />
  ) : null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
        onMouseDown={event => {
          if (!pendingAddress && event.target === event.currentTarget) closeBridgeSetup();
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
            <button type="button" onClick={closeBridgeSetup} aria-label={copy.close} className="bridge-icon-button"><X size={18} /></button>
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
              <button type="button" onClick={closeBridgeSetup} className="bridge-button-primary"><Check size={14} /> {copy.finish}</button>
            )}
          </footer>
        </section>
      </div>
      {addressConfirm}
    </>,
    document.body,
  );
}
