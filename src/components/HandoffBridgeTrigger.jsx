import React, { useEffect, useSyncExternalStore } from 'react';
import { Cable } from 'lucide-react';
import { useHandoffBridgeStatus } from '../hooks/useHandoffBridgeStatus';
import { startHandoffBridgeStatusSync } from '../utils/handoffBridgeStore';
import { getBridgeUiState, subscribeBridgeUi, toggleBridgePopover } from '../utils/handoffBridgeUiStore';
import { deriveBridgeHealth } from '../utils/handoffBridgeView';
import { BRIDGE_UI_COPY } from '../utils/handoffBridgeCopy';

const toneClass = { off: 'text-slate-400', setup: 'text-sky-400', working: 'text-violet-400', ok: 'text-emerald-400', attention: 'text-amber-400', error: 'text-red-400', nudge: 'text-sky-400' };

export function HandoffBridgeTrigger() {
  const status = useHandoffBridgeStatus();
  const ui = useSyncExternalStore(subscribeBridgeUi, getBridgeUiState, getBridgeUiState);
  useEffect(() => startHandoffBridgeStatusSync(), []);
  const health = deriveBridgeHealth(status, 0);
  if (!status.availability.ok || !status.enabled) return null;
  return <button type="button" onClick={toggleBridgePopover} aria-label={BRIDGE_UI_COPY.triggerLabel(health.headline)} aria-expanded={ui.popoverOpen} className={`relative p-2.5 rounded-lg transition-all hover:bg-white/5 ${toneClass[health.tone] || 'text-white/50'}`} title={health.headline}><Cable size={16} />{health.badge > 0 && <span className="absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-[9px] leading-4 text-white">{health.badge > 9 ? '9+' : health.badge}</span>}</button>;
}
