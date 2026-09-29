import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Cable, Pause, Play, Settings2 } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { useHandoffBridgeStatus } from '../hooks/useHandoffBridgeStatus';
import { hasHandoffBridgeApi, hasHandoffBridgeStatusSnapshot, retryHandoffBridgeStatusSync, startHandoffBridgeStatusSync } from '../utils/handoffBridgeStore';
import { openBridgePopover, openBridgeSetup } from '../utils/handoffBridgeUiStore';
import { deriveBridgeHealth } from '../utils/handoffBridgeView';
import { BRIDGE_COPY, BRIDGE_UI_COPY, ipcErrorMessage } from '../utils/handoffBridgeCopy';

function bridgeApi() {
  try { return globalThis.window?.electronAPI || null; } catch { return null; }
}
function safeResult(result) {
  try {
    if (!result || typeof result !== 'object') return { success: true };
    if (result.success === false) return { success: false, code: typeof result.code === 'string' ? result.code : 'INTERNAL' };
    return { success: true };
  } catch {
    return { success: false, code: 'INTERNAL' };
  }
}
function invoke(api, method, payload) {
  try {
    const fn = api?.[method];
    // A status method can exist while a stale or incomplete preload lacks an
    // action method. That is a control-surface problem, not an authoritative
    // verdict that this is an unavailable build.
    if (typeof fn !== 'function') return Promise.resolve({ success: false, code: 'UNAVAILABLE' });
    return Promise.resolve(payload === undefined ? fn.call(api) : fn.call(api, payload)).then(safeResult, () => ({ success: false, code: 'INTERNAL' }));
  } catch {
    return Promise.resolve({ success: false, code: 'INTERNAL' });
  }
}

function unavailableCopy(reason) {
  return reason === 'e2e'
    ? BRIDGE_COPY.e2eUnavailable
    : reason === 'env-disabled'
      ? BRIDGE_UI_COPY.envDisabled
      : BRIDGE_UI_COPY.unavailable;
}

export function HandoffBridgeSetup({ onOpenPanel }) {
  const status = useHandoffBridgeStatus();
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const mountedRef = useRef(true);
  const apiPresent = hasHandoffBridgeApi();

  useEffect(() => startHandoffBridgeStatusSync(), []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => {
      if (mountedRef.current) setNotice('');
    }, 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const call = useCallback(async (method, payload) => {
    const result = await invoke(bridgeApi(), method, payload);
    if (mountedRef.current) {
      setNotice(result?.success === false ? ipcErrorMessage(result.code) : BRIDGE_UI_COPY.saved);
    }
    return result;
  }, []);

  const handleOpenPanel = useCallback(() => {
    if (typeof onOpenPanel === 'function') onOpenPanel();
    openBridgePopover();
  }, [onOpenPanel]);

  const health = deriveBridgeHealth(status, 0);
  const checking = apiPresent && !hasHandoffBridgeStatusSnapshot();
  const unavailable = !checking && !status.availability.ok;
  const controlsDisabled = checking || unavailable;
  const canToggleServing = status.enabled && (status.paused || status.serving === 'live');

  if (!apiPresent) return null;

  const patchScope = (key, value) => {
    void call('handoffBridgeSaveConfig', {
      // The store merges this one field atomically. Sending the whole scope
      // from a render snapshot can overwrite a preceding checkbox change
      // while the status update is still in flight.
      patch: { scope: { [key]: value } },
    });
  };

  const dialog = confirm === 'revoke' ? (
    <ConfirmDialog
      title={BRIDGE_UI_COPY.confirmRevokeTitle}
      message={BRIDGE_UI_COPY.confirmRevokeMessage}
      confirmLabel={BRIDGE_UI_COPY.confirmRevoke}
      cancelLabel={BRIDGE_UI_COPY.cancel}
      onConfirm={() => {
        setConfirm(null);
        void call('handoffBridgeRevokeAll');
      }}
      onCancel={() => setConfirm(null)}
    />
  ) : null;
  return (
    <>
      <section
        className="mt-6 min-w-0 border-t border-white/10 pt-5"
        aria-labelledby="chatgpt-bridge-settings"
      >
        <div className="mb-3 flex min-w-0 items-center gap-2">
          <Cable size={15} className="shrink-0 text-sky-400" />
          <h3 id="chatgpt-bridge-settings" className="min-w-0 text-sm font-semibold text-white/85">
            {BRIDGE_UI_COPY.settingsHeading}
          </h3>
        </div>
        <div
          role="group"
          aria-label={BRIDGE_UI_COPY.settingsGroup}
          className="min-w-0 space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-3"
        >
          <label className="flex min-w-0 items-start justify-between gap-3 text-xs text-white/75">
            <span className="min-w-0">{BRIDGE_UI_COPY.enabledLabel}</span>
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={status.enabled}
              disabled={controlsDisabled}
              onChange={event => {
                void call('handoffBridgeSetEnabled', { enabled: event.target.checked });
              }}
            />
          </label>
          {checking && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="break-words text-[11px] text-white/50">{BRIDGE_UI_COPY.checkingAvailability}</p>
              <button type="button" onClick={retryHandoffBridgeStatusSync} className="bridge-button-secondary text-[11px]">
                {BRIDGE_UI_COPY.retryAvailability}
              </button>
            </div>
          )}
          {unavailable && (
            <p className="break-words text-[11px] text-amber-300">
              {unavailableCopy(status.availability.reason)}
            </p>
          )}
          {!checking && <>
            <p className="break-words text-[11px] text-white/50">{health.headline}: {health.detail}</p>
            <p className="break-words text-[11px] text-white/45">
              {status.power.keepAwake ? BRIDGE_COPY.keepAwakeOn : BRIDGE_COPY.keepAwakeOff}
            </p>
          </>}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => openBridgeSetup(status.enabled ? 2 : 1)}
              className="bridge-button-secondary"
            >
              <Settings2 size={13} /> {status.enabled ? BRIDGE_UI_COPY.manage : BRIDGE_UI_COPY.setUp}
            </button>
            <button
              type="button"
              disabled={controlsDisabled || !status.enabled}
              onClick={handleOpenPanel}
              className="bridge-button-secondary"
            >
              {BRIDGE_UI_COPY.openPanel}
            </button>
            {status.enabled && (
              <button
                type="button"
                disabled={controlsDisabled || !canToggleServing}
                onClick={() => void call(status.paused ? 'handoffBridgeResume' : 'handoffBridgePause')}
                className="bridge-button-secondary"
              >
                {status.paused ? <Play size={13} /> : <Pause size={13} />}
                {status.paused ? BRIDGE_UI_COPY.resume : BRIDGE_UI_COPY.pause}
              </button>
            )}
          </div>
          <label className="flex min-w-0 items-start gap-2 text-[11px] text-white/65">
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={status.config.scope.applications}
              disabled={controlsDisabled}
              onChange={event => patchScope('applications', event.target.checked)}
            />
            <span className="min-w-0">{BRIDGE_UI_COPY.applications}</span>
          </label>
          <label className="flex min-w-0 items-start gap-2 text-[11px] text-white/65">
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={status.config.scope.scoring}
              disabled={controlsDisabled}
              onChange={event => patchScope('scoring', event.target.checked)}
            />
            <span className="min-w-0">{BRIDGE_UI_COPY.scoringSetting}</span>
          </label>
          <label className="flex min-w-0 items-start gap-2 text-[11px] text-white/65">
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={status.config.scope.marketplace}
              disabled={controlsDisabled}
              onChange={event => patchScope('marketplace', event.target.checked)}
            />
            <span className="min-w-0">{BRIDGE_UI_COPY.marketplaceSetting}</span>
          </label>
          <label className="flex min-w-0 items-start gap-2 text-[11px] text-white/65">
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={status.autoStart}
              disabled={controlsDisabled}
              onChange={event => void call('handoffBridgeSaveConfig', { patch: { autoStart: event.target.checked } })}
            />
            <span className="min-w-0">{BRIDGE_UI_COPY.autoStart}</span>
          </label>
          <label className="flex min-w-0 items-start gap-2 text-[11px] text-white/65">
            <input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={status.autoRelease}
              disabled={controlsDisabled}
              onChange={event => void call('handoffBridgeSaveConfig', { patch: { autoRelease: event.target.checked }})}
            />
            <span className="min-w-0">{BRIDGE_UI_COPY.autoRelease}</span>
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-white/10 pt-1">
            <span className="text-[11px] text-white/35">{BRIDGE_UI_COPY.dangerZone}</span>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setConfirm('revoke')}
              className="bridge-button-danger"
            >
              {BRIDGE_UI_COPY.confirmRevoke}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void call('handoffBridgeForgetSetup')}
              className="bridge-button-danger"
            >
              {BRIDGE_UI_COPY.forget}
            </button>
          </div>
          {notice && <p role="status" className="break-words text-[11px] text-white/60">{notice}</p>}
        </div>
      </section>
      {dialog}
    </>
  );
}
